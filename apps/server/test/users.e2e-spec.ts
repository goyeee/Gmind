import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { compare, hash } from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ulid } from 'ulid';
import { createTestApp } from './support/app-test';
import { TEST_CODE, createAccount, loginToken, uniqueEmail } from './support/auth-test';
import { MailService } from '../src/mail/mail.service';
import { UserEntity } from '../src/users/user.entity';
import { DigestService } from '../src/jobs/digest.service';

/**
 * 账号设置端点 E2E — FR-ACC-002 收口 + FR-CMT-006 通知偏好收口（2026-11-12 账号
 * 体系重做后改口径：改密恒旧密码核身，换绑拆分 me/email 与 me/phone 两端点）。
 *
 * 端点：POST /api/users/me/password（改密）、POST /api/users/me/email（换绑邮箱）、
 * POST /api/users/me/phone（换绑手机号）、GET/PATCH /api/users/me/notify-prefs（偏好）。
 *
 * 语义（binding，2026-11-12 重做）：
 * - 改密：邮箱注册制人人有密码，恒 currentPassword 核身（无密码/验证码分支已删）；
 *   强度 = 6~64 位（PASSWORD_LENGTH_MESSAGE 单点口径）；成功 204，不吊销其他会话；
 * - 换绑邮箱：currentPassword 核身 → email_bind 场景验证码 → 占用（他人）409 → 落列；
 * - 换绑手机号：仅 currentPassword 核身（手机号无验证码通道）→ 占用 409 → 落列；
 * - 偏好：{emailOptOut: ('mention'|'reply'|'permission')[]} 全量替换；非法成员 400；
 * - digest：分组后按用户 opt-out 过滤对应 type 的行（过滤行同样回写 emailed_at 收敛，
 *   语义同无邮箱用户）；system 行（FR-FIL-010 回收站提醒）恒发不受开关控制。
 */

