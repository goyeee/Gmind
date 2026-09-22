import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type * as Y from 'yjs';
import {
  ROOT_NODE_ID,
  countAliveReachable,
  countNodes,
  createTemplateDoc,
  deleteNodes,
  docFromState,
  docToState,
} from '@gmind/core';
import { createTestApp } from './support/app-test';
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
    expect(Object.keys(res.body).sort()).toEqual(['docState', 'id', 'nodeCount', 'structure', 'themeId', 'title']);
    expect(res.body.title).toBe('内容文件');
    expect(res.body.nodeCount).toBe(2);

    const doc = docFromState(new Uint8Array(Buffer.from(res.body.docState, 'base64')));
    expect(doc.getMap('meta').get('title')).toBe('内容文件');
    expect(doc.getMap('meta').get('structureType')).toBe(res.body.structure);
    expect(doc.getMap('meta').get('themeId')).toBe(res.body.themeId);
    expect(countNodes(doc)).toBe(res.body.nodeCount);
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
    // 响应必须符合 FileListItem 契约（toListItem 唯一出口）
    expect(Object.keys(res.body).sort()).toEqual(['id', 'lastOpenedAt', 'nodeCount', 'structure', 'title', 'updatedAt']);
    expect(res.body.title).toBe('新名字');

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
