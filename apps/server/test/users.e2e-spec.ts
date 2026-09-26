import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { compare } from 'bcryptjs';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ulid } from 'ulid';
import { createTestApp } from './support/app-test';
import { MailService } from '../src/mail/mail.service';
import { UserEntity } from '../src/users/user.entity';
import { DigestService } from '../src/jobs/digest.service';

/**
 * 账号设置端点 E2E — M5 Task 1（FR-ACC-002 收口 + FR-CMT-006 通知偏好收口）。
 *
 * 端点：POST /api/users/me/password（改密）、POST /api/users/me/rebind（换绑）、
 * GET/PATCH /api/users/me/notify-prefs（邮件退订偏好）。
 *
 * 语义（binding）：
 * - 改密：有密码（邮箱注册时设置过）须 currentPassword 验证；无密码（手机号注册）须
 *   code 核身（开发环境固定 123456，与登录通道同语义）；强度 = 8~64 位（PRD 未定义
 *   强度规则，登记：仅约束长度）；成功 204，不吊销其他会话（PRD 未要求，登记）；
 * - 换绑：code 校验 → 新身份格式校验（同登录 zod 口径）→ 占用检查（被占 409
 *   「该手机号/邮箱已绑定其他账号」）→ 改绑落列；204；
 * - 偏好：{emailOptOut: ('mention'|'reply'|'permission')[]} 全量替换；非法成员 400；
 *   存储 = users.notify_prefs JSON（M0 预留列）；GET 对空/坏列返回 {emailOptOut: []}；
 * - digest：分组后按用户 opt-out 过滤对应 type 的行（过滤行同样回写 emailed_at 收敛，
 *   语义同无邮箱用户）；system 行（FR-FIL-010 回收站提醒）恒发不受开关控制。
 */

const phone = (): string => '136' + String(Math.floor(10000000 + Math.random() * 89999999));
const email = (): string => `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.dev`;

type Method = 'get' | 'post' | 'patch';
const authed = (app: INestApplication, token: string, method: Method, url: string) =>
  request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

