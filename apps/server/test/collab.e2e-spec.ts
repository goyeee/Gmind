import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
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
  createTemplateDoc,
  docFromState,
  docToState,
  getNode,
  setNodeTask,
  setText,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
import { createAccount } from './support/auth-test';
import { CollabService } from '../src/collab/collab.service';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
import { FileEntity } from '../src/files/file.entity';

/** 协同网关 e2e（Task M2-1）：Node 侧用 @hocuspocus/provider（HocuspocusProviderWebsocket
 *  + WebSocketPolyfill=ws）直连 Nest HTTP server 的 /collab 升级路由，说标准 y-sync + auth
 *  线协议（Task 9 的机器人复用同一客户端形态）。持久化回写用 DataSource 直查 MySQL
 *  files.doc_state 验证。onStoreDocument 防抖由 e2e 环境压到 300ms（见 env.setup.ts）。 */

interface TrackedClient {
  provider: HocuspocusProvider;
}

interface ParsedStateless {
  type?: string;
  at?: string;
  nodeCount?: number;
  max?: number;
}

const openClients: TrackedClient[] = [];

function onceEvent(provider: HocuspocusProvider, event: string): Promise<Record<string, unknown>> {
  // v4 provider 的 EventEmitter 只有 on/off/emit（无 once）
  return new Promise((resolve) => {
    const handler = (p: Record<string, unknown>): void => {
      (provider as unknown as { off: (e: string, h: unknown) => void }).off(event, handler);
      resolve(p);
    };
    provider.on(event, handler);
  });
}

async function withTimeout<T>(p: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 断言轮询：条件成立或超时（协作消息到达/落库防抖/内存卸载都是异步的）。 */
async function until(pred: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met: ${label}`);
}

function connect(port: number, docId: string, token: string): TrackedClient {
  // v4 单 provider 形态：不传 websocketProvider 时 provider 自建并管理 socket
  // （HocuspocusProviderWebsocket + 自动 attach），显式 socket.connect() 会与之竞争。
  // WebSocketPolyfill=ws：Node 下复用 ws 实现（Task 9 的机器人复用同一客户端形态）。
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}/collab`,
    name: docId,
    // 2026-10-28 P0：token 语义=一次性 ticket（60s 单次）——每次连接/重连先经
    // POST /auth/ws-ticket 换票（与 web 端同形态，Hocuspocus token 支持 async fn）
    token: async () => {
      const res = await request(`http://127.0.0.1:${port}`)
        .post('/api/auth/ws-ticket')
        .set('Authorization', `Bearer ${token}`);
      return (res.body as { ticket: string }).ticket;
    },
    WebSocketPolyfill: WsImpl,
  } as HocuspocusProviderConfiguration);
  const client = { provider };
  openClients.push(client);
  return client;
}

/** 连接并等待完成首次 sync（鉴权失败会在此超时，拒绝类用例应断言 authenticationFailed）。 */
async function connectSynced(port: number, docId: string, token: string): Promise<TrackedClient> {
  const client = connect(port, docId, token);
  await until(() => client.provider.isSynced, 'provider synced');
  return client;
}

async function closeClient(client: TrackedClient): Promise<void> {
  const idx = openClients.indexOf(client);
  if (idx >= 0) openClients.splice(idx, 1);
  // 自管 socket：destroy 一并关闭底层 WebSocket 并停止重连
  client.provider.destroy();
}

