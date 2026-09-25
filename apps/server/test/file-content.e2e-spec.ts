import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsImpl } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import type * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  addChild,
  childrenIds,
  countAliveReachable,
  countNodes,
  createTemplateDoc,
  deleteNodes,
  docFromState,
  docToState,
  getNode,
  setNote,
  setText,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
import { CollabService } from '../src/collab/collab.service';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
import { FileEntity } from '../src/files/file.entity';

/** 构造一个模板文档的 Yjs 状态（base64 传输契约）。 */
const toBase64State = (spec: Parameters<typeof createTemplateDoc>[0]): string =>
  Buffer.from(docToState(createTemplateDoc(spec))).toString('base64');

describe('文件内容端点（读取/回写/改名/打开）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownerToken: string;
  let otherToken: string;
  let ownerUserId: string;
  let fileId: string;

  const tokenFor = async (userId: string): Promise<string> => {
    // 直接通过 SessionService 签发，登录接口在 Task 8 才有
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put' | 'patch';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    dataSource = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const owner = await users.create({ method: 'phone', phone: '13900001001' });
    const other = await users.create({ method: 'phone', phone: '13900001002' });
    ownerUserId = owner.id;
    ownerToken = await tokenFor(owner.id);
    otherToken = await tokenFor(other.id);

    const files = app.get((await import('../src/files/files.service')).FilesService);
    const created = await files.createForUser(owner.id, {
      title: '内容文件',
      state: docToState(createTemplateDoc({ title: '内容文件', children: [{ text: 'a' }] })),
    });
    fileId = created.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('owner 读取返回 base64 docState，可被 docFromState 还原且 meta 正确', async () => {
    const res = await authed(ownerToken, 'get', `/api/files/${fileId}`);
    expect(res.status).toBe(200);
    // starred（M3b 清偿包，FR-FIL-004）：编辑器加星入口的当前视角星标状态
    expect(Object.keys(res.body).sort()).toEqual(['docState', 'id', 'nodeCount', 'ownerUserId', 'starred', 'structure', 'themeId', 'title', 'updatedAt']);
    expect(res.body.title).toBe('内容文件');
    expect(res.body.starred).toBe(false);
    // 可达活跃口径（countAliveReachable，root 不计）：root + 1 子级 → 1
    // ——createForUser 与保存路径统一（M2 终审修复轮，旧 countNodes 口径为 2）
    expect(res.body.nodeCount).toBe(1);
    // M2 Task 6：ownerUserId 供前端创建者标识（FR-COL-005）
    expect(res.body.ownerUserId).toBe(ownerUserId);

    const doc = docFromState(new Uint8Array(Buffer.from(res.body.docState, 'base64')));
    expect(doc.getMap('meta').get('title')).toBe('内容文件');
    expect(doc.getMap('meta').get('structureType')).toBe(res.body.structure);
    expect(doc.getMap('meta').get('themeId')).toBe(res.body.themeId);
    // createForUser 与保存路径同口径：countAliveReachable（M2 终审修复轮收口，
    // 旧 countNodes 计入墓碑的 ±N 语义差已消除）
    expect(countAliveReachable(doc)).toBe(res.body.nodeCount);
  });

  it('非相关用户读取 → 404（不泄露存在性）', async () => {
    const res = await authed(otherToken, 'get', `/api/files/${fileId}`);
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('文件不存在');
  });

  it('collaborator 行存在即可读写（一期协作者即可编辑，spec §7.2）', async () => {
    const otherRow = await dataSource.getRepository('users').findOneByOrFail({ phone: '13900001002' });
    const collab = dataSource.getRepository(FileCollaboratorEntity).create();
    collab.fileId = fileId;
    collab.userId = (otherRow as { id: string }).id;
    collab.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collab);

    const got = await authed(otherToken, 'get', `/api/files/${fileId}`);
    expect(got.status).toBe(200);

    const putRes = await request(app.getHttpServer())
      .put(`/api/files/${fileId}/doc-state`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ docState: toBase64State({ title: '协作改', children: [{ text: 'x' }] }) });
    expect(putRes.status).toBe(200);
    expect(putRes.body.nodeCount).toBe(1); // 可达活跃口径（不含 root）
  });

  it('PUT 合法状态（2 存活节点 + root）→ nodeCount=2（可达活跃口径）且再次 GET 读回一致', async () => {
    const state = toBase64State({ title: 'T', children: [{ text: 'a' }, { text: 'b' }] });
    const put = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    expect(put.status).toBe(200);
    // node_count 写回口径 = countAliveReachable（不含 root，FR-ACC-003 活跃文档规模）
    expect(put.body).toEqual({ nodeCount: 2 });

    const got = await authed(ownerToken, 'get', `/api/files/${fileId}`);
    expect(got.status).toBe(200);
    expect(got.body.docState).toBe(state);
    expect(got.body.nodeCount).toBe(2);
    const doc = docFromState(new Uint8Array(Buffer.from(got.body.docState, 'base64')));
    expect(countNodes(doc)).toBe(3); // 旧 countNodes 口径含 root：3
    expect(countAliveReachable(doc)).toBe(2);
    expect(doc.getMap('meta').get('title')).toBe('T');
  });

  it('PUT 非法字节 → 400「文档解析失败」', async () => {
    const res = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({
      docState: Buffer.from('this is definitely not a yjs update').toString('base64'),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('文档解析失败');
  });

  it('PUT 可达活跃节点 501（+root）→ 403「文档节点数已达上限（500）」', async () => {
    const state = toBase64State({
      title: '超大文档',
      children: Array.from({ length: 501 }, (_, i) => ({ text: `n${i}` })),
    });
    const res = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('文档节点数已达上限（500）');
  });

  it('PUT 600 节点其中 200 墓碑（可达 400）→ 200 且 nodeCount=400（配额只看可达活跃）', async () => {
    // 经 core 操作层构建：600 子节点后删除 200 个（墓碑语义，nodes 条目永不清除）
    const doc = createTemplateDoc({
      title: '墓碑文档',
      children: Array.from({ length: 600 }, (_, i) => ({ text: `n${i}` })),
    });
    const rootChildren = (doc.getMap('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>).get(
      'children',
    ) as Y.Array<string>;
    deleteNodes(doc, rootChildren.toArray().slice(0, 200));
    expect(countAliveReachable(doc)).toBe(400);
    expect(countNodes(doc)).toBe(601); // 旧 countNodes 口径会把墓碑余额计入而误判超限

    const state = Buffer.from(docToState(doc)).toString('base64');
    const res = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({ docState: state });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ nodeCount: 400 });
  });

  it('PATCH 改名 → GET title 变化且列表同步', async () => {
    const res = await authed(ownerToken, 'patch', `/api/files/${fileId}`).send({ title: '新名字' });
    expect(res.status).toBe(200);
    // 响应 = FileListItem 契约（toListItem 唯一出口）+ folderId（M3a Task 5 移动语义，
    // 客户端移动后无需回查列表即知落点；未移动时为当前落点 null/文件夹 id）
    expect(Object.keys(res.body).sort()).toEqual(['folderId', 'id', 'lastOpenedAt', 'nodeCount', 'structure', 'title', 'updatedAt']);
    expect(res.body.title).toBe('新名字');
    expect(res.body.folderId).toBeNull();

    const got = await authed(ownerToken, 'get', `/api/files/${fileId}`);
    expect(got.body.title).toBe('新名字');

    const list = await authed(ownerToken, 'get', '/api/files');
    expect(list.body.find((f: { id: string }) => f.id === fileId).title).toBe('新名字');
  });

  it('PATCH 空标题 → 400（复用 createFileSchema.title 校验）', async () => {
    const res = await authed(ownerToken, 'patch', `/api/files/${fileId}`).send({ title: '' });
    expect(res.status).toBe(400);
  });

  it('POST open → lastOpenedAt 非空', async () => {
    const res = await authed(ownerToken, 'post', `/api/files/${fileId}/open`);
    expect(res.status).toBe(200);
    expect(res.body.lastOpenedAt).toBeTypeOf('string');
    expect(Number.isNaN(Date.parse(res.body.lastOpenedAt))).toBe(false);

    const row = await dataSource.getRepository(FileEntity).findOneByOrFail({ id: fileId });
    expect(row.lastOpenedAt).not.toBeNull();
    expect(row.lastOpenedAt?.toISOString()).toBe(res.body.lastOpenedAt);
  });

  it('连续两次 POST open → last_opened_at 真实推进且 updated_at 不变（定点更新，不污染列表排序）', async () => {
    const repo = dataSource.getRepository(FileEntity);
    // 脚手架：直查 DB 把 last_opened_at 拨旧（绕 1 分钟写摊销）。updated_at 一并拨到
    // 已知旧值——若实现误走 save()（或 update() 未显式钉住 updated_at），UpdateQueryBuilder
    // 会自动回填 CURRENT_TIMESTAMP（秒级截断），与旧值必不同，断言即可捕获。
    const rewind = (): Promise<unknown> => {
      const past = new Date(Date.now() - 120_000);
      return repo.update(fileId, { lastOpenedAt: past, updatedAt: past });
    };

    await rewind();
    const before1 = await repo.findOneByOrFail({ id: fileId });
    const open1 = await authed(ownerToken, 'post', `/api/files/${fileId}/open`);
    expect(open1.status).toBe(200);
    const after1 = await repo.findOneByOrFail({ id: fileId });

    await rewind();
    const before2 = await repo.findOneByOrFail({ id: fileId });
    const open2 = await authed(ownerToken, 'post', `/api/files/${fileId}/open`);
    expect(open2.status).toBe(200);
    const after2 = await repo.findOneByOrFail({ id: fileId });

    // last_opened_at：两次 open 均真实推进（直查 DB 对比两次读值）
    expect(after1.lastOpenedAt!.getTime()).toBeGreaterThan(before1.lastOpenedAt!.getTime());
    expect(after2.lastOpenedAt!.getTime()).toBeGreaterThan(before2.lastOpenedAt!.getTime());
    // updated_at：open 不推进（走 repo.update 定点更新而非 save() 全量回写）
    expect(after1.updatedAt.getTime()).toBe(before1.updatedAt.getTime());
    expect(after2.updatedAt.getTime()).toBe(before2.updatedAt.getTime());
  });

  it('已删文件的读取/回写/改名/打开全部 404', async () => {
    await dataSource.getRepository(FileEntity).update(fileId, { deletedAt: new Date() });

    expect((await authed(ownerToken, 'get', `/api/files/${fileId}`)).status).toBe(404);
    const putRes = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({
      docState: toBase64State({ title: 'x', children: [] }),
    });
    expect(putRes.status).toBe(404);
    expect((await authed(ownerToken, 'patch', `/api/files/${fileId}`).send({ title: 'x' })).status).toBe(404);
    expect((await authed(ownerToken, 'post', `/api/files/${fileId}/open`)).status).toBe(404);
  });
});

