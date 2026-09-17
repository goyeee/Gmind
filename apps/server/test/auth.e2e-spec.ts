import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

const phone = () => '139' + String(Date.now()).slice(-8);

describe('POST /api/auth/login', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('手机验证码首登即注册，返回 token 且种 3 个示例文件（FR-ACC-001）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.nickname).toContain('用户');

    const list = await request(app.getHttpServer())
      .get('/api/files')
      .set('Authorization', `Bearer ${res.body.token}`);
    expect(list.body).toHaveLength(3);
  });

  it('同一手机号二次登录为同一账号', async () => {
    const p = phone();
    const r1 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });
    const r2 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });
    expect(r2.body.user.id).toBe(r1.body.user.id);
  });

  it('验证码错误返回 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '999999' });
    expect(res.status).toBe(401);
  });

  it('手机号格式非法返回 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: 'not-a-phone', code: '123456' });
    expect(res.status).toBe(400);
  });

  it('邮箱验证码登录 / 密码注册后密码登录', async () => {
    const email = `u${Date.now()}@test.dev`;
    const withPwd = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'code', code: '123456', password: 'secret66' });
    expect(withPwd.status).toBe(200);

    const byPwd = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'password', password: 'secret66' });
    expect(byPwd.status).toBe(200);
    expect(byPwd.body.user.id).toBe(withPwd.body.user.id);

    const wrong = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email, mode: 'password', password: 'wrong66' });
    expect(wrong.status).toBe(401);
  });

  it('微信 mock 登录，默认 openid 稳定复用同一账号', async () => {
    const r1 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'wechat' });
    const r2 = await request(app.getHttpServer()).post('/api/auth/login').send({ method: 'wechat' });
    expect(r1.status).toBe(200);
    expect(r2.body.user.id).toBe(r1.body.user.id);
  });

  it('第 6 台设备登录时第 1 个会话被踢（FR-ACC-002）', async () => {
    const p = phone();
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ method: 'phone', phone: p, code: '123456' });
      tokens.push(r.body.token as string);
    }
    const first = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens[0]}`);
    expect(first.status).toBe(401);
    const latest = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${tokens[5]}`);
    expect(latest.status).toBe(200);
    expect(latest.body.id).toBeTruthy();
  });

  it('logout 后原 token 失效', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'phone', phone: phone(), code: '123456' });
    const me = await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    const after = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(after.status).toBe(401);
  });
});
