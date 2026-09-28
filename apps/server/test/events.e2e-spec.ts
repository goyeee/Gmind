import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ROOT_NODE_ID, childrenIds, createTemplateDoc, docFromState, docToState } from '@gmind/core';
import { createTestApp } from './support/app-test';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';

/**
 * 文档动态只读端点 E2E — M6 Task 8（企微对标，FR-COL-007 提前）。
 *
 * 端点：GET /api/files/:fileId/events?limit=50 → {items:[{id,type,payload,createdAt,userName}]}。
 *
 * 语义裁定（binding）：
 * - 权限：canAccess 口径（owner 或协作者）——经 FilesService.findAliveOr404 单点闸，
 *   缺失/已删/无权限统一 404「文件不存在」不泄露存在性（versions/comments 同口径）；
 * - 排序：created_at DESC（同毫秒按 ulid 单调性兜底，与 versions 列表同纪律）；
 * - userName：join users 映射 nickname（versions.service list 的 nicknamesOf 模式），
 *   user_id 可空（匿名埋点）→ null；
 * - payload：存储为 JSON 文本列，出口还原为对象（损坏防御 null）；
 * - limit：clamp 1..100，缺省/非法 50（遥测读口从宽收拢，不 400）。
 */
describe('文档动态端点（M6 Task 8，FR-COL-007 提前）', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let ownerToken: string;
  let collaboratorToken: string;
  let outsiderToken: string;
  let owner: { id: string; nickname: string };
  let collaborator: { id: string; nickname: string };
  let fileId: string;
  let nodeId: string;

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  const authedGet = (token: string, url: string) =>
    request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    app = await createTestApp();
    await app.listen(0);
    dataSource = app.get(DataSource);

    const users = app.get((await import('../src/users/users.service')).UsersService);
    const files = app.get((await import('../src/files/files.service')).FilesService);
    owner = await users.create({ method: 'phone', phone: '13900008001' });
    collaborator = await users.create({ method: 'phone', phone: '13900008002' });
    const outsider = await users.create({ method: 'phone', phone: '13900008003' });
    ownerToken = await tokenFor(owner.id);
    collaboratorToken = await tokenFor(collaborator.id);
    outsiderToken = await tokenFor(outsider.id);

    const created = await files.createForUser(owner.id, {
      title: '动态文件',
      state: docToState(
        createTemplateDoc({ title: '动态文件', children: [{ text: '节点A' }] }),
      ),
    });
    fileId = created.id;
    nodeId = childrenIds(docFromState(created.docState as Buffer), ROOT_NODE_ID)[0] as string;

    const collabRow = dataSource.getRepository(FileCollaboratorEntity).create();
    collabRow.fileId = fileId;
    collabRow.userId = collaborator.id;
    collabRow.role = 'editor';
    await dataSource.getRepository(FileCollaboratorEntity).save(collabRow);
  });

  afterAll(async () => {
    await app.close();
  });

  it('造事件（API 发评论）→ 列表倒序 + userName 映射 + payload 还原为对象', async () => {
    // 事件 1（隐含）：createForUser 落 doc_create（userId=owner）
    await sleep(5); // datetime(3) 同毫秒去歧义：DESC 断言需要可区分的时戳
    // 事件 2：owner 发评论 → comment_create
    const c1 = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/comments`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ nodeId, content: 'owner 第一条' });
    expect(c1.status).toBe(201);
    await sleep(5);
    // 事件 3：collaborator 发评论 → comment_create
    const c2 = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/comments`)
      .set('Authorization', `Bearer ${collaboratorToken}`)
      .send({ nodeId, content: 'collaborator 第二条', mentions: [owner.id] });
    expect(c2.status).toBe(201);

    const res = await authedGet(ownerToken, `/api/files/${fileId}/events`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['items']);
    expect(res.body.items).toHaveLength(3); // doc_create + 2×comment_create

    // 条目形状（binding）：id/type/payload/createdAt/userName 五键
    for (const item of res.body.items) {
      expect(Object.keys(item).sort()).toEqual(['createdAt', 'id', 'payload', 'type', 'userName']);
      expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);
    }

    // 倒序（created_at DESC）：最新 comment_create 在首
    expect(res.body.items.map((x: { type: string }) => x.type)).toEqual([
      'comment_create',
      'comment_create',
      'doc_create',
    ]);
    const times = res.body.items.map((x: { createdAt: string }) => x.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    // userName：join users 的 nickname（c2 是 collaborator 发的）
    expect(res.body.items[0].userName).toBe(collaborator.nickname);
    expect(res.body.items[1].userName).toBe(owner.nickname);
    expect(res.body.items[2].userName).toBe(owner.nickname); // doc_create 由 owner 创建

    // payload：JSON 文本列还原为对象（comment_create 携带 nodeId/hasMention）
    expect(res.body.items[0].payload).toEqual({ nodeId, hasMention: true });
    expect(res.body.items[1].payload).toEqual({ nodeId, hasMention: false });
  });

  it('limit：clamp 1..100，缺省 50（非法/越界收拢不 400）', async () => {
    // 经埋点通道补造事件至 >100 行（POST /api/events 是既有遥测通道，fileId 归属
    // 不校验——此处 owner 自发，语义即「本文件的动态」）
    const post = (token: string, seq: number) =>
      request(app.getHttpServer())
        .post('/api/events')
        .set('Authorization', `Bearer ${token}`)
        .send({ type: 'probe_event', fileId, payload: { seq } });
    for (let i = 0; i < 105; i++) await post(ownerToken, i);

    // 缺省 50
    const def = await authedGet(ownerToken, `/api/files/${fileId}/events`);
    expect(def.status).toBe(200);
    expect(def.body.items).toHaveLength(50);

    // 越界上收 100（文件已有 108 行：3 + 105）
    const big = await authedGet(ownerToken, `/api/files/${fileId}/events?limit=999`);
    expect(big.status).toBe(200);
    expect(big.body.items).toHaveLength(100);

    // 下收 1（0/负数/非法串均收拢为合法区间，缺省语义仅在完全缺失/不可解析时给 50）
    const zero = await authedGet(ownerToken, `/api/files/${fileId}/events?limit=0`);
    expect(zero.status).toBe(200);
    expect(zero.body.items).toHaveLength(1);
    expect(zero.body.items[0].payload).toEqual({ seq: 104 }); // 最新一行（DESC 首）

    const nan = await authedGet(ownerToken, `/api/files/${fileId}/events?limit=abc`);
    expect(nan.status).toBe(200);
    expect(nan.body.items).toHaveLength(50); // 不可解析 → 缺省 50
  });

  it('无权 404：非协作者与不存在文件同口径「文件不存在」；协作者可读', async () => {
    const outsiderGot = await authedGet(outsiderToken, `/api/files/${fileId}/events`);
    expect(outsiderGot.status).toBe(404);
    expect(outsiderGot.body.message).toBe('文件不存在');

    const missing = await authedGet(ownerToken, '/api/files/01AAAAAAAAAAAAAAAAAAAAAAAAAA/events');
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('文件不存在');

    const collabGot = await authedGet(collaboratorToken, `/api/files/${fileId}/events?limit=1`);
    expect(collabGot.status).toBe(200);
    expect(collabGot.body.items).toHaveLength(1);
  });
});
