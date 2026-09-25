import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTemplateDoc, docToState } from '@gmind/core';
import { createTestApp } from './support/app-test';
import { FileEntity } from '../src/files/file.entity';

/**
 * 文件域四视图 + 删除 + last_modifier e2e（M3a Task 4，FR-FIL-001）。
 *
 * 种子：三个用户（owner「文件甲」/ collaborator「协作者乙」/ outsider「路人丙」）；
 * 文件矩阵覆盖 mine / shared / starred / recent 四视图与删除流。
 * file_stars / folders 无实体（Task 6 才建星标端点），经 DataSource 直插行。
 */
describe('文件四视图 + 删除 + last_modifier（FR-FIL-001）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ownerId: string;
  let ownerToken: string;
  let collaboratorId: string;
  let collaboratorToken: string;
  let outsiderId: string;
  let outsiderToken: string;
  let fMine1: string; // 旧：updatedAt 早、已加星（早）、已打开、挂文件夹
  let fMine2: string; // 新：updatedAt 晚、已加星（晚）、已打开（删除流主角）
  let fShared: string; // owner 拥有，共享给 collaborator
  let fCollab: string; // collaborator 私有（owner 不可见）
  let folderId: string;

  const tokenFor = async (userId: string): Promise<string> => {
    // 直接通过 SessionService 签发（同 file-content.e2e-spec.ts 模式）
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put' | 'delete';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  const list = (token: string, view?: string): Promise<request.Response> =>
    authed(token, 'get', view ? `/api/files?view=${view}` : '/api/files');

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const owner = await users.create({ method: 'phone', phone: '13800070001', nickname: '文件甲' });
    const collaborator = await users.create({ method: 'phone', phone: '13800070002', nickname: '协作者乙' });
    const outsider = await users.create({ method: 'phone', phone: '13800070003', nickname: '路人丙' });
    ownerId = owner.id;
    collaboratorId = collaborator.id;
    outsiderId = outsider.id;
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const create = async (token: string, title: string): Promise<string> => {
      const res = await authed(token, 'post', '/api/files').send({ title });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    fMine1 = await create(ownerToken, '甲的旧文件');
    fMine2 = await create(ownerToken, '甲的新文件');
    fShared = await create(ownerToken, '共享给乙');
    fCollab = await create(collaboratorToken, '乙的私有');

    // 授权协作者（dev-e2e 编排端点，与 storage.e2e-spec.ts 同款）
    const granted = await authed(ownerToken, 'post', '/api/dev-e2e/grant-collaborator')
      .send({ fileId: fShared, phone: '13800070002' });
    expect(granted.status).toBe(201);

    // —— 排序与状态定值（显式列更新，见 files.service markOpened 的定点写口径） ——
    // 文件夹（无实体，直插行）先行：fMine1 的归属随定值更新一次性写入
    // （repo.update 不带 updatedAt 的列会自动回填 CURRENT_TIMESTAMP，二次更新会污染排序定值）
    folderId = ulid();
    await ds.query(
      'INSERT INTO folders (id, owner_user_id, name, depth, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(3), NOW(3))',
      [folderId, ownerId, '项目资料'],
    );
    const filesRepo = ds.getRepository(FileEntity);
    await filesRepo.update(fMine1, {
      updatedAt: new Date('2026-01-01T00:00:05Z'),
      lastOpenedAt: new Date('2026-01-02T00:00:00Z'),
      folderId,
    });
    await filesRepo.update(fMine2, {
      updatedAt: new Date('2026-01-01T00:00:10Z'),
      lastOpenedAt: new Date('2026-01-02T00:00:02Z'),
    });
    // fShared 的 updatedAt 也钉旧值：否则「现在」晚于 1 月定值，会霸占 mine 首位
    await filesRepo.update(fShared, {
      updatedAt: new Date('2026-01-01T00:00:03Z'),
      lastOpenedAt: new Date('2026-01-02T00:00:01Z'),
    });

    // 加星（Task 6 之前无端点，直插 file_stars；fMine1 早、fMine2 晚）
    await ds.query('INSERT INTO file_stars (id, file_id, user_id, created_at) VALUES (?, ?, ?, ?)', [
      ulid(), fMine1, ownerId, new Date('2026-01-03T00:00:00Z'),
    ]);
    await ds.query('INSERT INTO file_stars (id, file_id, user_id, created_at) VALUES (?, ?, ?, ?)', [
      ulid(), fMine2, ownerId, new Date('2026-01-03T00:00:10Z'),
    ]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('mine 视图（默认）：仅本人文件、updatedAt DESC、详细字段齐备且不泄露内部列', async () => {
    const res = await list(ownerToken);
    expect(res.status).toBe(200);
    const titles = res.body.map((f: { title: string }) => f.title);
    expect(titles).toContain('甲的旧文件');
    expect(titles).toContain('甲的新文件');
    expect(titles).toContain('共享给乙');
    expect(titles).not.toContain('乙的私有');

    // updatedAt DESC（定值：新文件在前）
    expect(res.body[0].id).toBe(fMine2);
    expect(res.body[0].updatedAt).toBe('2026-01-01T00:00:10.000Z');

    // 详细投影：键集封闭（docState/deletedAt/deleted_by 等内部列绝不出现）
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'folderId', 'folderName', 'id', 'lastModifierName', 'lastOpenedAt',
      'nodeCount', 'ownerName', 'ownerUserId', 'starred', 'structure', 'title', 'updatedAt',
    ]);
    expect(res.body[0].ownerUserId).toBe(ownerId);
    expect(res.body[0].ownerName).toBe('文件甲');
    expect(res.body[0].lastModifierName).toBeNull(); // 无人编辑过
    expect(res.body[0].starred).toBe(true); // fMine2 已加星
    expect(res.body[0].lastOpenedAt).toBe('2026-01-02T00:00:02.000Z');

    const mine1 = res.body.find((f: { id: string }) => f.id === fMine1);
    expect(mine1.folderId).toBe(folderId); // 文件夹 JOIN
    expect(mine1.folderName).toBe('项目资料');
    expect(mine1.starred).toBe(true);
    const sharedItem = res.body.find((f: { id: string }) => f.id === fShared);
    expect(sharedItem.starred).toBe(false); // starred 是当前用户视角
  });

  it('无效 view → 400（zod 校验）', async () => {
    const res = await list(ownerToken, 'bogus');
    expect(res.status).toBe(400);
    expect(res.body.message).toBeTypeOf('string');
  });

  it('shared 视图：协作者看到被共享文件；不含自己拥有的文件（双向）', async () => {
    const res = await list(collaboratorToken, 'shared');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(fShared);
    expect(res.body[0].ownerUserId).toBe(ownerId);
    expect(res.body[0].ownerName).toBe('文件甲');
    // 自有文件（fCollab）绝不进 shared 视图
    expect(res.body.map((f: { id: string }) => f.id)).not.toContain(fCollab);

    // owner 无「被共享给我」的文件（自有文件不进 shared 视图）
    const selfView = await list(ownerToken, 'shared');
    expect(selfView.status).toBe(200);
    expect(selfView.body).toHaveLength(0);
  });

  it('starred 视图：仅加星存活文件、按加星时间 DESC、owner 视角 starred=true', async () => {
    const res = await list(ownerToken, 'starred');
    expect(res.status).toBe(200);
    expect(res.body.map((f: { id: string }) => f.id)).toEqual([fMine2, fMine1]); // 星时间 DESC
    for (const item of res.body) {
      expect(item.starred).toBe(true);
      expect(item.ownerUserId).toBe(ownerId);
    }
    // 协作者的星标视角独立：乙未加星 → 空
    const collabView = await list(collaboratorToken, 'starred');
    expect(collabView.body).toHaveLength(0);
  });

  it('recent 视图：mine ∪ shared 且 last_opened_at 非空、按最近打开 DESC', async () => {
    const res = await list(ownerToken, 'recent');
    expect(res.status).toBe(200);
    // 打开序：fMine2(00:00:02) > fShared(00:00:01) > fMine1(00:00:00)
    expect(res.body.map((f: { id: string }) => f.id)).toEqual([fMine2, fShared, fMine1]);
    // shared 分支：乙的 recent 只含被共享的 fShared（自有 fCollab 未打开）
    const collabView = await list(collaboratorToken, 'recent');
    expect(collabView.body).toHaveLength(1);
    expect(collabView.body[0].id).toBe(fShared);
  });

  it('recent 视图 50 条上限（FR-FIL-001）', async () => {
    const filesRepo = ds.getRepository(FileEntity);
    for (let i = 0; i < 55; i += 1) {
      const f = filesRepo.create();
      f.ownerUserId = outsiderId;
      f.title = `recent-${i}`;
      f.lastOpenedAt = new Date(Date.UTC(2026, 0, 4, 0, 0, i)); // 秒级递增
      await filesRepo.save(f);
    }
    // 未打开的文件不进 recent（即便 updatedAt 最新）
    const neverOpened = filesRepo.create();
    neverOpened.ownerUserId = outsiderId;
    neverOpened.title = 'recent-no-open';
    await filesRepo.save(neverOpened);

    const res = await list(outsiderToken, 'recent');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(50);
    expect(res.body[0].title).toBe('recent-54'); // 最近打开在前
    const titles = res.body.map((f: { title: string }) => f.title);
    expect(titles).not.toContain('recent-4'); // 第 51 新及更早被截断
    expect(titles).not.toContain('recent-no-open');
  });

  it('last_modifier：PUT 带 lastEditorUserId（=token 用户）→ 列表回显修改人昵称；非本人声称 → 忽略', async () => {
    const state = Buffer.from(docToState(createTemplateDoc({ title: '共享给乙', children: [] }))).toString('base64');
    // 协作者编辑并自报修改人
    const put = await authed(collaboratorToken, 'put', `/api/files/${fShared}/doc-state`)
      .send({ docState: state, lastEditorUserId: collaboratorId });
    expect(put.status).toBe(200);
    let res = await list(ownerToken);
    expect(res.body.find((f: { id: string }) => f.id === fShared).lastModifierName).toBe('协作者乙');

    // 伪称他人修改：值 ≠ token 用户 → 服务端忽略（保留既有修改人）
    const spoof = await authed(collaboratorToken, 'put', `/api/files/${fShared}/doc-state`)
      .send({ docState: state, lastEditorUserId: ownerId });
    expect(spoof.status).toBe(200);
    res = await list(ownerToken);
    expect(res.body.find((f: { id: string }) => f.id === fShared).lastModifierName).toBe('协作者乙');

    // owner 自己编辑 → 修改人回显 owner
    await authed(ownerToken, 'put', `/api/files/${fMine1}/doc-state`)
      .send({ docState: state, lastEditorUserId: ownerId });
    res = await list(ownerToken);
    expect(res.body.find((f: { id: string }) => f.id === fMine1).lastModifierName).toBe('文件甲');
  });

  it('非 owner（含协作者）删除 → 404 不泄露，文件仍存活', async () => {
    const delShared = await authed(collaboratorToken, 'delete', `/api/files/${fShared}`);
    expect(delShared.status).toBe(404);
    const delOutsider = await authed(outsiderToken, 'delete', `/api/files/${fMine1}`);
    expect(delOutsider.status).toBe(404);
    // 均未实际删除
    const res = await list(ownerToken);
    expect(res.body.map((f: { id: string }) => f.id)).toContain(fMine1);
    expect(res.body.map((f: { id: string }) => f.id)).toContain(fShared);
  });

  it('删除流：owner 软删 → 200 {ok:true}，四视图均不可见，GET/再删 404', async () => {
    const del = await authed(ownerToken, 'delete', `/api/files/${fMine2}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    for (const view of ['mine', 'shared', 'starred', 'recent'] as const) {
      const res = await list(ownerToken, view);
      expect(res.body.map((f: { id: string }) => f.id)).not.toContain(fMine2);
    }
    // 共享文件被 owner 删除 → 协作者 shared/recent 视图同步消失
    const delShared = await authed(ownerToken, 'delete', `/api/files/${fShared}`);
    expect(delShared.status).toBe(200);
    const collabShared = await list(collaboratorToken, 'shared');
    expect(collabShared.body).toHaveLength(0);
    const collabRecent = await list(collaboratorToken, 'recent');
    expect(collabRecent.body).toHaveLength(0);

    // 内容端点与重复删除同口径 404（不泄露存在性）
    expect((await authed(ownerToken, 'get', `/api/files/${fMine2}`)).status).toBe(404);
    expect((await authed(collaboratorToken, 'get', `/api/files/${fShared}`)).status).toBe(404);
    expect((await authed(ownerToken, 'delete', `/api/files/${fMine2}`)).status).toBe(404);
  });
});
