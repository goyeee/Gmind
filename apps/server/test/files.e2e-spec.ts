import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

describe('files 域', () => {
  let app: INestApplication;
  const tokenFor = async (userId: string): Promise<string> => {
    // 直接通过 SessionService 签发，登录接口在 Task 8 才有
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('createSeedFiles 后列表返回 3 个示例文件（FR-ACC-001）', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800001111' });
    const files = app.get((await import('../src/files/files.service')).FilesService);
    await files.createSeedFiles(user.id);

    const token = await tokenFor(user.id);
    const res = await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    expect(res.body.map((f: { title: string }) => f.title)).toContain('欢迎使用 Gmind');
    expect(res.body[0]).toHaveProperty('nodeCount');
    // 种子模板 org 结构必须与 doc meta 一致地持久化到 files.structure 列
    const orgFile = res.body.find((f: { title: string }) => f.title === '产品需求评审纪要');
    expect(orgFile).toBeDefined();
    expect(orgFile.structure).toBe('org');
  });

  it('POST /api/files 新建并出现在列表首位', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800002222' });
    const token = await tokenFor(user.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '测试新建' });
    expect(created.status).toBe(201);
    expect(created.body.nodeCount).toBe(1);
    // 响应必须符合 FileListItem 契约：docState（Buffer）绝不离开服务端
    expect(created.body.title).toBe('测试新建');
    expect(created.body.docState).toBeUndefined();
    expect(Object.keys(created.body).sort()).toEqual(['id', 'lastOpenedAt', 'nodeCount', 'structure', 'title', 'updatedAt']);

    const list = await request(app.getHttpServer()).get('/api/files').set('Authorization', `Bearer ${token}`);
    expect(list.body[0].title).toBe('测试新建');
  });

  it('标题缺省时默认「未命名脑图」', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800003333' });
    const token = await tokenFor(user.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(created.status).toBe(201);
    expect(created.body.title).toBe('未命名脑图');
  });

  it('title 为空字符串时返回 400（Zod 校验）', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800004444' });
    const token = await tokenFor(user.id);
    const res = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBeTypeOf('string');
  });
});
