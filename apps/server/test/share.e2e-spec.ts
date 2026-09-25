import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
import { ShareLinkEntity } from '../src/share/share-link.entity';

/**
 * 分享链接域 E2E — M3b Task 4（FR-SHR-001）。
 *
 * 端点：POST/DELETE /api/files/:id/share（owner only）、GET /api/share/:token（公开，
 * 落地页登录前探测）、POST /api/share/:token/join（UserGuard → 写 editor 协作者行）。
 *
 * 语义裁定（binding）：
 * - 每文件至多一条 active 链接：重复创建返回既有 active token（不繁殖行）；
 * - closed/missing 统一 200 { status:'closed' }（GET 不泄露存在性差异）；
 * - join 对 closed/missing 统一 404「链接已失效」（与 GET 的 closed 语义对齐）；
 * - 非 owner 创建/关闭与「文件不存在」同口径 404（不泄露文件存在性）。
 */
describe('share 域', () => {
  let app: INestApplication;
  let users: import('../src/users/users.service').UsersService;
  let files: import('../src/files/files.service').FilesService;
  let collabRepo: import('typeorm').Repository<FileCollaboratorEntity>;
  let shareRepo: import('typeorm').Repository<ShareLinkEntity>;

  const tokenFor = async (userId: string): Promise<string> => {
    const { SessionService } = await import('../src/session/session.service');
    const redisMod = await import('ioredis');
    const svc = new SessionService(new redisMod.default('redis://127.0.0.1:63790/1'));
    return (await svc.create(userId, false)).token;
  };

  /** 注册用户并签发 token；返回 { user, token }。 */
  async function newUser(phone: string): Promise<{ id: string; nickname: string; token: string }> {
    const user = await users.create({ method: 'phone', phone });
    return { id: user.id, nickname: user.nickname, token: await tokenFor(user.id) };
  }

  /** owner 建文件 → 建 active 分享链接，返回 { fileId, token, shareToken }。 */
  async function makeSharedFile(owner: { id: string; token: string }): Promise<{ fileId: string; shareToken: string }> {
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: '待分享脑图' });
    expect(created.status).toBe(201);
    const fileId = created.body.id as string;
    const share = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(share.status).toBe(201);
    return { fileId, shareToken: share.body.shareToken as string };
  }

  beforeAll(async () => {
    app = await createTestApp();
    users = app.get((await import('../src/users/users.service')).UsersService);
    files = app.get((await import('../src/files/files.service')).FilesService);
    collabRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(FileCollaboratorEntity));
    shareRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(ShareLinkEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  it('owner 创建分享链接：token 为 32 位 hex，DB 落 active 行', async () => {
    const owner = await newUser('13800110001');
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title: '分享链接域用例' });
    const fileId = created.body.id as string;

    const res = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(201);
    expect(res.body.shareToken).toMatch(/^[0-9a-f]{32}$/);

    const row = await shareRepo.findOneByOrFail({ fileId });
    expect(row.token).toBe(res.body.shareToken);
    expect(row.status).toBe('active');
    expect(row.createdBy).toBe(owner.id);
    expect(row.closedAt).toBeNull();
  });

  it('非 owner 创建 404（协作者/陌生人与不存在同口径，不泄露文件存在性）', async () => {
    const owner = await newUser('13800110002');
    const outsider = await newUser('13800110003');
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});
    const fileId = created.body.id as string;

    const byOutsider = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.message).toBe('文件不存在');

    const byMissing = await request(app.getHttpServer())
      .post('/api/files/01AAAAAAAAAAAAAAAAAAAAAAAAAA/share')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(byMissing.status).toBe(404);
    expect(byMissing.body.message).toBe('文件不存在');
  });

  it('重复创建返回同一 active token（每文件至多一条 active 链接）', async () => {
    const owner = await newUser('13800110004');
    const { fileId, shareToken } = await makeSharedFile(owner);

    const again = await request(app.getHttpServer())
      .post(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(again.status).toBe(201);
    expect(again.body.shareToken).toBe(shareToken);

    const actives = await shareRepo.find({ where: { fileId, status: 'active' } });
    expect(actives).toHaveLength(1);
  });

  it('GET /api/share/:token 公开可访问（未登录）：active 返回 fileId/title/ownerName', async () => {
    const owner = await newUser('13800110005');
    const { fileId, shareToken } = await makeSharedFile(owner);

    const res = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ fileId, title: '待分享脑图', ownerName: owner.nickname, status: 'active' });
  });

  it('GET 未知/已关闭 token 统一 200 { status:"closed" }（不泄露存在性差异）', async () => {
    const missing = await request(app.getHttpServer()).get(`/api/share/${'ab'.repeat(16)}`);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ status: 'closed' });

    const owner = await newUser('13800110006');
    const { fileId, shareToken } = await makeSharedFile(owner);
    await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    const closed = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ status: 'closed' });
  });

  it('GET 源文件已删的链接同样 closed（死链不外泄 title/owner）', async () => {
    const owner = await newUser('13800110007');
    const { fileId, shareToken } = await makeSharedFile(owner);
    await files.deleteOwned(owner.id, fileId);
    const res = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'closed' });
  });

  it('join 写 editor 协作者行（DB 断言）；二次 join 幂等 no-op；shared 视图可见', async () => {
    const owner = await newUser('13800110008');
    const bob = await newUser('13800110009');
    const { fileId, shareToken } = await makeSharedFile(owner);

    const join = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(join.status).toBe(201);
    expect(join.body).toEqual({ fileId });

    const row = await collabRepo.findOneByOrFail({ fileId, userId: bob.id });
    expect(row.role).toBe('editor');

    // 二次 join 幂等：无新行、无 409
    const again = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(again.status).toBe(201);
    expect(await collabRepo.countBy({ fileId, userId: bob.id })).toBe(1);

    // join 后 B 的 shared 视图含该文件（FR-FIL-001 口径复用）
    const shared = await request(app.getHttpServer())
      .get('/api/files?view=shared')
      .set('Authorization', `Bearer ${bob.token}`);
    expect(shared.status).toBe(200);
    expect(shared.body.map((f: { id: string }) => f.id)).toContain(fileId);
  });

  it('join 未知/已关闭链接 → 404「链接已失效」（closed 与 GET 语义统一）', async () => {
    const bob = await newUser('13800110010');

    const missing = await request(app.getHttpServer())
      .post(`/api/share/${'cd'.repeat(16)}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('链接已失效');

    const owner = await newUser('13800110011');
    const { fileId, shareToken } = await makeSharedFile(owner);
    await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    const closed = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(closed.status).toBe(404);
    expect(closed.body.message).toBe('链接已失效');
  });

  it('join 未登录 401（UserGuard）', async () => {
    const res = await request(app.getHttpServer()).post(`/api/share/${'ee'.repeat(16)}/join`);
    expect(res.status).toBe(401);
  });

  it('owner join 自己的链接：200 no-op，不产生冗余协作者行（落地页自动 join 场景）', async () => {
    const owner = await newUser('13800110014');
    const { fileId, shareToken } = await makeSharedFile(owner);
    const res = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ fileId });
    expect(await collabRepo.countBy({ fileId })).toBe(0);
  });

  it('DELETE 关闭链接：owner 成功、DB 置 closed+closed_at；再次 DELETE 404；非 owner 404', async () => {
    const owner = await newUser('13800110012');
    const outsider = await newUser('13800110013');
    const { fileId, shareToken } = await makeSharedFile(owner);

    const byOutsider = await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${outsider.token}`);
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.message).toBe('文件不存在');

    const res = await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const row = await shareRepo.findOneByOrFail({ fileId, token: shareToken });
    expect(row.status).toBe('closed');
    expect(row.closedAt).not.toBeNull();

    const again = await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(again.status).toBe(404);
  });
});
