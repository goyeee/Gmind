import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as http from 'node:http';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import { docFromState, docToState, createTemplateDoc, childrenIds, ROOT_NODE_ID } from '@gmind/core';
import { createTestApp } from './support/app-test';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
import { NotificationEntity } from '../src/notifications/notification.entity';

/**
 * 站内通知域 E2E — M3b Task 8（FR-CMT-005）。
 *
 * 端点：GET /api/files/:id/collaborators（mention 候选）、GET /api/notify（SSE 实时推送）、
 * GET /api/notifications、POST /api/notifications/:id/read、GET /api/notifications/unread-count。
 *
 * 语义裁定（binding）：
 * - SSE 鉴权：GET /api/notify?token= 接受 query 参数（EventSource 无法携带自定义
 *   header；与 WS 升级 ?token= 同口径），会话无效 401；
 * - 评论 @mention → 被提及的 owner/协作者收到 type='mention' 通知 + SSE 事件；
 *   commenter 自己提及自己不产生；mentions 混入非协作者被过滤不产生；
 * - 回复 → 线程楼主收到 type='reply' 通知（replier==楼主 除外）；
 * - payload 形状：{fileId, title, commenterId, commenterName, content(≤100), nodeId}；
 * - 已读：POST :id/read → {ok:true} → unread-count 清零。
 *
 * SSE 断言：用 node:http 原生长连接读流（supertest 会等 response end 而 SSE 永不结束）。
 */
