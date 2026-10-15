import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

describe('GET /api/users/me', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('无 token 返回 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/users/me');
    expect(res.status).toBe(401);
  });

  it('伪造 token 返回 401（NFR-SEC-003 越权用例）', async () => {
    const res = await request(app.getHttpServer()).get('/api/users/me').set('Authorization', 'Bearer fake-token');
    expect(res.status).toBe(401);
  });
});

describe('用户头像（2026-10-11 需求方裁定：上传 + 5 预置 SVG 可选）', () => {
  let app: INestApplication;
  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:16379/1'));
    return (await svc.create(userId, false)).token;
  };
  const newUser = async (phone: string): Promise<{ id: string; token: string }> => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone });
    return { id: user.id, token: await tokenFor(user.id) };
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('PATCH me/avatar 预置白名单：/avatars/preset-N.svg（1-5）落库生效，非法路径 400', async () => {
    const u = await newUser('13800010001');
    const ok = await request(app.getHttpServer())
      .patch('/api/users/me/avatar')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ avatarUrl: '/avatars/preset-3.svg' });
    expect(ok.status).toBe(200);
    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${u.token}`);
    expect(me.body.avatarUrl).toBe('/avatars/preset-3.svg');
    // 非法路径：目录穿越 / 未知预置 / 他人 key 形态
    for (const bad of ['/avatars/preset-6.svg', '/avatars/../etc/x.svg', 'https://evil.com/a.png', 'users/other/abc.png']) {
      const res = await request(app.getHttpServer())
        .patch('/api/users/me/avatar')
        .set('Authorization', `Bearer ${u.token}`)
        .send({ avatarUrl: bad });
      expect(res.status).toBe(400);
    }
  });

  it('POST me/avatar 上传 png → avatarUrl=users/{id} 键；GET /api/images/{key} 公开可读且回写 Content-Type', async () => {
    const u = await newUser('13800010002');
    // 最小 PNG 魔数（detectImageExt 只嗅探头 4 字节）
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
    const up = await request(app.getHttpServer())
      .post('/api/users/me/avatar')
      .set('Authorization', `Bearer ${u.token}`)
      .attach('file', png, 'avatar.png');
    expect(up.status).toBe(201);
    expect(String(up.body.avatarUrl)).toMatch(new RegExp(`^users/${u.id}/.+\\.png$`));
    // 公开读取端点（<img> 无 Authorization）：字节回环 + Content-Type
    const img = await request(app.getHttpServer()).get(`/api/images/${up.body.avatarUrl as string}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toContain('image/png');
    expect(img.body.length).toBe(png.length);
    // me 反映新头像
    const me = await request(app.getHttpServer())
      .get('/api/users/me')
      .set('Authorization', `Bearer ${u.token}`);
    expect(me.body.avatarUrl).toBe(up.body.avatarUrl);
  });

  it('collaborators 响应携带 avatar 字段（成员目录数据源）', async () => {
    // 全新手机号一次性建号（create 不查重——同号会建第二行，grant 按号查会命中旧行）
    const u = await newUser('13800010005');
    const patchRes = await request(app.getHttpServer())
      .patch('/api/users/me/avatar')
      .set('Authorization', `Bearer ${u.token}`)
      .send({ avatarUrl: '/avatars/preset-1.svg' });
    expect(patchRes.status).toBe(200);
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const ownerUser = await users.create({ method: 'phone', phone: '13800010006' });
    const token = await tokenFor(ownerUser.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '头像契约' });
    const fileId = created.body.id as string;
    // 授权 u（按手机号编排）为协作者后经 owner 视角看 collaborators
    const grant = await request(app.getHttpServer())
      .post('/api/dev-e2e/grant-collaborator')
      .send({ fileId, phone: '13800010005' });
    expect(grant.status).toBe(201);
    const cols = await request(app.getHttpServer())
      .get(`/api/files/${fileId}/collaborators`)
      .set('Authorization', `Bearer ${token}`);
    expect(cols.status).toBe(200);
    const entry = (cols.body as Array<{ userId: string; avatar?: string }>).find((c) => c.userId === u.id);
    expect(entry?.avatar).toBe('/avatars/preset-1.svg');
  });
});
