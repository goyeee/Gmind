import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp } from './support/app-test';
import { TEST_CODE, createAccount, loginToken, uniqueEmail } from './support/auth-test';
import { UserEntity } from '../src/users/user.entity';

/**
 * 认证域 E2E（2026-11-12 账号体系重做：邮箱注册制，全量重写）。
 *
 * 端点与语义（binding，错误文案两段式逐字钉死）：
 * - POST /api/auth/email-code {scene, email} → 204；register 已注册 409 /
 *   password_reset 未注册 404 / 60s 重发 429；dev/test 码恒 TEST_CODE（= DEV_MAIL_CODE 默认）。
 * - POST /api/auth/register {email, code, password, nickname} → 200 LoginResponse
 *   {token, expiresAt, user}；码错 400（评审裁定统一 400）；邮箱被占 409（前置 409 +
 *   uk_users_email 兜底 409 两条路都钉）；注册即种 3 个示例文件（FR-ACC-001）。
 * - POST /api/auth/login {account, password, rememberMe?} → 200；账号不存在/密码错误/
 *   停用均 401（文案两段式）；expiresAt：缺省 ≈now+7d、rememberMe:true ≈now+30d（±60s）。
 * - POST /api/auth/password-reset {email, code, newPassword} → 204，成功后该用户全部
 *   旧 token 失效（Review Focus #4）；新密码可登录。
 * - POST /api/auth/logout → 200，原 token 失效。
 * - admin 建号（无密码）账号密码登录 → 401（钉住无密码账号死路，引导走忘记密码设密）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ME = '/api/users/me';

describe('认证域（邮箱注册制）：register / login / email-code / password-reset / logout', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    app = await createTestApp();
    // 空库首号 = super_admin（createByEmail 按 count 判定）：本文件后续 admin 建号用例用
    const admin = await createAccount(app, { nickname: '管理员甲' });
    adminToken = admin.token;
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- 注册 -----------------------------------------------------------------

  it('注册成功：200 LoginResponse 形状（token/expiresAt/user）且种 3 个示例文件（FR-ACC-001）', async () => {
    const email = uniqueEmail();
    const issue = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(issue.status).toBe(204);

    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, code: TEST_CODE, password: 'pass123456', nickname: '注册甲' });
    expect(res.status).toBe(200);
    const body = res.body as { token: string; expiresAt: number; user: { id: string; nickname: string; avatarUrl: string | null } };
    expect(body.token).toBeTruthy();
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.user.id).toBeTruthy();
    expect(body.user.nickname).toBe('注册甲');
    expect(body.user.avatarUrl).toBeNull();

    const list = await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${body.token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(3);
    expect(list.body.map((f: { title: string }) => f.title)).toContain('欢迎使用 Gmind');
  });

  it('验证码错误 → 400「验证码错误或已过期，请重新获取后再试」（评审裁定：统一 400）', async () => {
    const email = uniqueEmail();
    const issue = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(issue.status).toBe(204);

    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, code: '999999', password: 'pass123456', nickname: '错码乙' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('验证码错误或已过期，请重新获取后再试');
  });

  it('重复邮箱：注册侧 uk 兜底 409「该邮箱已注册，请直接登录」', async () => {
    // 先取码、再被 admin 抢注（无密码形态），随后持有效码注册 → 并发窗口唯一键兜底 409
    const email = uniqueEmail();
    const issue = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(issue.status).toBe(204);
    const grabbed = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, nickname: '抢注丙' });
    expect(grabbed.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, code: TEST_CODE, password: 'pass123456', nickname: '后来丁' });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('该邮箱已注册，请直接登录');
  });

  // ---- 登录 -----------------------------------------------------------------

  it('登录成功：200 且同账号二次登录命中同一 user.id', async () => {
    const { email } = await createAccount(app, { nickname: '登录戊' });
    const r1 = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'pass123456' });
    expect(r1.status).toBe(200);
    const r2 = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'pass123456' });
    expect(r2.status).toBe(200);
    expect(r2.body.user.id).toBe(r1.body.user.id);
    expect(r2.body.token).toBeTruthy();
  });

  it('账号不存在 → 401「账号不存在，请先注册」', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: uniqueEmail(), password: 'pass123456' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('账号不存在，请先注册');
  });

  it('密码错误 → 401「密码错误，请重新输入或找回密码」', async () => {
    const { email } = await createAccount(app);
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'wrong-pass-9' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('密码错误，请重新输入或找回密码');
  });

  it('已停用账号（密码正确）→ 401「账号已被停用，请联系管理员」', async () => {
    const acct = await createAccount(app);
    const ds = app.get(DataSource);
    await ds.getRepository(UserEntity).update(acct.id, { status: 'disabled' });

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: acct.email, password: 'pass123456' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('账号已被停用，请联系管理员');
  });

  it('rememberMe：缺省 expiresAt≈now+7d；true 时 ≈now+30d（±60s 容差）', async () => {
    const { email } = await createAccount(app);
    const def = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'pass123456' });
    expect(def.status).toBe(200);
    expect(Math.abs((def.body.expiresAt as number) - (Date.now() + 7 * DAY_MS))).toBeLessThanOrEqual(60_000);

    const long = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'pass123456', rememberMe: true });
    expect(long.status).toBe(200);
    expect(Math.abs((long.body.expiresAt as number) - (Date.now() + 30 * DAY_MS))).toBeLessThanOrEqual(60_000);
  });

  // ---- 邮箱验证码 ------------------------------------------------------------

  it('email-code：register 已注册 → 409「该邮箱已注册，请直接登录或换用其他邮箱」', async () => {
    const { email } = await createAccount(app);
    const res = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('该邮箱已注册，请直接登录或换用其他邮箱');
  });

  it('email-code：password_reset 未注册 → 404「该邮箱尚未注册，请确认后重试或先注册」', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'password_reset', email: uniqueEmail() });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('该邮箱尚未注册，请确认后重试或先注册');
  });

  it('email-code：60s 内重发 → 429「验证码发送过于频繁，请 60 秒后再试」', async () => {
    const email = uniqueEmail();
    const first = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(first.status).toBe(204);
    const again = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'register', email });
    expect(again.status).toBe(429);
    expect(again.body.message).toBe('验证码发送过于频繁，请 60 秒后再试');
  });

  // ---- 忘记密码重置 ----------------------------------------------------------

  it('password-reset 成功 → 204 且旧 token 全部 401、新密码可登录旧密码失效（Review Focus #4）', async () => {
    const acct = await createAccount(app, { password: 'oldpass11' });
    const secondToken = await loginToken(app, acct.email, 'oldpass11'); // 旧密码可重复登录 → 两张活跃会话

    const issue = await request(app.getHttpServer())
      .post('/api/auth/email-code')
      .send({ scene: 'password_reset', email: acct.email });
    expect(issue.status).toBe(204);
    const reset = await request(app.getHttpServer())
      .post('/api/auth/password-reset')
      .send({ email: acct.email, code: TEST_CODE, newPassword: 'newpass789' });
    expect(reset.status).toBe(204);

    // 全部旧会话（注册即登录的 + 二次登录的）一并失效
    for (const old of [acct.token, secondToken]) {
      const me = await request(app.getHttpServer()).get(ME).set('Authorization', `Bearer ${old}`);
      expect(me.status).toBe(401);
      expect(me.body.message).toBe('未登录或会话已过期');
    }

    const byNew = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: acct.email, password: 'newpass789' });
    expect(byNew.status).toBe(200);
    expect(byNew.body.user.id).toBe(acct.id);
    const byOld = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: acct.email, password: 'oldpass11' });
    expect(byOld.status).toBe(401);
  });

  it('admin 建号（无密码）账号密码登录 → 401「密码错误，请重新输入或找回密码」（无密码死路钉死）', async () => {
    const email = uniqueEmail();
    const created = await request(app.getHttpServer())
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email, nickname: '无密码同事' });
    expect(created.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ account: email, password: 'pass123456' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('密码错误，请重新输入或找回密码');
  });

  // ---- 登出 -----------------------------------------------------------------

  it('logout 后原 token 失效', async () => {
    const acct = await createAccount(app);
    const out = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${acct.token}`);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ ok: true });

    const after = await request(app.getHttpServer()).get(ME).set('Authorization', `Bearer ${acct.token}`);
    expect(after.status).toBe(401);
    expect(after.body.message).toBe('未登录或会话已过期');
  });
});