describe('Hocuspocus 协同网关（鉴权/加载/同步/持久化/配额告警）', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let dataSource: DataSource;
  let collabService: CollabService;
  let port: number;
  let fileId: string;
  let nodeId: string;
  let ownerToken: string;
  let collaboratorToken: string;
  let outsiderToken: string;

  const rowOf = (id = fileId): Promise<FileEntity> =>
    dataSource.getRepository(FileEntity).findOneByOrFail({ id });

  beforeAll(async () => {
    app = await createTestApp();
    // e2e 平价：collab 网关挂在与线上一致的 Nest HTTP server 上（main.ts 同款接线）
    collabService = app.get(CollabService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    dataSource = app.get(DataSource);

    const filesMod = await import('../src/files/files.service');
    const files = app.get(filesMod.FilesService);

    const owner = await createAccount(app);
    const collaborator = await createAccount(app);
    const outsider = await createAccount(app);
    ownerToken = owner.token;
    collaboratorToken = collaborator.token;
    outsiderToken = outsider.token;

    const created = await files.createForUser(owner.id, {
      title: '协同文件',
      state: docToState(createTemplateDoc({ title: '协同文件', children: [{ text: '初始节点' }] })),
    });
    fileId = created.id;
    const doc = docFromState(created.docState as Buffer);
    nodeId = childrenIds(doc, ROOT_NODE_ID)[0] as string;

    const collab = dataSource.getRepository(FileCollaboratorEntity).create();
    collab.fileId = fileId;
    collab.userId = collaborator.id;
    collab.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collab);
  });

  afterAll(async () => {
    for (const c of [...openClients]) await closeClient(c);
    await app.close();
  });

  it('case 1: 无 token / 伪造 token → 连接被拒（permission-denied，不进入 sync）', async () => {
    for (const token of ['', 'forged-token-not-in-redis']) {
      const client = connect(port, fileId, token);
      const failed = await withTimeout(
        onceEvent(client.provider, 'authenticationFailed'),
        `auth rejected for token="${token}"`,
      );
      expect(failed).toBeDefined();
      expect(client.provider.isAuthenticated).toBe(false);
      expect(client.provider.isSynced).toBe(false);
      await closeClient(client);
    }
  });

  it('case 2: 非协作者连他人文件 → 拒；不存在的文件同口径 reason（不泄露存在性）', async () => {
    const outsider = connect(port, fileId, outsiderToken);
    const denied = await withTimeout(
      onceEvent(outsider.provider, 'authenticationFailed'),
      'outsider rejected',
    );
    expect(denied.reason).toBe('permission-denied');
    expect(outsider.provider.isSynced).toBe(false);
    await closeClient(outsider);

    const ghost = connect(port, ulid(), outsiderToken);
    const deniedGhost = await withTimeout(
      onceEvent(ghost.provider, 'authenticationFailed'),
      'ghost file rejected',
    );
    expect(deniedGhost.reason).toBe('permission-denied'); // 与「文件不存在」同口径
    await closeClient(ghost);
  });

  it('case 3: owner 连接 → sync 成功，doc_state 内容可解码（meta/root/子节点）', async () => {
    const client = await connectSynced(port, fileId, ownerToken);
    expect(client.provider.isAuthenticated).toBe(true);

    const doc: Y.Doc = client.provider.document;
    expect(getNode(doc, ROOT_NODE_ID)?.text).toBe('协同文件');
    expect(getNode(doc, nodeId)?.text).toBe('初始节点');
    expect(childrenIds(doc, ROOT_NODE_ID)).toContain(nodeId);
    await closeClient(client);
  });

  it('case 4: A(owner) 改文本 → B(collaborator) 收到（A→B 同步）', async () => {
    const a = await connectSynced(port, fileId, ownerToken);
    const b = await connectSynced(port, fileId, collaboratorToken);
    const current = getNode(a.provider.document, nodeId)?.text as string;
    setText(a.provider.document, nodeId, `${current}-A改`);

    await until(
      () => getNode(b.provider.document, nodeId)?.text === `${current}-A改`,
      'B received A edit',
    );
    await closeClient(a);
    await closeClient(b);
  });

  it('case 5: B(collaborator) 改 → A 收到；doc_state 回写 MySQL + persisted ack；重连内容仍在 + 内存卸载', async () => {
    const aPayloads: string[] = [];
    const a = await connectSynced(port, fileId, ownerToken);
    a.provider.on('stateless', (p: { payload: string }) => aPayloads.push(p.payload));
    const b = await connectSynced(port, fileId, collaboratorToken);

    setText(b.provider.document, nodeId, 'B改的文本');
    await until(
      () => getNode(a.provider.document, nodeId)?.text === 'B改的文本',
      'A received B edit',
    );
    await closeClient(b);

    // 持久化回写：直查 MySQL，doc_state 反序列化后含 B 的编辑（onStoreDocument 防抖后落库）
    await until(async () => {
      const row = await rowOf();
      if (!row.docState || row.docState.length === 0) return false;
      const persisted = docFromState(new Uint8Array(row.docState));
      return getNode(persisted, nodeId)?.text === 'B改的文本';
    }, 'doc_state persisted to MySQL');
    expect((await rowOf()).nodeCount).toBe(1); // 可达活跃口径（root 不计）

    // persisted ack 广播给仍在线的 A（{type:'persisted', at: ISO}）
    await until(() => {
      const acks = aPayloads
        .map((p) => { try { return JSON.parse(p) as ParsedStateless; } catch { return null; } })
        .filter((j): j is ParsedStateless => j?.type === 'persisted');
      return acks.length > 0 && !Number.isNaN(Date.parse(acks[0]!.at as string));
    }, 'persisted ack broadcast');
    await closeClient(a);

    // 文档无人后从内存卸载（Hocuspocus unloadImmediately 默认 true）
    await until(() => collabService.getDocumentsCount() === 0, 'document unloaded after last disconnect');

    // 断开重连 → 内容仍在（加载自 MySQL 回写后的 doc_state）
    const again = await connectSynced(port, fileId, ownerToken);
    expect(getNode(again.provider.document, nodeId)?.text).toBe('B改的文本');
    await closeClient(again);
  });

  it('case 6: 越过 500 节点配额 → 不拒绝连接/编辑，广播 quota-exceeded；持续越线不刷屏（边缘触发）', async () => {
    const filesMod = await import('../src/files/files.service');
    const files = app.get(filesMod.FilesService);
    const quotaOwner = await createAccount(app);
    const quotaToken = quotaOwner.token;
    // 恰好 500 可达子节点（准入边界内，PUT/createForUser 口径）
    const big = await files.createForUser(quotaOwner.id, {
      title: '配额文件',
      state: docToState(
        createTemplateDoc({
          title: '配额文件',
          children: Array.from({ length: 500 }, (_, i) => ({ text: `n${i}` })),
        }),
      ),
    });

    const client = await connectSynced(port, big.id, quotaToken);
    const payloads: string[] = [];
    client.provider.on('stateless', (p: { payload: string }) => payloads.push(p.payload));

    const warningCounts = (): number[] =>
      payloads
        .map((p) => { try { return JSON.parse(p) as ParsedStateless; } catch { return null; } })
        .filter((j): j is ParsedStateless => j?.type === 'quota-exceeded')
        .map((j) => j.nodeCount as number);

    // 第 501 个节点 → 越线广播（advisory：连接与 sync 不受影响）
    addChild(client.provider.document, ROOT_NODE_ID, { text: '越线节点' });
    await until(() => warningCounts().length > 0, 'quota-exceeded broadcast');
    expect(warningCounts()[0]).toBe(501);
    expect(client.provider.isSynced).toBe(true);

    // 边缘触发：仍在越线状态下的后续编辑不重复广播
    const before = warningCounts().length;
    const kids = childrenIds(client.provider.document, ROOT_NODE_ID);
    setText(client.provider.document, kids[0] as string, '仍在越线状态');
    await new Promise((r) => setTimeout(r, 300));
    expect(warningCounts().length).toBe(before);

    await closeClient(client);
  });
});

