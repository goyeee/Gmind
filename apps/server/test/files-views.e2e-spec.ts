import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTemplateDoc, docFromState, docToState } from '@gmind/core';
import { createTestApp } from './support/app-test';
import { FileEntity } from '../src/files/file.entity';

/**
 * 文件域四视图 + 删除 + last_modifier e2e（M3a Task 4，FR-FIL-001）+ 文件复制与星标
 * （M3a Task 6，FR-FIL-003/004）。
 *
 * 种子：三个用户（owner「文件甲」/ collaborator「协作者乙」/ outsider「路人丙」）；
 * 文件矩阵覆盖 mine / shared / starred / recent 四视图与删除流。
 * Task 4 铺垫的 file_stars 行经 DataSource 直插（彼时星标端点未建）；
 * Task 6 起走正式端点（folders 仍无实体，直插行）。
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

/**
 * 文件复制与星标（M3a Task 6，FR-FIL-003/004）。
 *
 * 独立 describe：createTestApp 每次清库重建，与本文件第一组（四视图） fixtures 解耦。
 * 复制：POST /api/files/:id/copy（canAccess）→ 新 id/「原名-副本」/内容一致/源不变/
 * 配额联动；星标：PUT/DELETE /api/files/:id/star（幂等 200）+ starred 视图访问权过滤
 * （T4 review carry-in：协作者被移除后星标条目不再外泄）。
 */
