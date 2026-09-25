import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createTestApp } from './support/app-test';

/**
 * 文件夹域 e2e（M3a Task 5，FR-FIL-002）：CRUD / 5 级嵌套 / 移动环检测 / 整体入回收站。
 *
 * GET /api/folders 裁定口径：扁平数组（客户端组树），按 depth ASC → name ASC 排序。
 * 删除为整体策略：文件夹软删 + 递归子文件夹软删 + 其下存活文件软删入回收站
 * （deleted_by = 调用者）；跨用户一律 404 不泄露存在性。
 */
describe('文件夹域（FR-FIL-002）', () => {
  let app: INestApplication;
  let ds: DataSource;
  let userId: string;
  let token: string;
  let otherToken: string;

  const tokenFor = async (uid: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(uid, false)).token;
  };

  const authed = (method: 'get' | 'post' | 'patch' | 'delete', url: string, tk = token) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${tk}`);

  const createFolder = async (name: string, parentId?: string): Promise<request.Response> =>
    authed('post', '/api/folders').send(parentId ? { name, parentId } : { name });

  beforeAll(async () => {
    app = await createTestApp();
    ds = app.get(DataSource);
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const user = await users.create({ method: 'phone', phone: '13800050001', nickname: '文件夹甲' });
    const other = await users.create({ method: 'phone', phone: '13800050002', nickname: '文件夹乙' });
    userId = user.id;
    token = await tokenFor(user.id);
    otherToken = await tokenFor(other.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST 根文件夹：201 FolderItem {id,name,parentId:null,depth:1}', async () => {
    const res = await createFolder('工作文档');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: '工作文档', parentId: null, depth: 1 });
    expect(res.body.id).toBeTypeOf('string');
    expect(Object.keys(res.body).sort()).toEqual(['depth', 'id', 'name', 'parentId']);
  });

  it('POST 嵌套文件夹：depth = 父 + 1（2 级）', async () => {
    const parent = await createFolder('父A');
    const child = await createFolder('子B', parent.body.id);
    expect(child.status).toBe(201);
    expect(child.body).toMatchObject({ name: '子B', parentId: parent.body.id, depth: 2 });
  });

  it('第 6 级拒绝：400 文件夹层级已达上限（5 级）', async () => {
    let cur = (await createFolder('L1')).body.id as string;
    for (let d = 2; d <= 5; d++) {
      cur = (await createFolder(`L${d}`, cur)).body.id;
    }
    const sixth = await createFolder('L6', cur);
    expect(sixth.status).toBe(400);
    expect(sixth.body.message).toBe('文件夹层级已达上限（5 级）');
  });

  it('改名：PATCH {name} → 200 且列表回显新名', async () => {
    const f = await createFolder('旧名');
    const res = await authed('patch', `/api/folders/${f.body.id}`).send({ name: '新名' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('新名');
    const tree = await authed('get', '/api/folders');
    expect(tree.body.find((x: { id: string }) => x.id === f.body.id).name).toBe('新名');
  });

  it('非法名：含 \\ / : * ? " < > | 或空或超 64 字 → 400；64 字放行', async () => {
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', '>b', 'a|b', '']) {
      const res = await createFolder(bad);
      expect(res.status).toBe(400);
    }
    expect((await createFolder('x'.repeat(65))).status).toBe(400);
    expect((await createFolder('x'.repeat(64))).status).toBe(201);
  });

  it('移动环拒绝：移入自身子树 / 自身 → 400 不能移动到自身或其子文件夹', async () => {
    const a = await createFolder('环A');
    const b = await createFolder('环B', a.body.id);
    const c = await createFolder('环C', b.body.id);
    const intoDescendant = await authed('patch', `/api/folders/${a.body.id}`).send({ parentId: c.body.id });
    expect(intoDescendant.status).toBe(400);
    expect(intoDescendant.body.message).toBe('不能移动到自身或其子文件夹');
    const intoSelf = await authed('patch', `/api/folders/${a.body.id}`).send({ parentId: a.body.id });
    expect(intoSelf.status).toBe(400);
    expect(intoSelf.body.message).toBe('不能移动到自身或其子文件夹');
  });

  it('移动子树深度重算：深链移浅 → 整棵子树 depth 更新', async () => {
    const a = (await createFolder('深A')).body.id; // depth 1
    const b = (await createFolder('深B', a)).body.id; // 2
    const c = (await createFolder('深C', b)).body.id; // 3
    const d = (await createFolder('深D', c)).body.id; // 4
    // 移 C 到根：C=1、D=2
    const moved = await authed('patch', `/api/folders/${c}`).send({ parentId: null });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ depth: 1, parentId: null });
    const tree = await authed('get', '/api/folders');
    const byId = new Map(tree.body.map((x: { id: string; depth: number }) => [x.id, x.depth]));
    expect(byId.get(c)).toBe(1);
    expect(byId.get(d)).toBe(2);
    expect(byId.get(b)).toBe(2);
    // 移 B 到另一根下 → B=2、C=2?（C 已是根，D 不在 B 子树）
    const another = (await createFolder('另一根')).body.id;
    await authed('patch', `/api/folders/${b}`).send({ parentId: another });
    const tree2 = await authed('get', '/api/folders');
    const byId2 = new Map(tree2.body.map((x: { id: string; depth: number }) => [x.id, x.depth]));
    expect(byId2.get(b)).toBe(2);
    expect(byId2.get(d)).toBe(2); // D 的父是 C（根），不受 B 移动影响
    expect(byId2.get(a)).toBe(1);
  });

  it('移动后超 5 级拒绝：400 且子树 depth 不变', async () => {
    const r = (await createFolder('满链R')).body.id; // 1
    let cur = r;
    for (const n of ['满链2', '满链3', '满链4', '满链5']) {
      cur = (await createFolder(n, cur)).body.id; // 2..5
    }
    const other = (await createFolder('移动落点')).body.id; // 1
    const res = await authed('patch', `/api/folders/${r}`).send({ parentId: other });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('文件夹层级已达上限（5 级）');
    const tree = await authed('get', '/api/folders');
    const rRow = tree.body.find((x: { id: string }) => x.id === r);
    expect(rRow.depth).toBe(1);
    expect(rRow.parentId).toBe(null);
  });

  it('GET /api/folders：扁平数组按 depth ASC → name ASC，且仅本人可见', async () => {
    // 建乱序同层文件夹（同一 depth 下 ASCII 名顺序在 utf8mb4_unicode_ci 与 JS 序下一致，
    // 可作 name 排序的确定性断言；CJK 权重序与 JS 码点序不同，不得用 JS <= 断言）
    await createFolder('Banana');
    await createFolder('Apple');
    const apple = (await authed('get', '/api/folders')).body.find(
      (x: { name: string }) => x.name === 'Apple',
    ).id as string;
    await createFolder('sib-cherry', apple);
    await createFolder('sib-apple', apple);
    await createFolder('sib-banana', apple);
    // 另一用户建自己的文件夹，不应出现在本人列表
    await authed('post', '/api/folders').set('Authorization', `Bearer ${otherToken}`).send({ name: '乙的文件夹' });

    const res = await authed('get', '/api/folders');
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ id: string; name: string; parentId: string | null; depth: number }>;
    expect(rows.some((x) => x.name === '乙的文件夹')).toBe(false);
    // depth 全局非降（排序主键；collation 无关）
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].depth).toBeGreaterThanOrEqual(rows[i - 1].depth);
    }
    // 同 depth 内按 name：三个 ASCII 兄弟必须恰为字典序（ORDER BY name 存在性判据）
    const sibs = rows.filter((x) => x.parentId === apple).map((x) => x.name);
    expect(sibs).toEqual(['sib-apple', 'sib-banana', 'sib-cherry']);
    // 乱序创建的同层 ASCII 对仍有序
    const depth1Ascii = rows.filter((x) => x.depth === 1 && /^[A-Za-z]/.test(x.name)).map((x) => x.name);
    expect(depth1Ascii).toEqual([...depth1Ascii].sort((a, b) => (a < b ? -1 : 1)));
  });

  it('父文件夹不存在/不可用：POST parentId 无效 → 400', async () => {
    const res = await createFolder('孤儿', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(res.status).toBe(400);
  });

  it('删除含文件文件夹：整棵子树软删 + 文件入回收站（deleted_by=调用者）', async () => {
    const f = (await createFolder('删F')).body.id;
    const g = (await createFolder('删G', f)).body.id;
    const mkFile = async (title: string, folderId: string | null): Promise<string> => {
      const res = await authed('post', '/api/files').send({ title });
      expect(res.status).toBe(201);
      const id = res.body.id as string;
      if (folderId) {
        const moved = await authed('patch', `/api/files/${id}`).send({ folderId });
        expect(moved.status).toBe(200);
      }
      return id;
    };
    const fInF = await mkFile('甲在F', f);
    const fInG = await mkFile('甲在G', g);
    const fRoot = await mkFile('甲在根', null);

    const del = await authed('delete', `/api/folders/${f}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    // 文件夹整棵子树 deleted_at 落库
    const folderRows = (await ds.query('SELECT id, deleted_at FROM folders WHERE id IN (?, ?)', [
      f,
      g,
    ])) as Array<{ id: string; deleted_at: Date | string }>;
    expect(folderRows).toHaveLength(2);
    for (const row of folderRows) expect(row.deleted_at).not.toBeNull();

    // 文件入回收站：deleted_at + deleted_by = 调用者
    const fileRows = (await ds.query('SELECT id, deleted_at, deleted_by FROM files WHERE id IN (?, ?)', [
      fInF,
      fInG,
    ])) as Array<{ id: string; deleted_at: Date | string | null; deleted_by: string | null }>;
    expect(fileRows).toHaveLength(2);
    for (const row of fileRows) {
      expect(row.deleted_at).not.toBeNull();
      expect(row.deleted_by).toBe(userId);
    }
    // 根目录文件不受影响；mine 视图只见存活文件
    const rootRow = (await ds.query('SELECT deleted_at FROM files WHERE id = ?', [fRoot])) as Array<{
      deleted_at: Date | string | null;
    }>;
    expect(rootRow[0].deleted_at).toBeNull();
    const list = await authed('get', '/api/files');
    const titles = list.body.map((x: { title: string }) => x.title);
    expect(titles).toContain('甲在根');
    expect(titles).not.toContain('甲在F');
    expect(titles).not.toContain('甲在G');

    // 已删文件夹再删 → 404（幂等口径同文件域）
    expect((await authed('delete', `/api/folders/${f}`)).status).toBe(404);
  });

  it('PATCH /api/files/:id {folderId}：移动文件 / null 回根 / 非法 400 / 与 title 可组合', async () => {
    const folder = (await createFolder('文件落点')).body.id;
    const created = await authed('post', '/api/files').send({ title: '漂泊文件' });
    const fid = created.body.id as string;

    // 移入文件夹
    const movedIn = await authed('patch', `/api/files/${fid}`).send({ folderId: folder });
    expect(movedIn.status).toBe(200);
    expect(movedIn.body.folderId).toBe(folder);
    const list1 = await authed('get', '/api/files');
    const row1 = list1.body.find((x: { id: string }) => x.id === fid);
    expect(row1.folderId).toBe(folder);
    expect(row1.folderName).toBe('文件落点');

    // null → 根
    const movedRoot = await authed('patch', `/api/files/${fid}`).send({ folderId: null });
    expect(movedRoot.status).toBe(200);
    expect(movedRoot.body.folderId).toBeNull();

    // 非法 folderId（不存在）→ 400
    expect(
      (await authed('patch', `/api/files/${fid}`).send({ folderId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).status,
    ).toBe(400);
    // title 与 folderId 至少一个
    expect((await authed('patch', `/api/files/${fid}`).send({})).status).toBe(400);
    // 与 title 组合一次完成
    const both = await authed('patch', `/api/files/${fid}`).send({ title: '新标题', folderId: folder });
    expect(both.status).toBe(200);
    expect(both.body.title).toBe('新标题');
    expect(both.body.folderId).toBe(folder);
  });

  it('跨用户：他人文件夹 PATCH/DELETE → 404 不泄露', async () => {
    const mine = (await createFolder('甲的私密夹')).body.id;
    const patched = await authed('patch', `/api/folders/${mine}`).send({ name: '改名' });
    expect(patched.status).toBe(200);
    const otherPatch = await authed('patch', `/api/folders/${mine}`, otherToken).send({ name: '乙改' });
    expect(otherPatch.status).toBe(404);
    const otherDelete = await authed('delete', `/api/folders/${mine}`, otherToken);
    expect(otherDelete.status).toBe(404);
    const otherMove = await authed('patch', `/api/folders/${mine}`, otherToken).send({ parentId: null });
    expect(otherMove.status).toBe(404);
    const tree = await authed('get', '/api/folders', otherToken);
    expect(tree.body.some((x: { id: string }) => x.id === mine)).toBe(false);
  });
});
