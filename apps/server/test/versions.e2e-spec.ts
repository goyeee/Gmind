import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket as WsImpl } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import { DataSource } from 'typeorm';
import { ulid } from 'ulid';
import request from 'supertest';
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
import { EventEntity } from '../src/events/event.entity';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
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

/**
 * 版本恢复（M4 Task 7，FR-VER-004）：REST 列表/取态/恢复 + events 埋点通道。
 * - live 路径：provider 在线 → 恢复写内存 doc（y-sync 自动广播）→ pre_restore 行先落；
 * - 离线路径：无人在线 → file.docState 上恢复 → files.docState/node_count 同步回写；
 * - 权限：读=canAccess（owner/协作者），恢复=owner/editor，越权与不存在同口径 404；
 * - events：POST /api/events 登录即可（204 落库），未登录 401。
 * 各用例独立文件（与上一 describe 的行断言互不串扰；app 自建自清）。
 */
describe('版本恢复（REST FR-VER-004）+ events 埋点端点', () => {
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let dataSource: DataSource;
  let port: number;
  let owner: { id: string; token: string };
  let editor: { id: string; token: string };
  let viewer: { id: string; token: string };
  let outsider: { id: string; token: string };
  const openClients: { provider: HocuspocusProvider }[] = [];

  /** 直接经 SessionService 签发 token（collab.e2e-spec.ts 同款）。 */
  const tokenFor = async (uid: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(uid, false)).token;
  };

  /** 断言轮询：条件成立或超时（y-sync 广播/落库防抖都是异步的）。 */
  async function until(pred: () => boolean | Promise<boolean>, label: string, ms = 8000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`condition not met: ${label}`);
  }

  const filesRepo = (): import('typeorm').Repository<FileEntity> => dataSource.getRepository(FileEntity);
  const versionsRepo = (): import('typeorm').Repository<VersionEntity> => dataSource.getRepository(VersionEntity);
  const eventsRepo = (): import('typeorm').Repository<EventEntity> => dataSource.getRepository(EventEntity);

  const versionRows = (fid: string): Promise<VersionEntity[]> =>
    versionsRepo().find({ where: { fileId: fid }, order: { createdAt: 'ASC' } });

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
    client.provider.destroy();
  };

  /** 等待一次编辑落库（doc_state 反序列化后含该文本；onStoreDocument 防抖 300ms）。 */
  const waitPersisted = async (fid: string, nodeId: string, text: string): Promise<void> => {
    await until(async () => {
      const row = await filesRepo().findOneByOrFail({ id: fid });
      if (!row.docState || row.docState.length === 0) return false;
      return getNode(docFromState(new Uint8Array(row.docState)), nodeId)?.text === text;
    }, `doc_state persisted: ${text}`);
  };

  /** 按文本查存活节点 id（排除 root 与墓碑）——重建节点以新 ULID 落地，断言按文本口径。 */
  const findAliveByText = (doc: Y.Doc, text: string): string | null => {
    for (const [id, node] of doc.getMap('nodes').entries()) {
      const n = node as Y.Map<unknown>;
      if (id !== ROOT_NODE_ID && n.get('deleted') !== true && n.get('text') === text) return id;
    }
    return null;
  };

  /** 建文件（初始 doc 含一个文本节点）+ 直插该初始状态的 manual 版本行。 */
  const mkFileWithVersion = async (
    title: string,
    earlyText: string,
  ): Promise<{ file: FileEntity; nodeId: string; versionId: string; earlyState: Uint8Array }> => {
    const earlyState = docToState(createTemplateDoc({ title, children: [{ text: earlyText }] }));
    const created = await (app.get((await import('../src/files/files.service')).FilesService) as import('../src/files/files.service').FilesService).createForUser(owner.id, { title, state: earlyState });
    const doc = docFromState(created.docState as Buffer);
    const nodeId = childrenIds(doc, ROOT_NODE_ID)[0] as string;
    const row = versionsRepo().create();
    row.id = ulid();
    row.fileId = created.id;
    row.nodeCount = 1;
    row.createdBy = owner.id;
    row.type = 'manual';
    row.state = Buffer.from(earlyState);
    row.createdAt = new Date();
    row.restoredFrom = null;
    await versionsRepo().save(row);
    return { file: created, nodeId, versionId: row.id, earlyState };
  };

  const addCollaborator = async (fid: string, uid: string, role: 'editor' | 'viewer'): Promise<void> => {
    const row = dataSource.getRepository(FileCollaboratorEntity).create();
    row.fileId = fid;
    row.userId = uid;
    row.role = role;
    await dataSource.getRepository(FileCollaboratorEntity).save(row);
  };

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
    dataSource = app.get(DataSource);

    const usersMod = await import('../src/users/users.service');
    const users = app.get(usersMod.UsersService);
    const mk = async (phone: string): Promise<{ id: string; token: string }> => {
      const u = await users.create({ method: 'phone', phone });
      return { id: u.id, token: await tokenFor(u.id) };
    };
    owner = await mk('13900004001');
    editor = await mk('13900004002');
    viewer = await mk('13900004003');
    outsider = await mk('13900004004');
  });

  afterAll(async () => {
    for (const c of [...openClients]) await closeClient(c);
    await app.close();
  });

  it('恢复：live 文档——REST 恢复后 WS 在线端收到回滚内容（恢复广播）', async () => {
    const { file, nodeId, versionId } = await mkFileWithVersion('恢复-live', '早期文本');
    const client = await connectSynced(file.id, owner.token);
    markLastEditor(client.provider.document, owner.id);
    setText(client.provider.document, nodeId, '漂移文本');
    await waitPersisted(file.id, nodeId, '漂移文本');

    const res = await request(app.getHttpServer())
      .post(`/api/files/${file.id}/versions/${versionId}/restore`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.preRestoreVersionId).toBe('string');

    // y-sync 广播有传输延迟 → 轮询在线端 doc 内容回到早期状态
    await until(() => getNode(client.provider.document, nodeId)?.text === '早期文本', 'live 回滚广播');

    // pre_restore 行先于恢复落行：type/restoredFrom/createdBy/state=恢复前状态
    const pre = (await versionRows(file.id)).find((r) => r.id === res.body.preRestoreVersionId);
    expect(pre).toBeDefined();
    expect(pre!.type).toBe('pre_restore');
    expect(pre!.restoredFrom).toBe(versionId);
    expect(pre!.createdBy).toBe(owner.id);
    expect(getNode(docFromState(new Uint8Array(pre!.state)), nodeId)?.text).toBe('漂移文本');

    // files.docState 随防抖落库为恢复后内容（storeDocument 钩子照常走）
    await waitPersisted(file.id, nodeId, '早期文本');

    // version_restore 事件已落 events 表
    const ev = await eventsRepo().findOneBy({ type: 'version_restore', fileId: file.id });
    expect(ev).not.toBeNull();
    expect(ev!.userId).toBe(owner.id);

    await closeClient(client);
  });

  it('恢复：无人在线——走落库路径，GET /api/files/:id 的 docState 与快照一致', async () => {
    const { file, versionId } = await mkFileWithVersion('恢复-offline', '早期文本二');
    // 无人连接：直接改落库态模拟离线编辑已保存
    const modified = docToState(createTemplateDoc({ title: '恢复-offline', children: [{ text: '离线漂移' }] }));
    await filesRepo().update(file.id, { docState: Buffer.from(modified), nodeCount: 1 });

    const res = await request(app.getHttpServer())
      .post(`/api/files/${file.id}/versions/${versionId}/restore`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);

    // 落库路径同步回写：GET /api/files/:id 的 docState 与快照一致（docFromState 比对文本；
    // 快照中被删节点以新 ULID 重建，故按文本而非旧 id 断言）
    const view = await request(app.getHttpServer())
      .get(`/api/files/${file.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(view.status).toBe(200);
    const doc = docFromState(new Uint8Array(Buffer.from(view.body.docState as string, 'base64')));
    expect(findAliveByText(doc, '早期文本二')).not.toBeNull();

    // pre_restore 行 state = 恢复前的 file.docState 原值（离线漂移态）
    const pre = (await versionRows(file.id)).find((r) => r.id === res.body.preRestoreVersionId);
    expect(pre).toBeDefined();
    expect(pre!.type).toBe('pre_restore');
    expect(pre!.restoredFrom).toBe(versionId);
    expect(findAliveByText(docFromState(new Uint8Array(pre!.state)), '离线漂移')).not.toBeNull();
  });

  it('恢复权限：非 owner/editor 404；未登录 401；版本 id 属其他文件 404', async () => {
    const { file, versionId } = await mkFileWithVersion('恢复-权限', '早期文本三');
    const other = await mkFileWithVersion('恢复-其他文件', '其他早期文本');
    await addCollaborator(file.id, editor.id, 'editor');
    await addCollaborator(file.id, viewer.id, 'viewer');
    const restoreUrl = `/api/files/${file.id}/versions/${versionId}/restore`;

    // 一期角色集：editor 协作者可恢复（canAccess 与 restore 判定分离）
    const resEditor = await request(app.getHttpServer())
      .post(restoreUrl)
      .set('Authorization', `Bearer ${editor.token}`);
    expect(resEditor.status).toBe(200);
    expect(typeof resEditor.body.preRestoreVersionId).toBe('string');

    // viewer 协作者 / 路人：404 与「不存在」同口径（不泄露文件存在性）
    const resViewer = await request(app.getHttpServer())
      .post(restoreUrl)
      .set('Authorization', `Bearer ${viewer.token}`);
    expect(resViewer.status).toBe(404);
    const resOutsider = await request(app.getHttpServer())
      .post(restoreUrl)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(resOutsider.status).toBe(404);

    // 未登录 401
    const resAnon = await request(app.getHttpServer()).post(restoreUrl);
    expect(resAnon.status).toBe(401);

    // 版本 id 属其他文件 404；不存在的版本 404
    const resForeign = await request(app.getHttpServer())
      .post(`/api/files/${file.id}/versions/${other.versionId}/restore`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(resForeign.status).toBe(404);
    const resMissing = await request(app.getHttpServer())
      .post(`/api/files/${file.id}/versions/${ulid()}/restore`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(resMissing.status).toBe(404);
  });

  it('列表/取态：canAccess 可读，含 createdByName；其他文件版本 404', async () => {
    const { file, nodeId, versionId, earlyState } = await mkFileWithVersion('恢复-列表', '列表早期文本');
    await addCollaborator(file.id, editor.id, 'editor');

    const resList = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(resList.status).toBe(200);
    expect(resList.body.items).toHaveLength(1);
    const item = resList.body.items[0];
    expect(item.id).toBe(versionId);
    expect(item.type).toBe('manual');
    expect(item.nodeCount).toBe(1);
    expect(item.createdByName).toBeTruthy(); // join users 名字非空
    expect(item.restoredFrom).toBeNull();
    expect(typeof item.createdAt).toBe('string');

    // 协作者（canAccess）同样可读；路人 404
    const resListEditor = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions`)
      .set('Authorization', `Bearer ${editor.token}`);
    expect(resListEditor.status).toBe(200);
    const resListOutsider = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(resListOutsider.status).toBe(404);
    const resListAnon = await request(app.getHttpServer()).get(`/api/files/${file.id}/versions`);
    expect(resListAnon.status).toBe(401);

    // 取态：state 为 base64，解码后即版本 Yjs 状态（内容比对）
    const resState = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions/${versionId}`)
      .set('Authorization', `Bearer ${editor.token}`);
    expect(resState.status).toBe(200);
    expect(resState.body.id).toBe(versionId);
    const stateDoc = docFromState(new Uint8Array(Buffer.from(resState.body.state as string, 'base64')));
    expect(getNode(stateDoc, nodeId)?.text).toBe('列表早期文本');
    expect(Buffer.from(resState.body.state as string, 'base64').equals(Buffer.from(earlyState))).toBe(true);

    // 其他文件的版本 id → 404（owner 亦不例外）
    const other = await mkFileWithVersion('恢复-列表-其他', '其他文本');
    const resForeign = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions/${other.versionId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(resForeign.status).toBe(404);
  });

  it('列表上限：>200 行只返回最新 200 条（终审修复：列表不取 LONGBLOB state，条数封顶）', async () => {
    const { file } = await mkFileWithVersion('列表-上限', '上限早期文本');
    // 直插 201 行 thin 版本（state 用小 dummy——列表层断言只看元数据与条数）；每行
    // createdAt +1ms 错开且晚于 mkFileWithVersion 的 manual 行，全序确定。nodeCount
    // 作身份标记（第 i 行 → 10+i）：cap 后应恰好留下最新 200 行 = nodeCount 11..210。
    const repo = versionsRepo();
    const base = Date.now() + 1000;
    for (let i = 0; i < 201; i += 1) {
      const row = repo.create();
      row.id = ulid();
      row.fileId = file.id;
      row.nodeCount = 10 + i;
      row.createdBy = owner.id;
      row.type = 'auto';
      row.state = Buffer.from('thin');
      row.createdAt = new Date(base + i);
      row.restoredFrom = null;
      await repo.save(row);
    }

    const res = await request(app.getHttpServer())
      .get(`/api/files/${file.id}/versions`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    // 共 202 行（201 直插 + 1 manual），恰返回最新 200 条且 createdAt DESC：
    // 最老的 manual 行与 nodeCount 10（i=0）被上限裁掉
    const counts = (res.body.items as { nodeCount: number }[]).map((r) => r.nodeCount);
    expect(counts).toHaveLength(200);
    expect(counts).toEqual(Array.from({ length: 200 }, (_, k) => 210 - k));

    // key-set 口径：列表条目只含元数据列，state 绝不出现在列表响应（取态走 getState 唯一出口）
    expect(Object.keys((res.body.items as Record<string, unknown>[])[0]).sort()).toEqual([
      'createdAt',
      'createdByName',
      'id',
      'nodeCount',
      'restoredFrom',
      'type',
    ]);
    for (const item of res.body.items as Record<string, unknown>[]) {
      expect(item).not.toHaveProperty('state');
    }
  });

  it('dev 快照路由（Task 8）：live 脏文档 POST 即落 auto 行；无变更不落', async () => {
    const { file, nodeId } = await mkFileWithVersion('快照路由', '路由早期文本');
    const client = await connectSynced(file.id, owner.token);

    // 经 WS 改文本 → 服务端 onChange 置脏（异步到达：轮询 POST 直至 created=true，
    // 未置脏时路由幂等返回 created=false，无副作用）
    setText(client.provider.document, nodeId, '路由触发文本');
    await until(async () => {
      const res = await request(app.getHttpServer())
        .post(`/api/files/${file.id}/versions/snapshot`)
        .set('Authorization', `Bearer ${owner.token}`);
      return res.status === 200 && res.body.created === true;
    }, 'dev snapshot created:true');

    const rows = await versionRows(file.id);
    expect(rows.some((r) => r.type === 'auto')).toBe(true);
    const countAfterFirst = rows.length;

    // 无变更再触发：dirty 闸收口，不重复落行
    const res2 = await request(app.getHttpServer())
      .post(`/api/files/${file.id}/versions/snapshot`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res2.status).toBe(200);
    expect(res2.body).toEqual({ created: false });
    expect((await versionRows(file.id)).length).toBe(countAfterFirst);

    await closeClient(client);
  });

  it('events 端点：POST /api/events 登录 204 且落库；未登录 401', async () => {
    const { file } = await mkFileWithVersion('events-挂靠文件', 'events 节点');
    const res = await request(app.getHttpServer())
      .post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ type: 'e2e-probe', fileId: file.id, payload: { k: 1 } });
    expect(res.status).toBe(204);

    const row = await eventsRepo().findOneBy({ type: 'e2e-probe' });
    expect(row).not.toBeNull();
    expect(row!.fileId).toBe(file.id);
    expect(row!.userId).toBe(owner.id);
    expect(JSON.parse(row!.payload ?? '{}')).toEqual({ k: 1 });

    const resAnon = await request(app.getHttpServer()).post('/api/events').send({ type: 'e2e-probe' });
    expect(resAnon.status).toBe(401);
  });

  it('events 端点：payload 序列化 >10KB → 400「事件数据过大」（M4 挂账清偿：防 TEXT 64KB 边界 500）', async () => {
    // JSON.stringify 长度 10_013 > 10_000 上界 → 400，文案精确
    const tooBig = await request(app.getHttpServer())
      .post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ type: 'e2e-too-big', payload: { blob: 'x'.repeat(10_001) } });
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.message).toBe('事件数据过大');
    expect(await eventsRepo().countBy({ type: 'e2e-too-big' })).toBe(0);

    // 界内（≤10_000）照常 204 落库
    const within = await request(app.getHttpServer())
      .post('/api/events')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ type: 'e2e-within', payload: { blob: 'y'.repeat(9_900) } });
    expect(within.status).toBe(204);
    expect(await eventsRepo().countBy({ type: 'e2e-within' })).toBe(1);
  });
});
