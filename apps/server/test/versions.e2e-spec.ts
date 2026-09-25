import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsImpl } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import { DataSource } from 'typeorm';
import { ulid } from 'ulid';
import {
  ROOT_NODE_ID,
  childrenIds,
  createTemplateDoc,
  docFromState,
  docToState,
  getNode,
  markLastEditor,
  setText,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
import { CollabService } from '../src/collab/collab.service';
import { FileEntity } from '../src/files/file.entity';
import { VersionEntity } from '../src/versions/version.entity';

/**
 * 版本快照 e2e（M4 Task 6，FR-VER-001）：collab 网关快照状态机三入口 + 90 天清理。
 * - 3 分钟窗口 / 无变更不落：直调 snapshotIfDue（public，供 e2e 注入时钟）；
 * - 卸载兜底：走真实断开（provider destroy → v4 unloadImmediately → beforeUnloadDocument）；
 * - 90 天清理：直插新旧两行 → runCleanup(now) 精确断言返回形状与行存留。
 * 客户端形态与 collab.e2e-spec.ts 同款（HocuspocusProvider + ws，y-sync + auth 帧）。
 * 各用例独立文件，行断言互不串扰。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 断言轮询：条件成立或超时（落库防抖/内存卸载都是异步的）。 */
async function until(pred: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met: ${label}`);
}

describe('版本快照（collab 网关 FR-VER-001）+ 90 天清理', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let dataSource: DataSource;
  let collab: CollabService;
  let port: number;
  let userId: string;
  let token: string;
  // 每个用例独立文件，避免行断言互相污染
  let fileA: FileEntity; // 3 分钟窗口
  let fileB: FileEntity; // 无变更/间隔内
  let fileC: FileEntity; // 卸载兜底
  let fileD: FileEntity; // 90 天清理
  let nodeIdA: string;
  let nodeIdB: string;
  let nodeIdC: string;
  const openClients: { provider: HocuspocusProvider }[] = [];

  /** 直接经 SessionService 签发 token（collab.e2e-spec.ts 同款）。 */
  const tokenFor = async (uid: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(uid, false)).token;
  };

  const versionRows = (fid: string): Promise<VersionEntity[]> =>
    dataSource.getRepository(VersionEntity).find({ where: { fileId: fid }, order: { createdAt: 'ASC' } });

  /** 连接并等待完成首次 sync（鉴权失败会在此超时）。 */
  const connectSynced = async (docId: string, tk: string): Promise<{ provider: HocuspocusProvider }> => {
    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: docId,
      token: tk,
      WebSocketPolyfill: WsImpl,
    } as HocuspocusProviderConfiguration);
    const client = { provider };
    openClients.push(client);
    await until(() => client.provider.isSynced, `provider synced: ${docId}`);
    return client;
  };

  const closeClient = async (client: { provider: HocuspocusProvider }): Promise<void> => {
    const idx = openClients.indexOf(client);
    if (idx >= 0) openClients.splice(idx, 1);
    client.provider.destroy(); // 自管 socket：destroy 一并关闭底层 WebSocket 并停止重连
  };

  /** 等待一次编辑落库（doc_state 反序列化后含该文本；onStoreDocument 防抖 300ms）。 */
  const waitPersisted = async (fid: string, nodeId: string, text: string): Promise<void> => {
    await until(async () => {
      const row = await dataSource.getRepository(FileEntity).findOneByOrFail({ id: fid });
      if (!row.docState || row.docState.length === 0) return false;
      return getNode(docFromState(new Uint8Array(row.docState)), nodeId)?.text === text;
    }, `doc_state persisted: ${text}`);
  };

  beforeAll(async () => {
    app = await createTestApp();
    collab = app.get(CollabService);
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    dataSource = app.get(DataSource);

    const usersMod = await import('../src/users/users.service');
    const filesMod = await import('../src/files/files.service');
    const users = app.get(usersMod.UsersService);
    const files = app.get(filesMod.FilesService);

    const owner = await users.create({ method: 'phone', phone: '13900003001' });
    userId = owner.id;
    token = await tokenFor(userId);

    const mk = async (title: string): Promise<{ file: FileEntity; nodeId: string }> => {
      const created = await files.createForUser(userId, {
        title,
        state: docToState(createTemplateDoc({ title, children: [{ text: '初始节点' }] })),
      });
      const doc = docFromState(created.docState as Buffer);
      return { file: created, nodeId: childrenIds(doc, ROOT_NODE_ID)[0] as string };
    };
    ({ file: fileA, nodeId: nodeIdA } = await mk('窗口文件'));
    ({ file: fileB, nodeId: nodeIdB } = await mk('间隔文件'));
    ({ file: fileC, nodeId: nodeIdC } = await mk('卸载文件'));
    fileD = (await mk('清理文件')).file;
  });

  afterAll(async () => {
    for (const c of [...openClients]) await closeClient(c);
    await app.close();
  });

  it('快照：编辑落库后过 3 分钟窗口落 auto 版本行（注入时钟直调）', async () => {
    const client = await connectSynced(fileA.id, token);
    markLastEditor(client.provider.document, userId); // createdBy 断言的编辑人标记（M3a 口径）
    setText(client.provider.document, nodeIdA, '快照编辑文本');
    await waitPersisted(fileA.id, nodeIdA, '快照编辑文本');
    // 落库（防抖后 storeDocument）不等于快照：真实时钟在 3 分钟窗口内，尚无版本行
    expect(await versionRows(fileA.id)).toHaveLength(0);

    // 直调快照入口（public，供 e2e 注入时钟）：+4min 越过窗口且 dirty → 落行
    const due = await collab.snapshotIfDue(fileA.id, Date.now() + 4 * 60 * 1000);
    expect(due).toBe(true);
    const rows = await versionRows(fileA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('auto');
    expect(rows[0].nodeCount).toBe(1); // 编辑后节点数（可达活跃口径，root 不计）
    expect(rows[0].createdBy).toBe(userId);
    expect(rows[0].restoredFrom).toBeNull();
    expect(rows[0].state.length).toBeGreaterThan(0); // Yjs 状态已编码
    await closeClient(client);
  });

  it('快照：无变更不落行；间隔内不重复落', async () => {
    const client = await connectSynced(fileB.id, token);
    // 无变更（dirty=false）：时钟即便远超窗口也不落行（FR-VER-001「有变更才写」）
    expect(await collab.snapshotIfDue(fileB.id, Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(await versionRows(fileB.id)).toHaveLength(0);

    // 编辑置脏 → 落库后仍无行（真实时钟窗口内）；注入 +2min（< 3min 窗口）→ 间隔门拦截
    setText(client.provider.document, nodeIdB, '间隔内编辑');
    await waitPersisted(fileB.id, nodeIdB, '间隔内编辑');
    expect(await versionRows(fileB.id)).toHaveLength(0);
    expect(await collab.snapshotIfDue(fileB.id, Date.now() + 2 * 60 * 1000)).toBe(false);
    expect(await versionRows(fileB.id)).toHaveLength(0);
    await closeClient(client);
  });

  it('快照：卸载时脏文档落行（snapshotIfDirty）', async () => {
    const client = await connectSynced(fileC.id, token);
    markLastEditor(client.provider.document, userId);
    setText(client.provider.document, nodeIdC, '卸载兜底编辑');
    await waitPersisted(fileC.id, nodeIdC, '卸载兜底编辑');
    expect(await versionRows(fileC.id)).toHaveLength(0); // 窗口内：storeDocument 不落快照

    await closeClient(client); // 最后一条连接断开 → unloadImmediately → beforeUnloadDocument
    // 快照行在 beforeUnloadDocument 内落（documents.delete 之前），行出现即卸载兜底已执行；
    // 不以 getDocumentsCount()===0 判定——那是全局计数，其他用例的存活文档会干扰。
    await until(async () => (await versionRows(fileC.id)).length === 1, 'unload snapshot row');

    const rows = await versionRows(fileC.id);
    expect(rows).toHaveLength(1); // 恰一行：卸载兜底不看间隔，但只落一次
    expect(rows[0].type).toBe('auto');
    expect(rows[0].createdBy).toBe(userId);
    expect(rows[0].nodeCount).toBe(1);

    // 卸载收尾后 meta 已清、文档不在内存：再调快照入口不落行（无泄漏、无重复行）
    expect(await collab.snapshotIfDue(fileC.id, Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(await collab.snapshotIfDirty(fileC.id, Date.now() + 10 * 60 * 1000)).toBe(false);
    expect(await versionRows(fileC.id)).toHaveLength(1);
  });

  it('清理：90 天前版本行删除、保留期内保留', async () => {
    const cleanup = app.get((await import('../src/jobs/cleanup.service')).CleanupService);
    const versionRepo = dataSource.getRepository(VersionEntity);
    const insert = async (createdAt: Date): Promise<void> => {
      const row = versionRepo.create();
      row.id = ulid();
      row.fileId = fileD.id;
      row.nodeCount = 1;
      row.createdBy = userId;
      row.type = 'auto';
      row.state = Buffer.from('快照状态');
      row.createdAt = createdAt;
      row.restoredFrom = null;
      await versionRepo.save(row);
    };
    await insert(new Date(Date.now() - 91 * DAY_MS)); // 越过 90 天 → 应删
    await insert(new Date(Date.now() - 89 * DAY_MS)); // 保留期内 → 应留

    const res = await cleanup.runCleanup(new Date());
    expect(res).toEqual({ purged: 0, reminded: 0, versionsPurged: 1 });

    const rows = await versionRows(fileD.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(Date.now() - 90 * DAY_MS);
  });
});
