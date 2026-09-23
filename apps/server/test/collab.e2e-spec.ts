import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  setText,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
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
    token,
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

  /** 直接经 SessionService 签发 token（与 file-content.e2e-spec.ts 同款）。 */
  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  const rowOf = (id = fileId): Promise<FileEntity> =>
    dataSource.getRepository(FileEntity).findOneByOrFail({ id });

  beforeAll(async () => {
    app = await createTestApp();
    // e2e 平价：collab 网关挂在与线上一致的 Nest HTTP server 上（main.ts 同款接线）
    collabService = app.get(CollabService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    dataSource = app.get(DataSource);

    const usersMod = await import('../src/users/users.service');
    const filesMod = await import('../src/files/files.service');
    const users = app.get(usersMod.UsersService);
    const files = app.get(filesMod.FilesService);

    const owner = await users.create({ method: 'phone', phone: '13900002001' });
    const collaborator = await users.create({ method: 'phone', phone: '13900002002' });
    const outsider = await users.create({ method: 'phone', phone: '13900002003' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

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
    const usersMod = await import('../src/users/users.service');
    const filesMod = await import('../src/files/files.service');
    const users = app.get(usersMod.UsersService);
    const files = app.get(filesMod.FilesService);
    const quotaOwner = await users.create({ method: 'phone', phone: '13900002004' });
    const quotaToken = await tokenFor(quotaOwner.id);
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
