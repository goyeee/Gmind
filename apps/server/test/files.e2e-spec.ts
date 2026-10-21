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
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:16379/1'));
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

  // ── 一键拉取站内用户（2026-10-11 需求方裁定：成员面板 picker 数据源 + 直接添加）──
  describe('站内用户拉取（invitable-users + collaborators POST）', () => {
    it('owner 可查目录（排除 owner/既有协作者、q 模糊搜索、分页）；非 owner 404', async () => {
      const users = app.get((await import('../src/users/users.service')).UsersService);
      const filesSvc = app.get((await import('../src/files/files.service')).FilesService);
      const owner = await users.create({ method: 'phone', phone: '13811110001' });
      const collab = await users.create({ method: 'phone', phone: '13811110002' });
      const other = await users.create({ method: 'phone', phone: '13811110003' });
      const token = await tokenFor(owner.id);
      const created = await request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '拉取目录测试' });
      const fileId = created.body.id as string;
      // collab 先加成协作者（验证目录排除既有协作者）
      await filesSvc.addCollaborators(owner.id, fileId, [collab.id]);

      const list = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users`)
        .set('Authorization', `Bearer ${token}`);
      expect(list.status).toBe(200);
      const ids = (list.body.items as Array<{ userId: string }>).map((i) => i.userId);
      expect(ids).not.toContain(owner.id); // 排除 owner
      expect(ids).not.toContain(collab.id); // 排除既有协作者
      expect(ids).toContain(other.id); // 其他活跃用户在列
      expect(list.body.total).toBeGreaterThan(0);
      expect(list.body.page).toBe(1);
      expect(list.body.size).toBe(20);

      // q 模糊搜索（手机号片段）
      const searched = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users?q=13811110003`)
        .set('Authorization', `Bearer ${token}`);
      expect(searched.status).toBe(200);
      expect((searched.body.items as Array<{ userId: string }>).map((i) => i.userId)).toEqual([other.id]);

      // 分页：size=1 多页
      const p1 = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users?size=1&page=1`)
        .set('Authorization', `Bearer ${token}`);
      const p2 = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users?size=1&page=2`)
        .set('Authorization', `Bearer ${token}`);
      expect(p1.body.items).toHaveLength(1);
      expect(p2.body.items).toHaveLength(1);
      expect(p1.body.items[0].userId).not.toBe(p2.body.items[0].userId);

      // 非 owner（协作者/路人）一律 404（不泄露文件存在性）
      const collabToken = await tokenFor(collab.id);
      const denied = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users`)
        .set('Authorization', `Bearer ${collabToken}`);
      expect(denied.status).toBe(404);
    });

    it('一键拉取直接加成 editor 协作者（幂等：重拉/owner 自身/无效 id 计 skipped）；非 owner 404', async () => {
      const users = app.get((await import('../src/users/users.service')).UsersService);
      const owner = await users.create({ method: 'phone', phone: '13822220001' });
      const a = await users.create({ method: 'phone', phone: '13822220002' });
      const b = await users.create({ method: 'phone', phone: '13822220003' });
      const token = await tokenFor(owner.id);
      const created = await request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '一键拉取测试' });
      const fileId = created.body.id as string;

      // 拉取 a + b + owner 自身 + 不存在的 id
      const pulled = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/collaborators`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userIds: [a.id, b.id, owner.id, '01NOTEXIST01NOTEXIST01NOT'] });
      expect(pulled.status).toBe(201);
      expect(pulled.body).toEqual({ added: 2, skipped: 2 });

      // 幂等重拉：全部 skipped
      const again = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/collaborators`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userIds: [a.id, b.id] });
      expect(again.body).toEqual({ added: 0, skipped: 2 });

      // 协作者列表可见（role=editor）
      const collabs = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/collaborators`)
        .set('Authorization', `Bearer ${token}`);
      const byId = new Map(
        (collabs.body as Array<{ userId: string; role: string }>).map((c) => [c.userId, c.role]),
      );
      expect(byId.get(a.id)).toBe('editor');
      expect(byId.get(b.id)).toBe('editor');

      // 拉取后目录排除新协作者
      const dir = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/invitable-users`)
        .set('Authorization', `Bearer ${token}`);
      const dirIds = (dir.body.items as Array<{ userId: string }>).map((i) => i.userId);
      expect(dirIds).not.toContain(a.id);

      // 非 owner 拉取 → 404；空数组 → 400
      const otherToken = await tokenFor(a.id);
      const denied = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/collaborators`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ userIds: [b.id] });
      expect(denied.status).toBe(404);
      const bad = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/collaborators`)
        .set('Authorization', `Bearer ${token}`)
        .send({ userIds: [] });
      expect(bad.status).toBe(400);
    });
  });

  // ── 真实缩略图（2026-10-21 需求方裁定真实内容快照）：POST 写 / GET 读 ──
  describe('真实缩略图（/api/files/:id/thumbnail）', () => {
    it('写读闭环：无快照 404 → POST 存 → GET 读回同 SVG（image/svg+xml）；写不翻 updatedAt；越权/非法体拦', async () => {
      const users = app.get((await import('../src/users/users.service')).UsersService);
      const owner = await users.create({ method: 'phone', phone: '13833330001' });
      const outsider = await users.create({ method: 'phone', phone: '13833330002' });
      const token = await tokenFor(owner.id);
      const outsiderToken = await tokenFor(outsider.id);
      const created = await request(app.getHttpServer())
        .post('/api/files')
        .set('Authorization', `Bearer ${token}`)
        .send({ title: '缩略图测试' });
      const fileId = created.body.id as string;

      // 无快照 → 404（卡片回退装饰图）
      const none = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${token}`);
      expect(none.status).toBe(404);

      // 非法体：非 <svg 开头 → 400
      const badSvg = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${token}`)
        .send({ svg: 'not-an-svg' });
      expect(badSvg.status).toBe(400);

      // 越权：outsider 写/读 → 404（不泄露存在性）
      const deniedWrite = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${outsiderToken}`)
        .send({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
      expect(deniedWrite.status).toBe(404);
      const deniedRead = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${outsiderToken}`);
      expect(deniedRead.status).toBe(404);

      // 写入 → 读回
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect width="100" height="50" fill="#fff"/><text x="50" y="25">根节点</text></svg>';
      const before = await request(app.getHttpServer())
        .get('/api/files')
        .set('Authorization', `Bearer ${token}`);
      const updatedAtBefore = (before.body as Array<{ id: string; updatedAt: string }>).find((f) => f.id === fileId)?.updatedAt;
      const posted = await request(app.getHttpServer())
        .post(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${token}`)
        .send({ svg });
      expect(posted.status).toBe(200);
      expect(posted.body).toEqual({ ok: true });

      const got = await request(app.getHttpServer())
        .get(`/api/files/${fileId}/thumbnail`)
        .set('Authorization', `Bearer ${token}`);
      expect(got.status).toBe(200);
      expect(got.headers['content-type']).toContain('image/svg+xml');
      // superagent 对 image/* 不填 res.text，body 为 Buffer
      expect(Buffer.isBuffer(got.body) ? got.body.toString() : got.text).toBe(svg);

      // 写缩略图不翻 updated_at（saveLoop baseUpdatedAt 写序守卫不被派生物挤掉）
      const after = await request(app.getHttpServer())
        .get('/api/files')
        .set('Authorization', `Bearer ${token}`);
      const updatedAtAfter = (after.body as Array<{ id: string; updatedAt: string }>).find((f) => f.id === fileId)?.updatedAt;
      expect(updatedAtAfter).toBe(updatedAtBefore);
    });
  });
});
