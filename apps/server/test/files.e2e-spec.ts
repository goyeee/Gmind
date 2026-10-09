import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTemplateDoc, docFromState, docToState, ROOT_NODE_ID } from '@gmind/core';
import { createTestApp } from './support/app-test';
import { EventEntity } from '../src/events/event.entity';

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
    // 空白模板仅含 root：可达活跃口径（countAliveReachable，root 不计）下 nodeCount=0
    // ——与保存/协同持久化路径统一（M2 终审修复轮收口，旧 countNodes 口径为 1）
    expect(created.body.nodeCount).toBe(0);
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

  // 空白新建的中心节点文本裁定（需求方 2026-10-09）：root=「中心主题」而非文件标题，
  // meta.title 仍为文件标题——文件标题与中心节点文本解耦。
  it('空白新建的文档中心节点文本为「中心主题」，meta.title 仍为文件标题', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800006666' });
    const token = await tokenFor(user.id);
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '我的新图' });
    expect(created.status).toBe(201);
    const detail = await request(app.getHttpServer())
      .get(`/api/files/${created.body.id as string}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    const doc = docFromState(new Uint8Array(Buffer.from(String(detail.body.docState), 'base64')));
    expect(String(doc.getMap('nodes').get(ROOT_NODE_ID)?.get('text'))).toBe('中心主题');
    expect(doc.getMap('meta').get('title')).toBe('我的新图');
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

  // ---------- doc_create 埋点（M5 Task 4，PRD 6.4：创建入口 blank/import/seed/copy） ----------

  it('埋点：新建文件落 doc_create 行，entry 按入口区分（blank/import/copy/seed）', async () => {
    const eventsRepo = app.get(DataSource).getRepository(EventEntity);
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const files = app.get((await import('../src/files/files.service')).FilesService);
    const user = await users.create({ method: 'phone', phone: '13800005555' });
    const token = await tokenFor(user.id);

    /** 该文件是否恰好有一条 doc_create 行且 payload.entry 匹配。 */
    const docCreateEntry = async (fileId: string, entry: string): Promise<void> => {
      const rows = await eventsRepo.find({ where: { type: 'doc_create', fileId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(user.id);
      expect(JSON.parse(rows[0].payload ?? '{}')).toEqual({ entry });
    };

    // 空白新建（无 docState）→ blank
    const blank = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '空白新建' });
    expect(blank.status).toBe(201);
    await docCreateEntry(blank.body.id as string, 'blank');

    // 携带 docState（XMind 导入端到端同路径）→ import
    const imported = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '导入新建',
        docState: Buffer.from(docToState(createTemplateDoc({ title: '导入新建', children: [{ text: '节点' }] }))).toString('base64'),
      });
    expect(imported.status).toBe(201);
    await docCreateEntry(imported.body.id as string, 'import');

    // 复制 → copy（新文件行，非 createForUser 直调）
    const copied = await request(app.getHttpServer())
      .post(`/api/files/${imported.body.id}/copy`)
      .set('Authorization', `Bearer ${token}`);
    expect(copied.status).toBe(201);
    await docCreateEntry(copied.body.id as string, 'copy');

    // 注册种子文件（createSeedFiles 直调路径）→ 每个种子一行 seed
    const seeded = await users.create({ method: 'phone', phone: '13800005556' });
    await files.createSeedFiles(seeded.id);
    const seedRows = await eventsRepo.find({ where: { type: 'doc_create', userId: seeded.id } });
    expect(seedRows).toHaveLength(3);
    expect(seedRows.every((r) => JSON.parse(r.payload ?? '{}').entry === 'seed')).toBe(true);
  });
});