/**
 * PUT 陈旧快照写序守卫（M3a 准入 7.1，Task 2）。
 *
 * 丢失场景（M2 终审复审 Important #2）：A 走 PUT 兜底（从未 WS 连接），B 经 WS
 * 编辑并持久化（updated_at 推进）；A 的整快照 PUT 会永久覆盖 B 的新编辑。
 * 守卫语义：`file.updatedAt > baseUpdatedAt`（严格更晚）**且** collab 持有该文件
 * 的活跃内存 doc（有 WS 通道在写，PUT 是陈旧快照）→ 409；二者缺一放行（纯 PUT
 * 用户间无 WS 竞争面；无内存 doc 时最新落库者即 PUT 自己）。缺省/非法
 * baseUpdatedAt 视为「无 base」——兼容旧客户端与首次保存（永远放行）。
 */
describe('PUT 陈旧快照写序守卫（准入 7.1）', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let dataSource: DataSource;
  let collabService: CollabService;
  let port: number;
  let ownerToken: string;
  let collaboratorToken: string;
  /** 有 WS 内存 doc 的文件（守卫主战场）。 */
  let guardFileId: string;
  /** 从未有 WS 连接的文件（纯 PUT 世界，守卫不得误伤）。 */
  let putOnlyFileId: string;

  interface TrackedClient {
    provider: HocuspocusProvider;
  }
  const openClients: TrackedClient[] = [];

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put' | 'patch';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  const rowOf = (id: string): Promise<FileEntity> =>
    dataSource.getRepository(FileEntity).findOneByOrFail({ id });

  /** 断言轮询（协作消息到达/落库防抖/内存卸载都是异步的，同 collab.e2e-spec）。 */
  async function until(pred: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`condition not met: ${label}`);
  }

  /** 连接并等待完成首次 sync（v4 单 provider 形态 + WebSocketPolyfill=ws，同 collab.e2e-spec）。 */
  async function connectSynced(docId: string, token: string): Promise<TrackedClient> {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: docId,
      token,
      WebSocketPolyfill: WsImpl,
    } as HocuspocusProviderConfiguration);
    const client = { provider };
    openClients.push(client);
    await until(() => client.provider.isSynced, 'provider synced');
    return client;
  }

  async function closeClient(client: TrackedClient): Promise<void> {
    const idx = openClients.indexOf(client);
    if (idx >= 0) openClients.splice(idx, 1);
    client.provider.destroy(); // 自管 socket：destroy 一并关闭底层 WebSocket
  }

  beforeAll(async () => {
    app = await createTestApp();
    collabService = app.get(CollabService);
    // e2e 平价：守卫的「活跃内存 doc」前提需要真实 WS 连接，网关与 collab.e2e-spec
    // 同款接线（挂 app 自己的 HTTP server 后 listen(0)）
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    dataSource = app.get(DataSource);

    const usersMod = await import('../src/users/users.service');
    const filesMod = await import('../src/files/files.service');
    const users = app.get(usersMod.UsersService);
    const files = app.get(filesMod.FilesService);

    const owner = await users.create({ method: 'phone', phone: '13900003001' });
    const collaborator = await users.create({ method: 'phone', phone: '13900003002' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);

    const guard = await files.createForUser(owner.id, {
      title: '守卫文件',
      state: docToState(createTemplateDoc({ title: '守卫文件', children: [{ text: '初始节点' }] })),
    });
    guardFileId = guard.id;
    const collabRow = dataSource.getRepository(FileCollaboratorEntity).create();
    collabRow.fileId = guardFileId;
    collabRow.userId = collaborator.id;
    collabRow.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collabRow);

    const putOnly = await files.createForUser(owner.id, {
      title: '纯PUT文件',
      state: docToState(createTemplateDoc({ title: '纯PUT文件', children: [{ text: '初始节点' }] })),
    });
    putOnlyFileId = putOnly.id;
  });

  afterAll(async () => {
    for (const c of [...openClients]) c.provider.destroy();
    await app.close();
  });

  it('活跃内存 doc + 旧 baseUpdatedAt 的 PUT → 409，且 WS 侧的新编辑保留不被覆盖', async () => {
    // base 取 B 编辑落库前的行值（PUT 兜底客户端 GET 到的旧 updated_at）
    const staleBase = (await rowOf(guardFileId)).updatedAt.toISOString();
    const ownerClient = await connectSynced(guardFileId, ownerToken);
    const collabClient = await connectSynced(guardFileId, collaboratorToken);
    try {
      const doc = collabClient.provider.document as Y.Doc;
      const nodeId = childrenIds(doc, ROOT_NODE_ID)[0] as string;
      setText(doc, nodeId, 'B改的文本'); // WS 编辑 → onStoreDocument 防抖落库 → updated_at 推进

      await until(async () => {
        const row = await rowOf(guardFileId);
        if (!row.docState || row.docState.length === 0) return false;
        const persisted = docFromState(new Uint8Array(row.docState));
        return getNode(persisted, nodeId)?.text === 'B改的文本';
      }, 'B 的编辑落库（updated_at 推进）');

      // A 的整快照 PUT 携带旧 base：丢失场景的复现请求
      const res = await authed(ownerToken, 'put', `/api/files/${guardFileId}/doc-state`).send({
        docState: toBase64State({ title: '守卫文件', children: [{ text: 'A的陈旧快照' }] }),
        baseUpdatedAt: staleBase,
      });
      expect(res.status).toBe(409);
      expect(res.body.message).toBe('文档已在别处更新，请刷新后重试');

      // B 的编辑仍在：陈旧快照未落库
      const row = await rowOf(guardFileId);
      const persisted = docFromState(new Uint8Array(row.docState as Buffer));
      expect(getNode(persisted, nodeId)?.text).toBe('B改的文本');
    } finally {
      // finally 卸连接：断言失败不得把存活连接泄漏给后续用例的「内存 doc 卸载」断言
      await closeClient(ownerClient);
      await closeClient(collabClient);
      // 最后一条连接断开 → unloadImmediately 先落库再卸载（后续用例需要干净基线）
      await until(() => collabService.getDocumentsCount() === 0, '内存 doc 卸载');
    }
  });

  it('活跃内存 doc + baseUpdatedAt >= 当前 updated_at → 200（base 不旧于行值则放行）', async () => {
    // fix round 1：必须先建立活跃内存 doc——否则 hasLiveDoc=false 短路，严格比较
    // 边界（> vs >=）根本不参与判定，`>=` 回归会静默穿过全部用例
    const client = await connectSynced(guardFileId, collaboratorToken);
    try {
      const freshBase = (await rowOf(guardFileId)).updatedAt.toISOString();
      const res = await authed(ownerToken, 'put', `/api/files/${guardFileId}/doc-state`).send({
        docState: toBase64State({ title: '守卫文件', children: [{ text: 'A的新快照' }] }),
        baseUpdatedAt: freshBase,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ nodeCount: 1 });
      // 严格比较语义：base 等于行值（PUT 自己就是最新写）不是「陈旧」，快照正常落库
      const row = await rowOf(guardFileId);
      const persisted = docFromState(new Uint8Array(row.docState as Buffer));
      expect(getNode(persisted, ROOT_NODE_ID)?.text).toBe('守卫文件');
      expect(getNode(persisted, childrenIds(persisted, ROOT_NODE_ID)[0] as string)?.text).toBe('A的新快照');
    } finally {
      await closeClient(client);
      await until(() => collabService.getDocumentsCount() === 0, '内存 doc 卸载');
    }
  });

  it('缺省 baseUpdatedAt（旧客户端/首次保存）→ 200（即便内存 doc 活跃）', async () => {
    const client = await connectSynced(guardFileId, collaboratorToken);
    try {
      const res = await authed(ownerToken, 'put', `/api/files/${guardFileId}/doc-state`).send({
        docState: toBase64State({ title: '守卫文件', children: [{ text: '兼容快照' }] }),
      });
      expect(res.status).toBe(200);
    } finally {
      await closeClient(client);
      await until(() => collabService.getDocumentsCount() === 0, '内存 doc 卸载');
    }
  });

  it('无内存 doc（纯 PUT 世界）旧/非法 baseUpdatedAt → 200（二者缺一放行，不误伤）', async () => {
    // 陈旧 base：updated_at 严格更晚，但无 WS 通道在写（无内存 doc）→ 放行
    const stale = await authed(ownerToken, 'put', `/api/files/${putOnlyFileId}/doc-state`).send({
      docState: toBase64State({ title: '纯PUT文件', children: [{ text: '陈旧但放行' }] }),
      baseUpdatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.status).toBe(200);
    // 非法 base 同口径放行（解析失败视为无 base）
    const invalid = await authed(ownerToken, 'put', `/api/files/${putOnlyFileId}/doc-state`).send({
      docState: toBase64State({ title: '纯PUT文件', children: [{ text: '非法base也放行' }] }),
      baseUpdatedAt: 'not-a-date',
    });
    expect(invalid.status).toBe(200);
  });
});