const email = (): string => `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;

type Method = 'get' | 'post' | 'patch';
const authed = (app: INestApplication, token: string, method: Method, url: string) =>
  request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

describe('账号设置端点（FR-ACC-002 收口）：改密 / 换绑 / 通知偏好', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let main: { id: string; email: string; token: string }; // 主角：偏好 / 换绑手机号占用
  let other: { id: string; email: string; token: string }; // 换绑邮箱+手机号主角 / 格式负例
  let changer: { id: string; email: string; token: string }; // 改密主角（改密不改 main 的默认密码）

  const me = async (token: string): Promise<Record<string, unknown>> => {
    const res = await authed(app, token, 'get', '/api/users/me');
    expect(res.status).toBe(200);
    return res.body as Record<string, unknown>;
  };
  const userRow = async (id: string): Promise<UserEntity> => {
    const row = await dataSource.getRepository(UserEntity).findOneBy({ id });
    expect(row).toBeTruthy();
    return row as UserEntity;
  };
  /** 给指定邮箱发 email_bind 场景验证码（换绑邮箱前置，无存在性闸）。 */
  const issueBindCode = async (target: string): Promise<void> => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'email_bind', email: target });
    expect(res.status).toBe(204);
  };

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    main = await createAccount(app, { nickname: '设置甲' });
    other = await createAccount(app, { nickname: '设置乙' });
    changer = await createAccount(app, { nickname: '设置丙' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('未登录访问四个端点 → 401', async () => {
    expect((await request(app.getHttpServer()).post('/api/users/me/password').send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/users/me/email').send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/users/me/phone').send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/users/me/notify-prefs')).status).toBe(401);
  });

  // ---- 通知偏好 ------------------------------------------------------------

  it('通知偏好：GET 缺省 {emailOptOut: []}；PATCH 全量替换 → GET round-trip', async () => {
    const first = await authed(app, main.token, 'get', '/api/users/me/notify-prefs');
    expect(first.status).toBe(200);
    // 2026-10-28 P1：返回扩 notifyEnabled/digestEnabled 两开关（缺省 true）——objectContaining 容忍键集演进
    expect(first.body).toEqual(expect.objectContaining({ emailOptOut: [], notifyEnabled: true, digestEnabled: true }));

    const patch = await authed(app, main.token, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: ['mention', 'permission'],
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual(expect.objectContaining({ emailOptOut: ['mention', 'permission'] }));

    const again = await authed(app, main.token, 'get', '/api/users/me/notify-prefs');
    expect(again.body).toEqual(expect.objectContaining({ emailOptOut: ['mention', 'permission'] }));

    // 全量替换：再次 PATCH 可清空
    const clear = await authed(app, main.token, 'patch', '/api/users/me/notify-prefs').send({ emailOptOut: [] });
    expect(clear.status).toBe(200);
    expect(clear.body).toEqual(expect.objectContaining({ emailOptOut: [] }));
  });

  it('通知偏好：非法成员（system 等）/ 非数组 / 缺字段 → 400', async () => {
    const badMember = await authed(app, main.token, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: ['system'],
    });
    expect(badMember.status).toBe(400); // system（FR-FIL-010 回收站提醒）不可关闭
    const badShape = await authed(app, main.token, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: 'mention',
    });
    expect(badShape.status).toBe(400);
    const missing = await authed(app, main.token, 'patch', '/api/users/me/notify-prefs').send({});
    expect(missing.status).toBe(400);
  });

  // ---- 改密（2026-11-12 重做：恒旧密码核身，验证码分支已删） --------------------

  it('改密：旧密码错误 → 400「当前密码错误，请重新输入」且列未变', async () => {
    const res = await authed(app, changer.token, 'post', '/api/users/me/password').send({
      currentPassword: 'wrong-pass-0',
      newPassword: 'brandnew99',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('当前密码错误，请重新输入');

    const row = await userRow(changer.id);
    expect(await compare('pass123456', row.passwordHash as string)).toBe(true); // 原密码未动
  });

  it('改密：旧密码正确 → 204 且 hash 落库（bcrypt 比对）、新密码可登录、旧密码失效', async () => {
    const res = await authed(app, changer.token, 'post', '/api/users/me/password').send({
      currentPassword: 'pass123456',
      newPassword: 'brandnew99',
    });
    expect(res.status).toBe(204);

    const row = await userRow(changer.id);
    expect(row.passwordHash).toBeTruthy();
    expect(await compare('brandnew99', row.passwordHash as string)).toBe(true);

    const meAfter = await me(changer.token);
    expect(meAfter.hasPassword).toBe(true);

    const byNew = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: changer.email, password: 'brandnew99' });
    expect(byNew.status).toBe(200);
    expect((byNew.body as { user: { id: string } }).user.id).toBe(changer.id);

    const byOld = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: changer.email, password: 'pass123456' });
    expect(byOld.status).toBe(401);
    expect(byOld.body.message).toBe('密码错误，请重新输入或找回密码');
  });

  it('改密：新密码不足 6 位 / 缺当前密码 → 400（schema 单点口径 6~64）', async () => {
    const tooShort = await authed(app, other.token, 'post', '/api/users/me/password').send({
      currentPassword: 'pass123456',
      newPassword: 'abc12', // 5 位
    });
    expect(tooShort.status).toBe(400);
    expect(tooShort.body.message).toBe('密码长度需为 6~64 位，请调整后重试');

    const noCurrent = await authed(app, other.token, 'post', '/api/users/me/password').send({
      newPassword: 'longenough88',
    });
    expect(noCurrent.status).toBe(400);
  });

  // ---- 换绑邮箱（POST /users/me/email）---------------------------------------

  it('换绑邮箱：当前密码 + email_bind 验证码 → 204 且 email 列更新（me 回显）', async () => {
    const newEmail = uniqueEmail();
    await issueBindCode(newEmail);
    const res = await authed(app, other.token, 'post', '/api/users/me/email').send({
      currentPassword: 'pass123456',
      email: newEmail,
      code: TEST_CODE,
    });
    expect(res.status).toBe(204);

    const row = await userRow(other.id);
    expect(row.email).toBe(newEmail);
    const meAfter = await me(other.token);
    expect(meAfter.email).toBe(newEmail);
    // 换绑后旧密码仍可登录（改密/换绑不吊销会话，新邮箱可登录同一账号）
    const byNewEmail = await loginToken(app, newEmail);
    expect(byNewEmail).toBeTruthy();
  });

  it('换绑邮箱：目标已被占用 → 409「该邮箱已绑定其他账号，请换用其他邮箱」', async () => {
    // 占用目标 = main 的注册邮箱；email_bind 无存在性闸，可对已注册邮箱发码
    await issueBindCode(main.email);
    const res = await authed(app, other.token, 'post', '/api/users/me/email').send({
      currentPassword: 'pass123456',
      email: main.email,
      code: TEST_CODE,
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('该邮箱已绑定其他账号，请换用其他邮箱');
  });

  it('换绑邮箱：验证码错误 / 新邮箱格式非法 → 400', async () => {
    const badCode = await authed(app, other.token, 'post', '/api/users/me/email').send({
      currentPassword: 'pass123456',
      email: uniqueEmail(),
      code: '999999',
    });
    expect(badCode.status).toBe(400);
    expect(badCode.body.message).toBe('验证码错误或已过期，请重新获取后再试');

    const badEmail = await authed(app, other.token, 'post', '/api/users/me/email').send({
      currentPassword: 'pass123456',
      email: 'not-an-email',
      code: TEST_CODE,
    });
    expect(badEmail.status).toBe(400);
    expect(badEmail.body.message).toBe('邮箱格式不正确，请检查后重新输入');
  });

  it('换绑邮箱：当前密码错误（顺序契约：密码先核身）→ 400「当前密码错误，请重新输入」', async () => {
    const target = uniqueEmail();
    await issueBindCode(target);
    const res = await authed(app, other.token, 'post', '/api/users/me/email').send({
      currentPassword: 'wrong-pass-0',
      email: target,
      code: TEST_CODE,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('当前密码错误，请重新输入');
  });

  // ---- 换绑手机号（POST /users/me/phone）--------------------------------------

  it('换绑手机号：仅当前密码核身（无验证码通道）→ 204 且 phone 列更新', async () => {
    const newPhone = '136' + String(Math.floor(10000000 + Math.random() * 89999999));
    const res = await authed(app, other.token, 'post', '/api/users/me/phone').send({
      currentPassword: 'pass123456',
      phone: newPhone,
    });
    expect(res.status).toBe(204);

    const row = await userRow(other.id);
    expect(row.phone).toBe(newPhone);
    const meAfter = await me(other.token);
    expect(meAfter.phone).toBe(newPhone);
  });

  it('换绑手机号：目标已被占用 → 409「该手机号已绑定其他账号，请换用其他手机号」', async () => {
    // other 已在上例绑定手机号；main 换绑到同一号码 → 409
    const occupied = (await me(other.token)).phone as string;
    const res = await authed(app, main.token, 'post', '/api/users/me/phone').send({
      currentPassword: 'pass123456',
      phone: occupied,
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('该手机号已绑定其他账号，请换用其他手机号');
  });

  it('换绑手机号：当前密码错误 / 格式非法 → 400', async () => {
    const badPassword = await authed(app, main.token, 'post', '/api/users/me/phone').send({
      currentPassword: 'wrong-pass-0',
      phone: '137' + String(Math.floor(10000000 + Math.random() * 89999999)),
    });
    expect(badPassword.status).toBe(400);
    expect(badPassword.body.message).toBe('当前密码错误，请重新输入');

    const badFormat = await authed(app, main.token, 'post', '/api/users/me/phone').send({
      currentPassword: 'pass123456',
      phone: 'not-a-phone',
    });
    expect(badFormat.status).toBe(400);
    expect(badFormat.body.message).toBe('手机号格式不正确，请检查后重试');
  });
});

/**
 * digest 通知偏好过滤 E2E（FR-CMT-006 / FR-FIL-010）。
 * 数据装置口径同 notify.e2e-spec 的摘要组：裸 INSERT notifications 行
 * （显式 created_at 回拨 16 分钟），sendMail spy 捕获投递。
 */
describe('digest 通知偏好过滤（FR-CMT-006）：opt-out 行不收信且回写收敛，system 恒发', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let digest: DigestService;
  let optUser: UserEntity; // 退订 mention
  let normalUser: UserEntity; // 未退订
  const calls: Array<{ to: string; subject: string; body: string }> = [];

  const MIN = 60 * 1000;
  const back16min = (): Date => new Date(Date.now() - 16 * MIN);

  const insertNotif = async (
    userId: string,
    type: 'mention' | 'reply' | 'permission' | 'system',
    payload: Record<string, unknown> | null,
    createdAt: Date,
  ): Promise<void> => {
    await dataSource.query(
      'INSERT INTO notifications (id, user_id, type, payload, read_at, emailed_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)',
      [ulid(), userId, type, payload === null ? null : JSON.stringify(payload), createdAt],
    );
  };

  const rowsOf = async (userId: string): Promise<Array<{ type: string; emailed_at: unknown }>> => {
    return (await dataSource.query('SELECT type, emailed_at FROM notifications WHERE user_id = ?', [userId])) as Array<{
      type: string;
      emailed_at: unknown;
    }>;
  };

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);
    digest = app.get(DigestService);
    vi.spyOn(app.get(MailService), 'sendMail').mockImplementation(async (to, subject, body) => {
      calls.push({ to, subject, body });
      return true;
    });

    const userRepo = dataSource.getRepository(UserEntity);
    // 裸建行须带 passwordHash（重做后登录恒密码核身）：偏好 PATCH 走真实端点需先登录
    optUser = await userRepo.save(
      userRepo.create({ email: email(), nickname: '退订甲', passwordHash: await hash('pass123456', 10) }),
    );
    normalUser = await userRepo.save(
      userRepo.create({ email: email(), nickname: '普通乙', passwordHash: await hash('pass123456', 10) }),
    );

    // 经端点设置偏好（贯通 prefs 落列链路）：退订 mention
    const token = await loginToken(app, optUser.email as string);
    const patch = await authed(app, token, 'patch', '/api/users/me/notify-prefs').send({ emailOptOut: ['mention'] });
    expect(patch.status).toBe(200);
  });

  afterAll(async () => {
    await app.close();
  });

  it('opt-out mention：mention 行不收信但回写 emailed_at；reply/system 行照常入摘要（system 恒发 FR-FIL-010）', async () => {
    const fileId = ulid();
    const back = back16min();
    await insertNotif(optUser.id, 'mention', { fileId, title: '协同文档', commenterId: normalUser.id, commenterName: '普通乙', content: '被提及但不想要邮件' }, back);
    await insertNotif(optUser.id, 'reply', { fileId, title: '协同文档', commenterId: normalUser.id, commenterName: '普通乙', content: '回复仍要邮件' }, back);
    await insertNotif(optUser.id, 'system', { fileId, title: '协同文档', action: 'trash-reminder' }, back);

    const res = await digest.runDigest(new Date());
    expect(res).toEqual({ emailed: 1, users: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe(optUser.email);
    // mention 被过滤：subject 只含 reply + system 两条
    expect(calls[0]?.subject).toBe('Gmind：协同文档 有 2 条新通知');
    expect(calls[0]?.body).not.toContain('[提及]');
    expect(calls[0]?.body).toContain('[回复]');
    expect(calls[0]?.body).toContain('[系统]');

    // 三行全部回写 emailed_at（被过滤行同样回写——防永久滞留，收敛裁定）
    const rows = await rowsOf(optUser.id);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.emailed_at).not.toBeNull();

    // 下一轮：全部收敛，被过滤行不会滞留重扫
    const second = await digest.runDigest(new Date());
    expect(second).toEqual({ emailed: 0, users: 0 });
    expect(calls).toHaveLength(1);
  });

  it('未 opt-out 用户 mention 照常收信', async () => {
    await insertNotif(
      normalUser.id,
      'mention',
      { fileId: ulid(), title: '普通文档', commenterId: optUser.id, commenterName: '退订甲', content: '正常提醒' },
      back16min(),
    );
    const res = await digest.runDigest(new Date());
    expect(res).toEqual({ emailed: 1, users: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.to).toBe(normalUser.email);
    expect(calls[1]?.body).toContain('[提及]');
  });
});