describe('站内通知（FR-CMT-005）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let port: number;
  let ownerToken: string;
  let collaboratorToken: string;
  let outsiderToken: string;
  let owner: { id: string; nickname: string };
  let collaborator: { id: string; nickname: string };
  let outsider: { id: string; nickname: string };
  let fileId: string;
  let nodeIdA: string;

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  type Method = 'get' | 'post' | 'put';
  const authed = (token: string, method: Method, url: string) =>
    request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

  /** 原生 http 打开 SSE 长连接：ready 在响应头到达时 resolve（握手完成），
   *  状态/头由测试体断言（不在回调里 expect，防 unhandled error 噪音）。 */
  function openSse(token: string): {
    status: () => number | undefined;
    contentType: () => string | undefined;
    text: () => string;
    ready: Promise<void>;
    close: () => void;
  } {
    let buf = '';
    let resolveReady: (() => void) | null = null;
    let status: number | undefined;
    let contentType: string | undefined;
    const ready = new Promise<void>((r) => {
      resolveReady = r;
    });
    const req = http.get({ host: '127.0.0.1', port, path: `/api/notify?token=${token}` }, (res) => {
      status = res.statusCode;
      contentType = res.headers['content-type'];
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
      });
      res.on('end', () => resolveReady?.());
    });
    req.on('error', () => undefined); // close 时 destroy 的正常噪音
    req.on('response', () => resolveReady?.());
    return {
      status: () => status,
      contentType: () => contentType,
      text: () => buf,
      ready: ready as unknown as Promise<void>,
      close: () => req.destroy(),
    };
  }

  /** 轮询直到 SSE 流文本中出现期望子串（推送异步到达）。 */
  const waitForSse = async (sse: { text: () => string }, needle: string): Promise<string> => {
    for (let i = 0; i < 100; i++) {
      const text = sse.text();
      if (text.includes(needle)) return text;
      await new Promise((r) => setTimeout(r, 50));
    }
    return sse.text();
  };

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    dataSource = app.get(DataSource);
    port = (app.getHttpServer().address() as AddressInfo).port;

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const files = app.get((await import('../src/files/files.service')).FilesService);
    owner = await users.create({ method: 'phone', phone: '13900007001' });
    collaborator = await users.create({ method: 'phone', phone: '13900007002' });
    outsider = await users.create({ method: 'phone', phone: '13900007003' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const created = await files.createForUser(owner.id, {
      title: '通知文件',
      state: docToState(createTemplateDoc({ title: '通知文件', children: [{ text: '节点A' }] })),
    });
    fileId = created.id;
    const doc = docFromState(created.docState as Buffer);
    [nodeIdA] = childrenIds(doc, ROOT_NODE_ID) as [string];

    const collabRow = dataSource.getRepository(FileCollaboratorEntity).create();
    collabRow.fileId = fileId;
    collabRow.userId = collaborator.id;
    collabRow.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collabRow);
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/files/:id/collaborators：owner + 协作者候选（nickname/isOwner），无权限 404', async () => {
    const res = await authed(ownerToken, 'get', `/api/files/${fileId}/collaborators`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body).toEqual(
      expect.arrayContaining([
        { userId: owner.id, nickname: owner.nickname, role: 'owner', isOwner: true },
        { userId: collaborator.id, nickname: collaborator.nickname, role: 'editor', isOwner: false },
      ]),
    );
    // 协作者同口径可见（canAccess）；路人 404 不泄露存在性
    const asCollaborator = await authed(collaboratorToken, 'get', `/api/files/${fileId}/collaborators`);
    expect(asCollaborator.status).toBe(200);
    const asOutsider = await authed(outsiderToken, 'get', `/api/files/${fileId}/collaborators`);
    expect(asOutsider.status).toBe(404);
  });

  it('SSE：token 缺失/无效 → 401（JSON 而非流）', async () => {
    const noToken = await request(app.getHttpServer()).get('/api/notify');
    expect(noToken.status).toBe(401);
    const badToken = await request(app.getHttpServer()).get('/api/notify?token=invalid-token');
    expect(badToken.status).toBe(401);
  });

  it('A 评论 @B（B 协作者）→ B 行 + unread-count 1 + SSE 事件到达', async () => {
    const sse = openSse(collaboratorToken);
    // 等 SSE 握手完成（响应头到达）再触发，避免连接晚于推送漏收
    await sse.ready;
    expect(sse.status()).toBe(200);
    expect(sse.contentType()).toContain('text/event-stream');

    const res = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '这一支请你把把关',
      mentions: [collaborator.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.mentions).toEqual([collaborator.id]);

    // SSE 事件：{id,type,payload,createdAt}
    const text = await waitForSse(sse, '"type":"mention"');
    const dataLine = text.split('\n').find((l) => l.startsWith('data: ') && l.includes('"type":"mention"'));
    expect(dataLine).toBeTruthy();
    const event = JSON.parse((dataLine as string).slice('data: '.length)) as {
      id: string;
      type: string;
      payload: Record<string, unknown>;
      createdAt: string;
    };
    expect(event.type).toBe('mention');
    expect(Number.isNaN(Date.parse(event.createdAt))).toBe(false);
    expect(event.payload).toEqual({
      fileId,
      title: '通知文件',
      commenterId: owner.id,
      commenterName: owner.nickname,
      content: '这一支请你把把关',
      nodeId: nodeIdA,
    });
    sse.close();

    // B 的通知列表：一行 mention，payload 同形
    const list = await authed(collaboratorToken, 'get', '/api/notifications');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].type).toBe('mention');
    expect(list.body[0].payload).toEqual(event.payload);
    expect(list.body[0].readAt).toBeNull();
    expect(Number.isNaN(Date.parse(list.body[0].createdAt))).toBe(false);

    const unread = await authed(collaboratorToken, 'get', '/api/notifications/unread-count');
    expect(unread.status).toBe(200);
    expect(unread.body).toEqual({ count: 1 });
  });

  it('self-mention 不产生通知', async () => {
    const before = await dataSource.getRepository(NotificationEntity).countBy({ userId: owner.id });
    const res = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '我自己记一笔',
      mentions: [owner.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.mentions).toEqual([owner.id]); // 提及仍记录（归一化合法），只是不通知
    const after = await dataSource.getRepository(NotificationEntity).countBy({ userId: owner.id });
    expect(after).toBe(before);
  });

  it('B 回复 A 的线程 → A 收到 reply 通知，B 自己不产生', async () => {
    const thread = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '楼主发起讨论',
    });
    const commentId = thread.body.id as string;

    const reply = await authed(collaboratorToken, 'post', `/api/files/${fileId}/comments/${commentId}/replies`).send({
      content: '楼主看这里',
    });
    expect(reply.status).toBe(201);

    const list = await authed(ownerToken, 'get', '/api/notifications');
    const rows = (list.body as Array<{ type: string; payload: Record<string, unknown> }>).filter((r) => r.type === 'reply');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({
      fileId,
      title: '通知文件',
      commenterId: collaborator.id,
      commenterName: collaborator.nickname,
      content: '楼主看这里',
      nodeId: nodeIdA,
    });

    // B 无新增（replier 不自通知）
    const bList = await authed(collaboratorToken, 'get', '/api/notifications');
    expect((bList.body as Array<{ type: string }>).every((r) => r.type !== 'reply')).toBe(true);
  });

  it('mentions 混入非协作者被过滤：非协作者不产生通知', async () => {
    const res = await authed(ownerToken, 'post', `/api/files/${fileId}/comments`).send({
      nodeId: nodeIdA,
      content: '无关人等',
      mentions: [outsider.id, collaborator.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.mentions).toEqual([collaborator.id]); // 非协作者被静默剔除

    const outsiderUnread = await authed(outsiderToken, 'get', '/api/notifications/unread-count');
    expect(outsiderUnread.body).toEqual({ count: 0 });
    // collaborator 因提及收到一条 mention（本次新增），无 outsider 行
    const outsiderRows = await dataSource.getRepository(NotificationEntity).countBy({ userId: outsider.id });
    expect(outsiderRows).toBe(0);
  });

  it('已读接口：POST :id/read → {ok:true} → 未读清零，列表 readAt 回填', async () => {
    // 此前用例已为 B 累积多条未读（mention 两条）：逐条标记后未读清零
    const list = await authed(collaboratorToken, 'get', '/api/notifications');
    const unreadRows = (list.body as Array<{ id: string; readAt: string | null }>).filter((r) => r.readAt === null);
    expect(unreadRows.length).toBeGreaterThanOrEqual(1);

    for (const row of unreadRows) {
      const res = await authed(collaboratorToken, 'post', `/api/notifications/${row.id}/read`);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    }

    const unread = await authed(collaboratorToken, 'get', '/api/notifications/unread-count');
    expect(unread.body).toEqual({ count: 0 });

    const after = await authed(collaboratorToken, 'get', '/api/notifications');
    const readAts = new Map((after.body as Array<{ id: string; readAt: string | null }>).map((r) => [r.id, r.readAt]));
    for (const row of unreadRows) expect(readAts.get(row.id)).not.toBeNull();
  });

  it('未登录 401：notifications 三端点统一鉴权', async () => {
    expect((await request(app.getHttpServer()).get('/api/notifications')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/notifications/01ABC/read')).status).toBe(401);
    expect((await request(app.getHttpServer()).get('/api/notifications/unread-count')).status).toBe(401);
  });
});
