import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { WebSocket as WsImpl } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { HocuspocusProviderConfiguration } from '@hocuspocus/provider';
import {
  ROOT_NODE_ID,
  childrenIds,
  createTemplateDoc,
  deleteNodes,
  docFromState,
  docToState,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
import { CommentEntity } from '../src/comments/comment.entity';
import { EventEntity } from '../src/events/event.entity';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';

/**
 * 评论域 E2E — M3b Task 6（FR-CMT-001/003）。
 *
 * 端点：GET/POST /api/files/:id/comments、POST /api/files/:id/comments/:commentId/replies
 * （均 canAccess → owner 或协作者；无权限/文件不存在同口径 404 不泄露存在性）。
 *
 * 语义裁定（binding）：
 * - 创建评论：节点必须存在于当前 docState（getNode !== null 且未墓碑）→ 否则 400
 *   「节点不存在或已删除」；nodeTextSnapshot = 创建时节点文本（≤500 截断），存储后
 *   不随节点编辑/删除变化；
 * - 楼中楼：回复一律挂到所在线程的楼主行（reply-to-reply 拍平到顶层祖先）；
 * - 回复不做节点存在性校验——讨论不随节点死亡终止（已删节点线程仍可回复）；
 * - 节点删除后：线程 nodeDeleted=true、全文保留，counts 不含已删节点；
 * - mentions 归一化：过滤为该文件 owner+协作者集合内的 userId（去重、保序），JSON 存储；
 * - 创建/回复成功后广播 stateless {type:'comment-updated'} 给该文件在线客户端。
 */
describe('评论域（FR-CMT-001/003）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownerToken: string;
  let collaboratorToken: string;
  let outsiderToken: string;
  let owner: { id: string; nickname: string };
  let collaborator: { id: string; nickname: string };
  let fileId: string;
  let nodeIdA: string;
  let nodeIdB: string;
  let nodeIdC: string;

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    app = await createTestApp();
    // 广播用例需要真实 WS 连接：与 collab.e2e-spec 同款接线（listen(0) 随机端口）
    await app.listen(0);
    dataSource = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const files = app.get((await import('../src/files/files.service')).FilesService);
    owner = await users.create({ method: 'phone', phone: '13900006001' });
    collaborator = await users.create({ method: 'phone', phone: '13900006002' });
    const outsider = await users.create({ method: 'phone', phone: '13900006003' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const created = await files.createForUser(owner.id, {
      title: '评论文件',
      state: docToState(
        createTemplateDoc({
          title: '评论文件',
          children: [{ text: '节点A' }, { text: '节点B' }, { text: '节点C' }],
        }),
      ),
    });
    fileId = created.id;
    const doc = docFromState(created.docState as Buffer);
    [nodeIdA, nodeIdB, nodeIdC] = childrenIds(doc, ROOT_NODE_ID) as [string, string, string];

    const collabRow = dataSource.getRepository(FileCollaboratorEntity).create();
    collabRow.fileId = fileId;
    collabRow.userId = collaborator.id;
    collabRow.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collabRow);
  });

  afterAll(async () => {
    await app.close();
  });

  it('创建评论：快照/作者/形状落对，DB 行正确，counts 计入', async () => {
    const res = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '这个分支再想想',
    });
    expect(res.status).toBe(201);
    // 视图契约（与 GET threads 条目同形）：楼主视图含 replies
    expect(Object.keys(res.body).sort()).toEqual(
      ['author', 'content', 'createdAt', 'fileId', 'id', 'mentions', 'nodeDeleted', 'nodeId', 'nodeTextSnapshot', 'replies'].sort(),
    );
    expect(res.body.fileId).toBe(fileId);
    expect(res.body.nodeId).toBe(nodeIdA);
    expect(res.body.nodeTextSnapshot).toBe('节点A'); // 创建时快照
    expect(res.body.nodeDeleted).toBe(false);
    expect(res.body.author).toEqual({ id: collaborator.id, nickname: collaborator.nickname });
    expect(res.body.content).toBe('这个分支再想想');
    expect(res.body.mentions).toEqual([]);
    expect(Number.isNaN(Date.parse(res.body.createdAt))).toBe(false);
    expect(res.body.replies).toEqual([]);

    const row = await dataSource.getRepository(CommentEntity).findOneByOrFail({ id: res.body.id });
    expect(row.fileId).toBe(fileId);
    expect(row.nodeId).toBe(nodeIdA);
    expect(row.nodeTextSnapshot).toBe('节点A');
    expect(row.parentId).toBeNull();
    expect(row.authorId).toBe(collaborator.id);
    expect(row.content).toBe('这个分支再想想');
    expect(row.status).toBe('open');

    const list = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    expect(list.status).toBe(200);
    expect(Object.keys(list.body).sort()).toEqual(['counts', 'threads']);
    expect(list.body.threads).toHaveLength(1);
    expect(list.body.threads[0].id).toBe(res.body.id);
    expect(list.body.counts).toEqual({ [nodeIdA]: 1 });
  });

  it('content 边界：501 字 → 400；空串 → 400', async () => {
    const tooLong = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: 'x'.repeat(501),
    });
    expect(tooLong.status).toBe(400);
    expect((await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({ nodeId: nodeIdA, content: '' })).status).toBe(400);
    // 500 字整恰好放行（不落库断言，仅边界语义）——用 DB 行数不增长的旁证：上面两次均 400
    const ok = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: 'y'.repeat(500),
    });
    expect(ok.status).toBe(201);
  });

  it('节点不存在/已墓碑 → 400「节点不存在或已删除」；root 中心主题可评论', async () => {
    const ghost = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: '01AAAAAAAAAAAAAAAAAAAAAAAAAA',
      content: '幽灵节点',
    });
    expect(ghost.status).toBe(400);
    expect(ghost.body.message).toBe('节点不存在或已删除');

    const root = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: ROOT_NODE_ID,
      content: '整体讨论',
    });
    expect(root.status).toBe(201);
    expect(root.body.nodeTextSnapshot).toBe('评论文件'); // root 文本 = 文档标题

    const list = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    expect(list.body.counts).toEqual({ [nodeIdA]: 2, [ROOT_NODE_ID]: 1 }); // A 已有 1+边界用例 1
  });

  it('无权 404：非协作者 GET/POST/回复 与 不存在文件 同口径「文件不存在」', async () => {
    const got = await authed(outsiderToken, 'get', `/api/files/${fileId}/comments`);
    expect(got.status).toBe(404);
    expect(got.body.message).toBe('文件不存在');

    const posted = await authed(outsiderToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '我是外人',
    });
    expect(posted.status).toBe(404);
    expect(posted.body.message).toBe('文件不存在');

    const missing = await authed(ownerToken, 'get', '/api/files/01AAAAAAAAAAAAAAAAAAAAAAAAAA/comments');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('文件不存在');
  });

  it('楼中楼：回复时间正序；reply-to-reply 拍平到楼主；回复不存在 404', async () => {
    const thread = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdB,
      content: 'B 线程楼主',
    });
    expect(thread.status).toBe(201);
    const threadId = thread.body.id as string;

    await sleep(5); // datetime(3) 同毫秒去歧义：回复时间正序断言需要可区分的时戳
    const r1 = await authed(ownerToken, 'post', `/api/files/${fileId}/comments/${threadId}/replies`).send({ content: 'first' });
    expect(r1.status).toBe(201);
    // 回复视图：与楼主条目同形但不含 replies
    expect(Object.keys(r1.body).sort()).toEqual(
      ['author', 'content', 'createdAt', 'fileId', 'id', 'mentions', 'nodeDeleted', 'nodeId', 'nodeTextSnapshot'].sort(),
    );
    expect(r1.body.nodeId).toBe(nodeIdB);
    expect(r1.body.nodeTextSnapshot).toBe('节点B'); // 继承楼主快照
    await sleep(5);
    await authed(ownerToken, 'post', `/api/files/${fileId}/comments/${threadId}/replies`).send({ content: 'second' });
    await sleep(5);
    const r3 = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments/${threadId}/replies`).send({ content: 'third' });
    expect(r3.status).toBe(201);
    await sleep(5);

    // 楼中楼：回复再回复 → 拍平挂到楼主（线程根），不产生嵌套 parent
    const r4 = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments/${r3.body.id}/replies`).send({ content: 'fourth' });
    expect(r4.status).toBe(201);
    const r4Row = await dataSource.getRepository(CommentEntity).findOneByOrFail({ id: r4.body.id });
    expect(r4Row.parentId).toBe(threadId); // 顶层祖先，而非 r3

    const list = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    const t = list.body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.replies.map((x: { content: string }) => x.content)).toEqual(['first', 'second', 'third', 'fourth']);
    const times = t.replies.map((x: { createdAt: string }) => x.createdAt);
    expect([...times].sort()).toEqual(times); // created_at ASC
    expect(t.replies.every((x: { author: { nickname: string } }) => x.author.nickname.length > 0)).toBe(true);

    const missing = await authed(ownerToken, 'post', `/api/files/${fileId}/comments/01AAAAAAAAAAAAAAAAAAAAAAAAAA/replies`).send({
      content: '回复不存在',
    });
    expect(missing.status).toBe(404);

    const list2 = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    expect(list2.body.counts).toEqual({ [nodeIdA]: 2, [ROOT_NODE_ID]: 1, [nodeIdB]: 5 }); // 楼主+4 回复
  });

  it('节点删除：线程 nodeDeleted=true 保留全文，counts 不含已删节点，回复仍可（讨论不终止）', async () => {
    const cThread = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdC,
      content: '节点C的讨论',
    });
    expect(cThread.status).toBe(201);
    expect(cThread.body.nodeTextSnapshot).toBe('节点C');
    await sleep(5);
    const cReply = await authed(ownerToken, 'post', `/api/files/${fileId}/comments/${cThread.body.id}/replies`).send({ content: 'C 上第一条回复' });
    expect(cReply.status).toBe(201);

    // 用 core deleteNodes 修改 docState（去掉节点C）经 PUT 落库——doc 内删节点，非软删文件
    const docStateRes = await authed(ownerToken, 'get', `/api/files/${fileId}`); // 文件内容端点：取当前 docState
    expect(docStateRes.status).toBe(200);
    const doc = docFromState(new Uint8Array(Buffer.from(docStateRes.body.docState, 'base64')));
    deleteNodes(doc, [nodeIdC]);
    const put = await authed(ownerToken, 'put', `/api/files/${fileId}/doc-state`).send({
      docState: Buffer.from(docToState(doc)).toString('base64'),
    });
    expect(put.status).toBe(200);

    const list = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    const t = list.body.threads.find((x: { id: string }) => x.id === cThread.body.id);
    expect(t.nodeDeleted).toBe(true); // 节点已不在当前 doc 存活集
    expect(t.nodeTextSnapshot).toBe('节点C'); // 快照不随之清空
    expect(t.content).toBe('节点C的讨论'); // 全文保留
    expect(t.replies).toHaveLength(1);
    expect(t.replies[0].content).toBe('C 上第一条回复');
    expect(t.replies[0].nodeDeleted).toBe(true);

    // counts 不含已删节点；A/root/B 不受影响
    expect(Object.keys(list.body.counts).sort()).toEqual([nodeIdA, nodeIdB, ROOT_NODE_ID].sort());
    expect(list.body.counts[nodeIdA]).toBe(2);
    expect(list.body.counts[nodeIdB]).toBe(5);

    // 已删节点上不能新建评论
    const again = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdC,
      content: '节点已删',
    });
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('节点不存在或已删除');

    // 但已删节点的线程仍可回复（binding 裁定：讨论不随节点死亡终止）
    const keepTalking = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments/${cThread.body.id}/replies`).send({
      content: '节点没了也能聊',
    });
    expect(keepTalking.status).toBe(201);
    expect(keepTalking.body.nodeDeleted).toBe(true);
    const counts = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    expect(counts.body.counts[nodeIdC]).toBeUndefined();
  });

  it('mentions 归一化：混入非协作者 → 存储仅含 owner+协作者（保序去重，JSON 落库）', async () => {
    const res = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '@ 一下相关人',
      // 混入：非协作者的陌生 ULID、幽灵 id、重复输入——全部被归一化剔除
      mentions: [collaborator.id, '01AAAAAAAAAAAAAAAAAAAAAAAAAA', owner.id, collaborator.id],
    });
    expect(res.status).toBe(201);
    const expected = [collaborator.id, owner.id]; // 输入保序过滤 + 去重：协作者在前、owner 在后
    expect(res.body.mentions).toEqual(expected);

    const row = await dataSource.getRepository(CommentEntity).findOneByOrFail({ id: res.body.id });
    expect(JSON.parse(row.mentions as string)).toEqual(expected); // JSON 文本列

    const list = await authed(ownerToken, 'get', `/api/files/${fileId}/comments`);
    const t = list.body.threads.find((x: { id: string }) => x.id === res.body.id);
    expect(t.mentions).toEqual(expected);
    expect(list.body.counts[nodeIdA]).toBe(3); // 2 + 本条
  });

  it('广播：REST 创建/回复 → 在线 provider 客户端收到 stateless {type:"comment-updated"}；无人在线 no-op 不抛', async () => {
    const files = app.get((await import('../src/files/files.service')).FilesService);
    const created = await files.createForUser(owner.id, {
      title: '广播文件',
      state: docToState(createTemplateDoc({ title: '广播文件', children: [{ text: '广播节点' }] })),
    });
    const nodeId2 = childrenIds(docFromState(created.docState as Buffer), ROOT_NODE_ID)[0] as string;
    const port = (app.getHttpServer().address() as AddressInfo).port;

    const provider = new HocuspocusProvider({
      url: `ws://127.0.0.1:${port}/collab`,
      name: created.id,
      token: ownerToken,
      WebSocketPolyfill: WsImpl,
    } as HocuspocusProviderConfiguration);
    const payloads: string[] = [];
    provider.on('stateless', (p: { payload: string }) => payloads.push(p.payload));
    const until = async (pred: () => boolean, label: string, ms = 8000): Promise<void> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`condition not met: ${label}`);
    };
    try {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !provider.isSynced) await new Promise((r) => setTimeout(r, 50));
      expect(provider.isSynced).toBe(true);

      const typed = (): string[] =>
        payloads
          .map((p) => { try { return (JSON.parse(p) as { type?: string }).type ?? ''; } catch { return ''; } })
          .filter((t) => t === 'comment-updated');

      const comment = await authed(ownerToken, 'post', `/api/files/${created.id}/comments`).send({
        nodeId: nodeId2,
        content: '广播一条评论',
      });
      expect(comment.status).toBe(201);
      await until(() => typed().length >= 1, 'comment-updated on create');

      await authed(ownerToken, 'post', `/api/files/${created.id}/comments/${comment.body.id}/replies`).send({ content: '广播一条回复' });
      await until(() => typed().length >= 2, 'comment-updated on reply');
    } finally {
      provider.destroy();
    }

    // 无人在线：广播 no-op，创建照常成功（不抛错）
    const quiet = await authed(ownerToken, 'post', `/api/files/${created.id}/comments`).send({
      nodeId: nodeId2,
      content: '无人在线',
    });
    expect(quiet.status).toBe(201);
  });

  // ---------- comment_create 埋点（M5 Task 4，PRD 6.4：是否 @提及） ----------

  it('埋点：创建评论/回复落 comment_create 行，hasMention 按归一化后 mentions 判定', async () => {
    const eventsRepo = dataSource.getRepository(EventEntity);
    // 该文件的 comment_create 行，按 id（ULID 单调）新→旧；本用例以「前后行数差 + 最新行
    // payload」断言——此前用例已在同一文件落过多条评论，不能假设节点维度为空。
    const latestPayload = async (offset = 0): Promise<{ hasMention: boolean; nodeId: string }> => {
      const rows = await eventsRepo.find({ where: { type: 'comment_create', fileId }, order: { id: 'DESC' } });
      const p = JSON.parse(rows[offset].payload ?? '{}') as { hasMention?: boolean; nodeId?: string };
      return { hasMention: p.hasMention === true, nodeId: p.nodeId as string };
    };
    const rowCount = async (): Promise<number> =>
      eventsRepo.countBy({ type: 'comment_create', fileId });
    const before = await rowCount();

    // 无 mentions → hasMention:false（nodeIdA/B 全程存活；nodeIdC 已被前序用例墓碑删除）
    const plain = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdB,
      content: '无提及评论',
    });
    expect(plain.status).toBe(201);
    expect(await rowCount()).toBe(before + 1);
    expect(await latestPayload()).toEqual({ hasMention: false, nodeId: nodeIdB });

    // @owner → hasMention:true（归一化后非空）
    const withMention = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '提及评论',
      mentions: [owner.id],
    });
    expect(withMention.status).toBe(201);
    expect(await latestPayload()).toEqual({ hasMention: true, nodeId: nodeIdA });

    // 回复同样是发布评论：落行（楼中楼挂 nodeIdA 线程，无提及 → hasMention:false）
    const reply = await authed(ownerToken, 'post', `/api/files/${fileId}/comments/${withMention.body.id}/replies`).send({ content: '回复一条' });
    expect(reply.status).toBe(201);
    expect(await rowCount()).toBe(before + 3);
    expect(await latestPayload()).toEqual({ hasMention: false, nodeId: nodeIdA });
  });
});