/**
 * POST /api/files 携带 docState（M4 Task 4，XMind 导入端到端的服务端半边，FR-IO-001）。
 *
 * 导入端把 .xmind 解析树经 @gmind/core 操作层组装为 Y.Doc，以 base64 docState 随
 * POST /api/files 建文件。服务端约定：
 * - nodeCount 一律服务端按 countAliveReachable 重算（不信任客户端传值——body schema
 *   本就不收 nodeCount，service 侧也去掉入参直通）；
 * - docState 损坏（docFromState 抛错）→ 400「文件已损坏」；
 * - 可达活跃节点 > MAX_DOC_NODES → 400「文档节点数已达上限（500）」（文案与
 *   saveDocState 的既有配额文案同口径，但按导入语义落 400 而非 403）。
 */
describe('POST /api/files 携带 docState（XMind 导入）', () => {
  let app: INestApplication;
  let ownerToken: string;

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put' | 'patch';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  /** 经 core 操作层组装导入文档（唯一写入口约束）：createTemplateDoc + addChild + setNote → base64。 */
  const buildDocStateViaCore = (): string => {
    const doc = createTemplateDoc({ title: '中心', children: [] });
    const a = addChild(doc, ROOT_NODE_ID, { text: 'A' });
    setNote(doc, a, 'A 的备注');
    addChild(doc, ROOT_NODE_ID, { text: 'B' });
    return Buffer.from(docToState(doc)).toString('base64');
  };

  beforeAll(async () => {
    app = await createTestApp();
    const users = app.get((await import('../src/users/users.service')).UsersService);
    const owner = await users.create({ method: 'phone', phone: '13900004001' });
    ownerToken = await tokenFor(owner.id);
  });

  afterAll(async () => {
    await app.close();
  });

  it('导入：携带 docState 建文件——nodeCount 服务端重算、层级/备注落库', async () => {
    const state = await buildDocStateViaCore();
    // 客户端就算夹带 nodeCount 也必须被无视（schema 收窄 + service 重算）
    const res = await authed(ownerToken, 'post', '/api/files')
      .send({ title: '导入件', docState: state, nodeCount: 999 });
    expect(res.status).toBe(201);
    // POST 响应即 FileListItem 契约：nodeCount = 可达活跃口径（root 不计）：A + B → 2
    expect(res.body.nodeCount).toBe(2);

    const got = await authed(ownerToken, 'get', `/api/files/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body.nodeCount).toBe(2);
    // 层级与备注落库：root 文本 = 中心，子节点 A/B，A 带备注。docState 忠实原样落库
    // （meta.title 仍为组装时的 中心）；行标题来自 body.title（与复制路径同契约）
    expect(got.body.title).toBe('导入件');
    const doc = docFromState(new Uint8Array(Buffer.from(got.body.docState, 'base64')));
    expect(doc.getMap('meta').get('title')).toBe('中心');
    expect(getNode(doc, ROOT_NODE_ID)?.text).toBe('中心');
    const kids = childrenIds(doc, ROOT_NODE_ID);
    expect(kids).toHaveLength(2);
    expect(getNode(doc, kids[0] as string)?.text).toBe('A');
    expect(getNode(doc, kids[0] as string)?.note).toBe('A 的备注');
    expect(getNode(doc, kids[1] as string)?.text).toBe('B');
  });

  it('导入：可达活跃节点 501（+root）→ 400，文案含「节点数」', async () => {
    const state = Buffer.from(
      docToState(
        createTemplateDoc({
          title: '超大导入',
          children: Array.from({ length: 501 }, (_, i) => ({ text: `n${i}` })),
        }),
      ),
    ).toString('base64');
    const res = await authed(ownerToken, 'post', '/api/files').send({ title: '超限导入', docState: state });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('节点数');
  });

  it('导入：损坏 docState → 400「文件已损坏」', async () => {
    const res = await authed(ownerToken, 'post', '/api/files').send({
      title: '坏件',
      docState: Buffer.from('this is definitely not a yjs update').toString('base64'),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('文件已损坏');
  });
});