describe('账号设置端点（FR-ACC-002 收口）：改密 / 换绑 / 通知偏好', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let phoneToken: string; // 无密码（手机号注册）
  let emailToken: string; // 有密码（邮箱注册设置密码）
  let otherToken: string; // 另一手机号用户（换绑占用/格式用例）
  let emailUserEmail: string;

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

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);

    const p1 = phone();
    phoneToken = ((await loginPhone(app, p1)).body as { token: string }).token;
    emailUserEmail = email();
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email: emailUserEmail, mode: 'code', code: '123456', password: 'oldpass66' });
    emailToken = (res.body as { token: string }).token;
    otherToken = ((await loginPhone(app, phone())).body as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('未登录访问三个端点 → 401', async () => {
    expect((await request(app.getHttpServer()).post('/api/users/me/password').send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/users/me/rebind').send({})).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/users/me/notify-prefs')).status).toBe(401);
  });

  // ---- 通知偏好 ------------------------------------------------------------

  it('通知偏好：GET 缺省 {emailOptOut: []}；PATCH 全量替换 → GET round-trip', async () => {
    const first = await authed(app, phoneToken, 'get', '/api/users/me/notify-prefs');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ emailOptOut: [] });

    const patch = await authed(app, phoneToken, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: ['mention', 'permission'],
    });
    expect(patch.status).toBe(200);
    expect(patch.body).toEqual({ emailOptOut: ['mention', 'permission'] });

    const again = await authed(app, phoneToken, 'get', '/api/users/me/notify-prefs');
    expect(again.body).toEqual({ emailOptOut: ['mention', 'permission'] });

    // 全量替换：再次 PATCH 可清空
    const clear = await authed(app, phoneToken, 'patch', '/api/users/me/notify-prefs').send({ emailOptOut: [] });
    expect(clear.status).toBe(200);
    expect(clear.body).toEqual({ emailOptOut: [] });
  });

  it('通知偏好：非法成员（system 等）/ 非数组 / 缺字段 → 400', async () => {
    const badMember = await authed(app, phoneToken, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: ['system'],
    });
    expect(badMember.status).toBe(400); // system（FR-FIL-010 回收站提醒）不可关闭
    const badShape = await authed(app, phoneToken, 'patch', '/api/users/me/notify-prefs').send({
      emailOptOut: 'mention',
    });
    expect(badShape.status).toBe(400);
    const missing = await authed(app, phoneToken, 'patch', '/api/users/me/notify-prefs').send({});
    expect(missing.status).toBe(400);
  });

  // ---- 改密 ----------------------------------------------------------------

  it('改密：无密码（手机号注册）用户凭验证码设置密码 → 204 且列回写（bcrypt 可比对）', async () => {
    const meBefore = await me(phoneToken);
    expect(meBefore.hasPassword).toBe(false);

    const res = await authed(app, phoneToken, 'post', '/api/users/me/password').send({
      newPassword: 'newpass88',
      code: '123456',
    });
    expect(res.status).toBe(204);

    const meId = meBefore.id as string;
    const row = await userRow(meId);
    expect(row.passwordHash).toBeTruthy();
    expect(await compare('newpass88', row.passwordHash as string)).toBe(true);

    const meAfter = await me(phoneToken);
    expect(meAfter.hasPassword).toBe(true);
  });

  it('改密：无密码用户验证码错误 → 400 文案含「验证码」', async () => {
    const res = await authed(app, otherToken, 'post', '/api/users/me/password').send({
      newPassword: 'newpass88',
      code: '999999',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('验证码');
  });

  it('改密：有密码用户旧密码错误 → 400「当前密码不正确」且列未变', async () => {
    const res = await authed(app, emailToken, 'post', '/api/users/me/password').send({
      newPassword: 'brandnew99',
      currentPassword: 'wrong66',
    });
    expect(res.status).toBe(400);
    expect(String(res.body.message)).toContain('当前密码不正确');

    const meBefore = await me(emailToken);
    const row = await userRow(meBefore.id as string);
    expect(await compare('oldpass66', row.passwordHash as string)).toBe(true);
  });

  it('改密：有密码用户旧密码正确 → 204 且新密码可密码登录、旧密码失效', async () => {
    const res = await authed(app, emailToken, 'post', '/api/users/me/password').send({
      newPassword: 'brandnew99',
      currentPassword: 'oldpass66',
    });
    expect(res.status).toBe(204);

    const meBefore = await me(emailToken);
    const row = await userRow(meBefore.id as string);
    expect(await compare('brandnew99', row.passwordHash as string)).toBe(true);

    const byNew = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email: emailUserEmail, mode: 'password', password: 'brandnew99' });
    expect(byNew.status).toBe(200);
    expect((byNew.body as { user: { id: string } }).user.id).toBe(meBefore.id);

    const byOld = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email: emailUserEmail, mode: 'password', password: 'oldpass66' });
    expect(byOld.status).toBe(401);
  });

  it('改密：新密码不足 8 位 → 400（强度 = 8~64 位，PRD 未定义规则已登记）', async () => {
    const res = await authed(app, otherToken, 'post', '/api/users/me/password').send({
      newPassword: 'short12',
      code: '123456',
    });
    expect(res.status).toBe(400);
  });

  // ---- 换绑 ----------------------------------------------------------------

  it('换绑：邮箱换绑成功 → 204 且 email 列更新', async () => {
    const meBefore = await me(otherToken);
    const newEmail = email();
    const res = await authed(app, otherToken, 'post', '/api/users/me/rebind').send({
      channel: 'email',
      newIdentity: newEmail,
      code: '123456',
    });
    expect(res.status).toBe(204);

    const row = await userRow(meBefore.id as string);
    expect(row.email).toBe(newEmail);
    const meAfter = await me(otherToken);
    expect(meAfter.email).toBe(newEmail);
  });

  it('换绑：手机号换绑成功 → 204 且 phone 列更新', async () => {
    const meBefore = await me(emailToken);
    const newPhone = phone();
    const res = await authed(app, emailToken, 'post', '/api/users/me/rebind').send({
      channel: 'phone',
      newIdentity: newPhone,
      code: '123456',
    });
    expect(res.status).toBe(204);

    const row = await userRow(meBefore.id as string);
    expect(row.phone).toBe(newPhone);
  });

  it('换绑：目标已被占用 → 409「该手机号已绑定其他账号」/「该邮箱已绑定其他账号」', async () => {
    // 占用手机号：otherToken 换绑到 phoneToken 用户的手机号（me 可见，稳定取用）
    const mePhone = await me(phoneToken);
    const occupiedPhone = mePhone.phone as string;
    const phoneConflict = await authed(app, otherToken, 'post', '/api/users/me/rebind').send({
      channel: 'phone',
      newIdentity: occupiedPhone,
      code: '123456',
    });
    expect(phoneConflict.status).toBe(409);
    expect(phoneConflict.body.message).toBe('该手机号已绑定其他账号');

    // 占用邮箱：phoneToken 换绑到 emailToken 用户的原邮箱（emailToken 只换绑过手机号）
    const emailConflict = await authed(app, phoneToken, 'post', '/api/users/me/rebind').send({
      channel: 'email',
      newIdentity: emailUserEmail,
      code: '123456',
    });
    expect(emailConflict.status).toBe(409);
    expect(emailConflict.body.message).toBe('该邮箱已绑定其他账号');
  });

  it('换绑：验证码错误 → 400；新身份格式非法（同登录 zod 口径）→ 400', async () => {
    const badCode = await authed(app, otherToken, 'post', '/api/users/me/rebind').send({
      channel: 'phone',
      newIdentity: phone(),
      code: '999999',
    });
    expect(badCode.status).toBe(400);
    expect(String(badCode.body.message)).toContain('验证码');

    const badPhone = await authed(app, otherToken, 'post', '/api/users/me/rebind').send({
      channel: 'phone',
      newIdentity: 'not-a-phone',
      code: '123456',
    });
    expect(badPhone.status).toBe(400);

    const badEmail = await authed(app, otherToken, 'post', '/api/users/me/rebind').send({
      channel: 'email',
      newIdentity: 'not-an-email',
      code: '123456',
    });
    expect(badEmail.status).toBe(400);
  });
});

/** 手机验证码登录（首登即注册），返回响应。 */
const loginPhone = (app: INestApplication, p: string) =>
  request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });

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
    optUser = await userRepo.save(
      userRepo.create({ phone: phone(), email: email(), nickname: '退订甲' }),
    );
    normalUser = await userRepo.save(
      userRepo.create({ phone: phone(), email: email(), nickname: '普通乙' }),
    );

    // 经端点设置偏好（贯通 prefs 落列链路）：退订 mention
    const login = await loginPhone(app, optUser.phone as string);
    const token = (login.body as { token: string }).token;
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