describe('文件复制与星标（FR-FIL-003/004）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ownerId: string;
  let ownerToken: string;
  let collaboratorId: string;
  let collaboratorToken: string;
  let outsiderToken: string;
  let fSource: string; // 复制流主角：有内容、挂文件夹
  let fShared: string; // owner 拥有，共享给 collaborator（协作者复制/加星主角）
  let folderId: string;

  const tokenFor = async (userId: string): Promise<string> => {
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

  /** base64 docState → 排序后的节点文本集（root + 子树；内容一致性对比用）。 */
  const textsOf = (stateB64: string): string[] => {
    const doc = docFromState(new Uint8Array(Buffer.from(stateB64, 'base64')));
    const texts: string[] = [];
    doc.getMap('nodes').forEach((node) => texts.push(String(node.get('text'))));
    return texts.sort();
  };

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const owner = await users.create({ method: 'phone', phone: '13800080001', nickname: '复制甲' });
    const collaborator = await users.create({ method: 'phone', phone: '13800080002', nickname: '复制乙' });
    const outsider = await users.create({ method: 'phone', phone: '13800080003', nickname: '复制丙' });
    ownerId = owner.id;
    collaboratorId = collaborator.id;
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const create = async (token: string, title: string): Promise<string> => {
      const res = await authed(token, 'post', '/api/files').send({ title });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    fSource = await create(ownerToken, '复制源');
    fShared = await create(ownerToken, '共享给乙');

    // 授权协作者（dev-e2e 编排端点，与上方同款）
    const granted = await authed(ownerToken, 'post', '/api/dev-e2e/grant-collaborator')
      .send({ fileId: fShared, phone: '13800080002' });
    expect(granted.status).toBe(201);

    // fSource 写入内容并挂文件夹（PUT 走正式写路径，last_modifier=owner）
    const state = Buffer.from(
      docToState(createTemplateDoc({ title: '复制源', children: [{ text: '节点一' }, { text: '节点二' }] })),
    ).toString('base64');
    const put = await authed(ownerToken, 'put', `/api/files/${fSource}/doc-state`)
      .send({ docState: state, lastEditorUserId: ownerId });
    expect(put.status).toBe(200);
    folderId = ulid();
    await ds.query(
      'INSERT INTO folders (id, owner_user_id, name, depth, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(3), NOW(3))',
      [folderId, ownerId, '复制夹'],
    );
    await ds.query('UPDATE files SET folder_id = ? WHERE id = ?', [folderId, fSource]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('复制成功：新 id/标题-副本/节点文本集一致/源不变（标题与 updated_at 均未动）', async () => {
    const sourceBefore = await authed(ownerToken, 'get', `/api/files/${fSource}`);
    expect(sourceBefore.status).toBe(200);

    const res = await authed(ownerToken, 'post', `/api/files/${fSource}/copy`);
    expect(res.status).toBe(201);
    // FileListItem 契约（与 POST /api/files 一致），docState 绝不外泄
    expect(Object.keys(res.body).sort()).toEqual(['id', 'lastOpenedAt', 'nodeCount', 'structure', 'title', 'updatedAt']);
    expect(res.body.id).not.toBe(fSource);
    expect(res.body.title).toBe('复制源-副本');
    expect(res.body.nodeCount).toBe(sourceBefore.body.nodeCount);
    expect(res.body.docState).toBeUndefined();

    // 内容一致：docState decode 对比节点文本集
    const copy = await authed(ownerToken, 'get', `/api/files/${res.body.id}`);
    expect(copy.status).toBe(200);
    expect(textsOf(copy.body.docState)).toEqual(textsOf(sourceBefore.body.docState));

    // 源不变：标题/updatedAt/内容原样
    const sourceAfter = await authed(ownerToken, 'get', `/api/files/${fSource}`);
    expect(sourceAfter.body.title).toBe('复制源');
    expect(sourceAfter.body.updatedAt).toBe(sourceBefore.body.updatedAt);
    expect(textsOf(sourceAfter.body.docState)).toEqual(textsOf(sourceBefore.body.docState));
  });

  it('副本落点：同文件夹 + last_modifier=调用人（mine 视图详细投影验证）', async () => {
    const res = await authed(ownerToken, 'post', `/api/files/${fSource}/copy`);
    expect(res.status).toBe(201);
    const mine = await list(ownerToken);
    const copy = mine.body.find((f: { id: string }) => f.id === res.body.id);
    expect(copy).toBeDefined();
    expect(copy.folderId).toBe(folderId);
    expect(copy.folderName).toBe('复制夹');
    expect(copy.ownerUserId).toBe(ownerId);
    expect(copy.lastModifierName).toBe('复制甲');
  });

  it('标题超 255 截断：254 字标题复制后总长恰 255 且以「-副本」结尾', async () => {
    const longTitle = '长'.repeat(254);
    const created = await authed(ownerToken, 'post', '/api/files').send({ title: longTitle });
    expect(created.status).toBe(201);
    const res = await authed(ownerToken, 'post', `/api/files/${created.body.id}/copy`);
    expect(res.status).toBe(201);
    expect(res.body.title).toHaveLength(255);
    expect(res.body.title.endsWith('-副本')).toBe(true);
  });

  it('配额联动：owner 已满 100 个时复制 → 403「文件数量已达上限（100 个）」（FR-ACC-003）', async () => {
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const full = await users.create({ method: 'phone', phone: '13800080004', nickname: '满额丁' });
    const fullToken = await tokenFor(full.id);
    const filesRepo = ds.getRepository(FileEntity);
    for (let i = 0; i < 99; i += 1) {
      const f = filesRepo.create();
      f.ownerUserId = full.id;
      f.title = `full-${i}`;
      await filesRepo.save(f);
    }
    const source = await authed(fullToken, 'post', '/api/files').send({ title: '满额的源' });
    expect(source.status).toBe(201); // 第 100 个

    const res = await authed(fullToken, 'post', `/api/files/${source.body.id}/copy`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('文件数量已达上限（100 个）');
  });

  it('权限：协作者可复制（副本 owner=协作者）；无权与不存在一律 404 不泄露', async () => {
    const collabCopy = await authed(collaboratorToken, 'post', `/api/files/${fShared}/copy`);
    expect(collabCopy.status).toBe(201);
    const mine = await list(collaboratorToken);
    const copy = mine.body.find((f: { id: string }) => f.id === collabCopy.body.id);
    expect(copy).toBeDefined();
    expect(copy.ownerUserId).toBe(collaboratorId);
    expect(copy.title).toBe('共享给乙-副本');

    expect((await authed(outsiderToken, 'post', `/api/files/${fShared}/copy`)).status).toBe(404);
    expect((await authed(ownerToken, 'post', `/api/files/${ulid()}/copy`)).status).toBe(404);
  });

  it('加星：PUT → 200 {starred:true}，starred 视图含且按加星时间倒序；无权 404', async () => {
    const star1 = await authed(ownerToken, 'put', `/api/files/${fShared}/star`);
    expect(star1.status).toBe(200);
    expect(star1.body).toEqual({ starred: true });
    await new Promise((r) => setTimeout(r, 20)); // 星时间错开（datetime(3)）
    const star2 = await authed(ownerToken, 'put', `/api/files/${fSource}/star`);
    expect(star2.status).toBe(200);

    const starred = await list(ownerToken, 'starred');
    expect(starred.status).toBe(200);
    expect(starred.body.map((f: { id: string }) => f.id)).toEqual([fSource, fShared]); // 星时间 DESC
    for (const item of starred.body) expect(item.starred).toBe(true);

    // 无权用户加星 → 404 不泄露（canAccess 口径）
    expect((await authed(outsiderToken, 'put', `/api/files/${fShared}/star`)).status).toBe(404);
  });

  it('重复加星幂等（仅一行）；取消移出视图且幂等（无行也 200）；他人星标互不影响', async () => {
    const again = await authed(ownerToken, 'put', `/api/files/${fShared}/star`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ starred: true });
    const rows = await ds.query('SELECT COUNT(*) AS n FROM file_stars WHERE file_id = ? AND user_id = ?', [fShared, ownerId]);
    expect(Number(rows[0].n)).toBe(1);

    // 他人星标独立：乙加星自己的视角，甲的视图不受影响（甲仍含 fShared）
    const bStar = await authed(collaboratorToken, 'put', `/api/files/${fShared}/star`);
    expect(bStar.status).toBe(200);
    expect((await list(collaboratorToken, 'starred')).body.map((f: { id: string }) => f.id)).toEqual([fShared]);
    expect((await list(ownerToken, 'starred')).body.map((f: { id: string }) => f.id)).toContain(fShared);

    // 乙取消 → 移出乙的 starred 视图；甲的星标不受影响
    const unstar = await authed(collaboratorToken, 'delete', `/api/files/${fShared}/star`);
    expect(unstar.status).toBe(200);
    expect(unstar.body).toEqual({ starred: false });
    expect((await list(collaboratorToken, 'starred')).body).toHaveLength(0);
    expect((await list(ownerToken, 'starred')).body.map((f: { id: string }) => f.id)).toContain(fShared);

    // 取消幂等：无星行再删仍 200
    const unstarAgain = await authed(collaboratorToken, 'delete', `/api/files/${fShared}/star`);
    expect(unstarAgain.status).toBe(200);
    expect(unstarAgain.body).toEqual({ starred: false });
  });

  it('starred 访问权过滤（carry-in）：协作者被移除后，其星标条目不再出现（title 不外泄）', async () => {
    // 乙已加星 fShared（前一用例取消过，重新加）
    const star = await authed(collaboratorToken, 'put', `/api/files/${fShared}/star`);
    expect(star.status).toBe(200);
    let starred = await list(collaboratorToken, 'starred');
    expect(starred.body.map((f: { id: string }) => f.id)).toEqual([fShared]);

    // owner 直接删除协作者行（正式协作管理 API 属后续任务）
    await ds.query('DELETE FROM file_collaborators WHERE file_id = ? AND user_id = ?', [fShared, collaboratorId]);

    starred = await list(collaboratorToken, 'starred');
    expect(starred.body.map((f: { id: string }) => f.id)).not.toContain(fShared);
    expect(starred.body.map((f: { title: string }) => f.title)).not.toContain('共享给乙');
  });
});

/**
 * 标题全局搜索（M3a Task 8，FR-FIL-008）。
 *
 * 独立 describe（createTestApp 每次清库重建）：GET /api/search?q= 的范围=自己+协作的
 * alive 文件；前缀命中排序在前；LIKE 通配符（% _）按字面量匹配；空/缺失 q → 400。
 */
describe('标题全局搜索（FR-FIL-008）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let ownerToken: string;
  let collaboratorToken: string;
  let outsiderToken: string; // 丙的搜索私有：负例主角（他人私有不含）
  let fPrefix: string; // '项目规划书'：q='项目' 的前缀命中（updatedAt 定值较早）
  let fContains: string; // '我的项目规划'：q='项目' 的非前缀命中（updatedAt 定值较晚）

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put' | 'delete';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  const search = (token: string, q?: string): Promise<request.Response> =>
    authed(token, 'get', q === undefined ? '/api/search' : `/api/search?q=${encodeURIComponent(q)}`);

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const owner = await users.create({ method: 'phone', phone: '13800091001', nickname: '搜索甲' });
    const collaborator = await users.create({ method: 'phone', phone: '13800091002', nickname: '搜索乙' });
    const outsider = await users.create({ method: 'phone', phone: '13800091003', nickname: '搜索丙' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const create = async (token: string, title: string): Promise<string> => {
      const res = await authed(token, 'post', '/api/files').send({ title });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    fPrefix = await create(ownerToken, '项目规划书');
    fContains = await create(ownerToken, '我的项目规划');
    const fShared = await create(ownerToken, '搜索共享件');
    await create(collaboratorToken, '乙的搜索私有');
    await create(outsiderToken, '丙的搜索私有');
    await create(ownerToken, '100%完成');
    await create(ownerToken, '进度_草稿');

    // 授权协作者（dev-e2e 编排端点，同上两组 fixtures）
    const granted = await authed(ownerToken, 'post', '/api/dev-e2e/grant-collaborator')
      .send({ fileId: fShared, phone: '13800091002' });
    expect(granted.status).toBe(201);

    // 排序定值：非前缀命中 updatedAt 更晚——若相关度排序失效，updatedAt DESC 会把它排前
    const filesRepo = ds.getRepository(FileEntity);
    await filesRepo.update(fPrefix, { updatedAt: new Date('2026-01-01T00:00:01Z') });
    await filesRepo.update(fContains, { updatedAt: new Date('2026-01-01T00:00:10Z') });
  });

  afterAll(async () => {
    await app.close();
  });

  it('命中自己 + 协作文件；他人私有与不可见文件不含；键集封闭', async () => {
    const res = await search(collaboratorToken, '搜索');
    expect(res.status).toBe(200);
    const ids = res.body.map((f: { id: string }) => f.id);
    expect(ids).toContain(await findIdByTitle('乙的搜索私有')); // 自己的私有文件
    expect(ids).toContain(await findIdByTitle('搜索共享件')); // 协作文件（owner=甲）
    expect(ids).not.toContain(await findIdByTitle('丙的搜索私有')); // 他人私有
    expect(ids).not.toContain(await findIdByTitle('项目规划书')); // 甲的私有不可见

    // 详细投影键集封闭（复用 listByView 的投影契约；prefixHit 仅排序内部用，不外泄）
    expect(Object.keys(res.body[0]).sort()).toEqual([
      'folderId', 'folderName', 'id', 'lastModifierName', 'lastOpenedAt',
      'nodeCount', 'ownerName', 'ownerUserId', 'starred', 'structure', 'title', 'updatedAt',
    ]);
    const sharedItem = res.body.find((f: { title: string }) => f.title === '搜索共享件');
    expect(sharedItem.ownerName).toBe('搜索甲');

    // owner 自己搜：自己的 + 自己拥有的（协作视角反向：乙的私有对甲不可见）
    const selfRes = await search(ownerToken, '搜索');
    const selfIds = selfRes.body.map((f: { title: string }) => f.title);
    expect(selfIds).toContain('搜索共享件');
    expect(selfIds).not.toContain('乙的搜索私有');
  });

  it('前缀命中排序在前，其余按 updatedAt DESC（q 与两段检索口径一致）', async () => {
    const res = await search(ownerToken, '项目');
    expect(res.status).toBe(200);
    expect(res.body.map((f: { id: string }) => f.id)).toEqual([fPrefix, fContains]); // 前缀优先，尽管 updatedAt 更早

    // 无前缀命中时全部落「其余」组：updatedAt DESC（我的项目规划 更新）
    const noPrefix = await search(ownerToken, '规划');
    expect(noPrefix.body.map((f: { id: string }) => f.id)).toEqual([fContains, fPrefix]);
  });

  it('空/缺失/纯空白 q → 400「搜索关键词不能为空」', async () => {
    const missing = await search(ownerToken);
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe('搜索关键词不能为空');
    const empty = await search(ownerToken, '');
    expect(empty.status).toBe(400);
    const blank = await search(ownerToken, '  ');
    expect(blank.status).toBe(400);
  });

  it('LIKE 通配符 % 与 _ 转义：字面量匹配，不发生全量命中', async () => {
    // q='%'：未转义时 pattern '%%%' 会命中全部文件；转义后只命中标题含字面量 % 者
    const pct = await search(ownerToken, '%');
    expect(pct.status).toBe(200);
    expect(pct.body.map((f: { title: string }) => f.title)).toEqual(['100%完成']);

    // q='_'：未转义时 '%_%' 会命中所有非空标题；转义后只命中字面量下划线者
    const under = await search(ownerToken, '_');
    expect(under.body.map((f: { title: string }) => f.title)).toEqual(['进度_草稿']);

    // 反斜杠本身亦按字面量：无标题含 \ → 空
    const bslash = await search(ownerToken, '\\');
    expect(bslash.status).toBe(200);
    expect(bslash.body).toHaveLength(0);
  });

  /** 按标题查文件 id（fixtures 无返回表时的可读性辅助）。 */
  async function findIdByTitle(title: string): Promise<string> {
    const rows = await ds.query('SELECT id FROM files WHERE title = ? AND deleted_at IS NULL', [title]);
    return rows[0].id;
  }
});