/**
 * 任务动态声明（第二轮 2026-11-21，spec §5.5）：
 * - stateless 声明盖章：actor 一律取连接身份（payload 声明值覆盖）、taskText/canvasId
 *   服务端文档现值覆盖、related 收敛；不转发给其他连接（无实时弹幕）；
 * - readOnly 连接声明丢弃；形状非法/超长/伪造 nodeId 丢弃；开放上报端点 task_* 400；
 * - todos PATCH 直记 task_* 事件（操作者=登录身份）；
 * - 自动父派生变化由索引重建 diff 补记（操作者=最后修改者近似，derived 标记）。
 */
describe('任务动态声明（stateless 盖章）', () => {
  let app: import('@nestjs/common').INestApplication;
  let port: number;
  let ownerToken: string;
  let ownerId: string;
  let editorToken: string;
  let editorId: string;
  let viewerToken: string;
  let viewerId: string;
  let fileId: string;
  let taskId: string;
  let autoPId: string;
  let autoChildId: string;
  let dataSource: DataSource;

  const authed = (token: string, method: 'get' | 'post' | 'patch' | 'put', url: string) =>
    request(app.getHttpServer())
      [method](url)
      .set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    const httpServer = app.getHttpServer();
    app.get(CollabService).attach(httpServer);
    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    port = (httpServer.address() as AddressInfo).port;
    dataSource = app.get(DataSource);
    const owner = await createAccount(app);
    ownerToken = owner.token;
    ownerId = owner.id;
    const editor = await createAccount(app);
    editorToken = editor.token;
    editorId = editor.id;
    const viewer = await createAccount(app);
    viewerToken = viewer.token;
    viewerId = viewer.id;

    // 文件：任务A（owner=editor）+ 自动父（autoProgress，owner=owner，子任务 40）
    const doc = createTemplateDoc({ title: '动态文件', children: [{ text: '任务A' }, { text: '自动父' }] });
    const kids = getNode(doc, 'root')!.childIds;
    taskId = kids[0]!;
    autoPId = kids[1]!;
    setNodeTask(doc, taskId, { owners: [editorId], status: 'doing', progress: 40 });
    setNodeTask(doc, autoPId, { owners: [ownerId], autoProgress: true, progress: 40 });
    autoChildId = addChild(doc, autoPId, { text: '子任务' });
    setNodeTask(doc, autoChildId, { owners: [ownerId], status: 'doing', progress: 40 });
    const created = await authed(ownerToken, 'post', '/api/files').send({ title: '动态文件' });
    fileId = (created.body as { id: string }).id;
    await authed(ownerToken, 'post', `/api/files/${fileId}/collaborators`).send({
      members: [
        { userId: editorId, role: 'editor' },
        { userId: viewerId, role: 'viewer' },
      ],
    });
    const put = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({
      docState: Buffer.from(docToState(doc)).toString('base64'),
    });
    expect(put.status).toBe(200);
  });

  afterAll(async () => {
    for (const c of [...openClients]) await closeClient(c);
    await app.close();
  });

  it('盖章：连接身份覆盖声明 actor，taskText/related 服务端现值，且不广播', async () => {
    const owner = await connectSynced(port, fileId, ownerToken);
    const editor = await connectSynced(port, fileId, editorToken);
    // editor 连接不收到 task-event 转发（拦截不广播）；filter-updated 等其他类型不受影响
    const received: string[] = [];
    editor.provider.on('stateless', ({ payload }: { payload: string }) => received.push(payload));

    const decl = {
      kind: 'task_progress',
      nodeId: taskId,
      actor: 'FAKE-OPERATOR-ID-NOT-TRUSTED', // 伪造操作者——必须被连接身份覆盖
      before: { status: 'doing', progress: 40 },
      after: { status: 'doing', progress: 80 },
    };
    editor.provider.sendStateless(JSON.stringify({ type: 'task-event', decl }));
    await until(async () => {
      const rows = (await dataSource.query('SELECT type, user_id, payload FROM events WHERE file_id = ? AND type LIKE ?', [fileId, 'task\\_%'])) as Array<{ type: string; user_id: string; payload: string }>;
      return rows.length > 0;
    }, 'task event recorded');
    const rows = (await dataSource.query('SELECT type, user_id, payload FROM events WHERE file_id = ? AND type LIKE ?', [fileId, 'task\\_%'])) as Array<{ type: string; user_id: string; payload: string }>;
    const row = rows.find((r) => r.type === 'task_progress')!;
    expect(row.user_id).toBe(editorId); // 盖章：非伪造值
    const payload = JSON.parse(row.payload) as { actor: string; taskText: string; related: string[]; after: { progress: number } };
    expect(payload.actor).toBe(editorId);
    expect(payload.taskText).toBe('任务A'); // 服务端文档现值覆盖
    expect(payload.related).toEqual([editorId]); // related=任务A 的 owner（editorId）∪ 声明对象 ∪ actor
    expect(await new Promise<number>((r) => setTimeout(() => r(received.filter((p) => p.includes('task-event')).length), 300))).toBe(0);

    await closeClient(owner);
    await closeClient(editor);
  });

  it('viewer 连接声明丢弃；形状非法/伪造 nodeId 丢弃；开放上报 task_* 400', async () => {
    const viewer = await connectSynced(port, fileId, viewerToken);
    const before = ((await dataSource.query('SELECT COUNT(*) AS n FROM events WHERE file_id = ? AND type LIKE ?', [fileId, 'task\\_%'])) as Array<{ n: number }>)[0]!.n;
    viewer.provider.sendStateless(JSON.stringify({ type: 'task-event', decl: { kind: 'task_progress', nodeId: taskId, after: { status: 'doing', progress: 90 } } }));
    const bad = JSON.stringify({ type: 'task-event', decl: { kind: 'task_progress', nodeId: 'NO-SUCH-NODE', after: { status: 'doing', progress: 90 } } });
    const editor = await connectSynced(port, fileId, editorToken);
    editor.provider.sendStateless(bad);
    editor.provider.sendStateless('not-json-at-all');
    editor.provider.sendStateless(JSON.stringify({ type: 'task-event', decl: { kind: 'task_bogus_kind', nodeId: taskId } }));
    // 伪造完成丢弃（评审 P2-1）：任务A 现值 progress=40（未完成），声明完成应被丢弃
    editor.provider.sendStateless(JSON.stringify({ type: 'task-event', decl: { kind: 'task_complete', nodeId: taskId, after: { status: 'done', progress: 100 } } }));
    await new Promise((r) => setTimeout(r, 400));
    const after = ((await dataSource.query('SELECT COUNT(*) AS n FROM events WHERE file_id = ? AND type LIKE ?', [fileId, 'task\\_%'])) as Array<{ n: number }>)[0]!.n;
    expect(Number(after)).toBe(Number(before)); // 无效声明 + 伪完成全部丢弃
    // after 现值覆盖（真实流等价）：编辑器连接的内存文档写入（WS 同步到服务端内存
    // doc——真实客户端写路径先于声明到达），再声明陈旧 after:40——盖章后应为 80
    setNodeTask(editor.provider.document, taskId, { progress: 80 });
    await new Promise((r) => setTimeout(r, 400)); // WS 同步先于声明到达（真实流序）
    editor.provider.sendStateless(JSON.stringify({ type: 'task-event', decl: { kind: 'task_progress', nodeId: taskId, before: { status: 'doing', progress: 40 }, after: { status: 'doing', progress: 40 } } }));
    await until(async () => {
      const rows = (await dataSource.query("SELECT payload FROM events WHERE file_id = ? AND type = 'task_progress' ORDER BY created_at DESC LIMIT 1", [fileId])) as Array<{ payload: string }>;
      const p = JSON.parse(rows[0]!.payload) as { after: { progress: number } };
      return p.after.progress === 80;
    }, 'after overwritten by server snapshot');

    const reject = await authed(editorToken, 'post', '/api/events').send({ type: 'task_progress', fileId, payload: { taskText: '伪造' } });
    expect(reject.status).toBe(400);
    await closeClient(viewer);
    await closeClient(editor);
  });

  it('todos PATCH 直记：完成 → task_complete（actor=登录身份）', async () => {
    const patch = await authed(editorToken, 'patch', `/api/todos/${fileId}/${taskId}`).send({ progress: 80 });
    expect(patch.status).toBe(200);
    await until(async () => {
      const rows = (await dataSource.query('SELECT type, user_id FROM events WHERE file_id = ? AND type = ?', [fileId, 'task_progress'])) as Array<{ type: string; user_id: string }>;
      return rows.length > 0;
    }, 'patch task_progress event');
    const done = await authed(editorToken, 'patch', `/api/todos/${fileId}/${taskId}`).send({ done: true });
    expect(done.status).toBe(200);
    await until(async () => {
      const rows = (await dataSource.query('SELECT user_id, payload FROM events WHERE file_id = ? AND type = ?', [fileId, 'task_complete'])) as Array<{ user_id: string; payload: string }>;
      return rows.length > 0;
    }, 'patch task_complete event');
    const rows = (await dataSource.query('SELECT user_id, payload FROM events WHERE file_id = ? AND type = ?', [fileId, 'task_complete'])) as Array<{ user_id: string; payload: string }>;
    expect(rows[0]!.user_id).toBe(editorId);
    expect((JSON.parse(rows[0]!.payload) as { before: { progress: number }; after: { progress: number } }).after.progress).toBe(100);
  });

  it('自动父派生变化补记：子任务 40→80 后重建 diff 记 task_progress（derived）', async () => {
    // 变更子任务进度 → PUT 落库 → 重建 → 自动父派生 40→60 补记
    const content = await authed(ownerToken, 'get', `/api/files/${fileId}`);
    const doc = docFromState(new Uint8Array(Buffer.from((content.body as { docState: string }).docState, 'base64')));
    setNodeTask(doc, autoChildId, { progress: 80 });
    const put = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({
      docState: Buffer.from(docToState(doc)).toString('base64'),
    });
    expect(put.status).toBe(200);
    await until(async () => {
      const rows = (await dataSource.query('SELECT user_id, payload FROM events WHERE file_id = ? AND type = ?', [fileId, 'task_progress'])) as Array<{ user_id: string; payload: string }>;
      return rows.some((r) => {
        const p = JSON.parse(r.payload) as { derived?: boolean; before?: { progress: number }; after?: { progress: number }; actor?: string };
        return p.derived === true && p.before?.progress === 40 && p.after?.progress === 80;
      });
    }, 'derived event');
    const rows = (await dataSource.query('SELECT user_id, payload FROM events WHERE file_id = ? AND type = ?', [fileId, 'task_progress'])) as Array<{ user_id: string; payload: string }>;
    const derivedRow = rows
      .map((r) => ({ user_id: r.user_id, payload: JSON.parse(r.payload) as { derived?: boolean; before?: { progress: number }; after?: { progress: number } } }))
      .find((r) => r.payload.derived === true)!;
    expect(derivedRow.payload.before?.progress).toBe(40);
    expect(derivedRow.payload.after?.progress).toBe(80);
    // 操作者=触发重建的最后修改者（近似口径，登记）：PUT API 无 lastEditorUserId
    // 标记 → 如实为 null（展示层兜底「系统」）
    expect(derivedRow.user_id).toBeNull();
  });
});
