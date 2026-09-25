import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';
import { FileCollaboratorEntity } from '../src/files/file-collaborator.entity';
import { InviteEntity } from '../src/share/invite.entity';
import { NotificationEntity } from '../src/notifications/notification.entity';
import { ShareLinkEntity } from '../src/share/share-link.entity';

/**
 * 分享域 E2E — M3b Task 4（FR-SHR-001）+ Task 5（FR-SHR-004 批量邀请与注册回填）。
 *
 * 分享链接端点：POST/DELETE /api/files/:id/share（owner only）、GET /api/share/:token（公开，
 * 落地页登录前探测）、POST /api/share/:token/join（UserGuard → 写 editor 协作者行）。
 *
 * 语义裁定（binding）：
 * - 每文件至多一条 active 链接：重复创建返回既有 active token（不繁殖行）；
 * - closed/missing 统一 200 { status:'closed' }（GET 不泄露存在性差异）；
 * - join 对 closed/missing 统一 404「链接已失效」（与 GET 的 closed 语义对齐）；
 * - 非 owner 创建/关闭与「文件不存在」同口径 404（不泄露文件存在性）。
 *
 * 批量邀请（POST /api/files/:id/invites，owner only，1~50 个联系人）：
 * - pending 重复邀请 no-op（不重复计）；已 accepted 再邀请 no-op；非法格式 400 并逐条回列；
 * - 注册回填：新用户首登（仅创建路径）按 email/phone 匹配 pending 邀请 → accepted +
 *   editor 协作者行；owner 侧零通知（仅登记，无感知）。
 */
describe('share 域', () => {
  let app: INestApplication;
  let users: import('../src/users/users.service').UsersService;
  let files: import('../src/files/files.service').FilesService;
  let collabRepo: import('typeorm').Repository<FileCollaboratorEntity>;
  let shareRepo: import('typeorm').Repository<ShareLinkEntity>;
  let inviteRepo: import('typeorm').Repository<InviteEntity>;
  let notifRepo: import('typeorm').Repository<NotificationEntity>;

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
    inviteRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(InviteEntity));
    notifRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(NotificationEntity));
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

  // ---------- 批量邀请与注册回填（M3b Task 5，FR-SHR-004） ----------

  /** owner 建普通文件（无分享链接），返回 fileId。 */
  async function makeFile(owner: { id: string; token: string }, title = '批量邀请域用例'): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/files')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ title });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  const invite = (owner: { token: string }, fileId: string, contacts: string[]) =>
    request(app.getHttpServer())
      .post(`/api/files/${fileId}/invites`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ contacts });

  /** 以验证码登录（未注册即注册），返回 { id, token }。 */
  async function loginByCode(payload: { email?: string; phone?: string }): Promise<{ id: string; token: string }> {
    const body = payload.email
      ? { method: 'email', email: payload.email, mode: 'code', code: '123456' }
      : { method: 'phone', phone: payload.phone, code: '123456' };
    const res = await request(app.getHttpServer()).post('/api/auth/login').send(body);
    expect(res.status).toBe(200);
    return { id: res.body.user.id as string, token: res.body.token as string };
  }

  it('批量邀请 3 联系人（2 邮箱 1 手机号）：pending 行 + invited_by 正确 + 邮件含邀请人/文件名/注册链接', async () => {
    const owner = await newUser('13800120001');
    const fileId = await makeFile(owner, '批量邀请域用例');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await invite(owner, fileId, ['invite-a@test.dev', '13700020001', 'invite-b@test.dev']);
    // 先取快照再 restore（mockRestore 会清空 mock.calls）
    const mailLogs = logSpy.mock.calls.map((args) => args.join(' ')).filter((l) => l.includes('[mail]'));
    logSpy.mockRestore();

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ invited: 3, skipped: 0 });

    const rows = await inviteRepo.find({ where: { fileId } });
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.contactType, r.contact, r.status, r.invitedBy]).sort()).toEqual(
      [
        ['email', 'invite-a@test.dev', 'pending', owner.id],
        ['email', 'invite-b@test.dev', 'pending', owner.id],
        ['phone', '13700020001', 'pending', owner.id],
      ].sort(),
    );
    expect(rows.every((r) => r.acceptedUserId === null)).toBe(true);

    // 邀请邮件（尽力而为旁路，e2e 无 SMTP → log）：内容含邀请人/文件名/注册链接
    expect(mailLogs.length).toBe(2); // 仅 email 类联系人发邮件，手机号无邮件通道
    const mailText = mailLogs.join('\n');
    expect(mailText).toContain(owner.nickname);
    expect(mailText).toContain('批量邀请域用例');
    expect(mailText).toContain('http://localhost:5173/login');
  });

  it('非 owner 批量邀请 404（与不存在同口径）；空列表 400', async () => {
    const owner = await newUser('13800120002');
    const outsider = await newUser('13800120003');
    const fileId = await makeFile(owner);

    const byOutsider = await invite(outsider, fileId, ['invite-c@test.dev']);
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.message).toBe('文件不存在');

    const empty = await invite(owner, fileId, []);
    expect(empty.status).toBe(400);
  });

  it('未注册邮箱受邀后以该邮箱注册 → 邀请自动 accepted + collaborator 行 + shared 视图可见', async () => {
    const owner = await newUser('13800120004');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-d@test.dev']);

    const invitee = await loginByCode({ email: 'invite-d@test.dev' });

    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-d@test.dev' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).toBe(invitee.id);

    const collab = await collabRepo.findOneByOrFail({ fileId, userId: invitee.id });
    expect(collab.role).toBe('editor');

    const shared = await request(app.getHttpServer())
      .get('/api/files?view=shared')
      .set('Authorization', `Bearer ${invitee.token}`);
    expect(shared.status).toBe(200);
    expect(shared.body.map((f: { id: string }) => f.id)).toContain(fileId);
  });

  it('手机号注册同样回填（accepted + editor 协作者行）', async () => {
    const owner = await newUser('13800120005');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['13700020002']);

    const invitee = await loginByCode({ phone: '13700020002' });

    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'phone', contact: '13700020002' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).toBe(invitee.id);
    expect(await collabRepo.countBy({ fileId, userId: invitee.id })).toBe(1);
    expect((await collabRepo.findOneByOrFail({ fileId, userId: invitee.id })).role).toBe('editor');
  });

  it('重复邀请幂等：pending 重邀 no-op，invited/skipped 计数正确、行不翻倍', async () => {
    const owner = await newUser('13800120006');
    const fileId = await makeFile(owner);
    const contacts = ['invite-e@test.dev', 'invite-f@test.dev', '13700020003'];

    expect((await invite(owner, fileId, contacts)).body).toEqual({ invited: 3, skipped: 0 });
    expect((await invite(owner, fileId, contacts)).body).toEqual({ invited: 0, skipped: 3 });
    expect(await inviteRepo.countBy({ fileId })).toBe(3);
  });

  it('已 accepted 再邀请 no-op：行不变、计 skipped（回填后重发场景）', async () => {
    const owner = await newUser('13800120007');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-g@test.dev']);
    await loginByCode({ email: 'invite-g@test.dev' });

    const res = await invite(owner, fileId, ['invite-g@test.dev']);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ invited: 0, skipped: 1 });

    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-g@test.dev' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).not.toBeNull();
  });

  it('批量 >50 拒 400', async () => {
    const owner = await newUser('13800120008');
    const fileId = await makeFile(owner);
    const contacts = Array.from({ length: 51 }, (_, i) => `invite-x${i}@test.dev`);

    const res = await invite(owner, fileId, contacts);
    expect(res.status).toBe(400);
  });

  it('非法格式 400 且逐条列出非法条目（合法条目不误伤）', async () => {
    const owner = await newUser('13800120009');
    const fileId = await makeFile(owner);

    const res = await invite(owner, fileId, ['not-an-email', '13700020004', '137000', 'bad@']);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('not-an-email');
    expect(res.body.message).toContain('137000');
    expect(res.body.message).toContain('bad@');
    expect(res.body.message).not.toContain('13700020004');

    // 整批拒绝：不落任何邀请行
    expect(await inviteRepo.countBy({ fileId })).toBe(0);
  });

  it('回填对 owner 零通知（owner 无感知，仅登记）', async () => {
    const owner = await newUser('13800120010');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-h@test.dev', '13700020005']);
    await loginByCode({ email: 'invite-h@test.dev' });
    await loginByCode({ phone: '13700020005' });

    expect(await notifRepo.countBy({ userId: owner.id })).toBe(0);
  });

  it('revoked 邀请不因注册回填复活：行保持 revoked、accepted_user_id 空、无协作者行', async () => {
    const owner = await newUser('13800120011');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-r@test.dev']);
    // 模拟撤销端点后的状态（当前无端点，直改 DB 行）
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-r@test.dev' });
    row.status = 'revoked';
    await inviteRepo.save(row);

    const invitee = await loginByCode({ email: 'invite-r@test.dev' });

    const after = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-r@test.dev' });
    expect(after.status).toBe('revoked');
    expect(after.acceptedUserId).toBeNull();
    expect(await collabRepo.countBy({ fileId, userId: invitee.id })).toBe(0);
  });

  it('回填中途失败与登录隔离：登录仍 200、事务回滚（行保持 pending、无协作者行），二次登录不受影响', async () => {
    const owner = await newUser('13800120012');
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-x@test.dev']);

    // 故障注入：首个 FileCollaborator save 抛非 dup-key 错误。回填在事务内经
    // em.getRepository 取仓库（与注入的 app 级实例不同源），故用 Repository 原型级
    // spy 精准命中该实体类型一次（createSeedFiles 只写 files/folders，不会误伤）。
    const collabProto = Object.getPrototypeOf(collabRepo) as { save: (...args: unknown[]) => Promise<unknown> };
    const originalSave = collabProto.save;
    let injected = false;
    const spy = vi.spyOn(collabProto, 'save').mockImplementation(async function (
      this: { target?: unknown },
      ...args: unknown[]
    ) {
      if (!injected && this.target === FileCollaboratorEntity) {
        injected = true;
        throw new Error('模拟协作者行写入失败');
      }
      return originalSave.apply(this, args);
    });

    let login: request.Response;
    try {
      login = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ method: 'email', email: 'invite-x@test.dev', mode: 'code', code: '123456' });
    } finally {
      spy.mockRestore();
    }
    // 回填失败不得波及登录（best-effort 隔离，口径同邮件旁路）
    expect(login.status).toBe(200);

    // 事务整体回滚：无「已 accepted 无协作者行」脏状态
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-x@test.dev' });
    expect(row.status).toBe('pending');
    expect(row.acceptedUserId).toBeNull();
    const user = await users.findByIdentity({ method: 'email', email: 'invite-x@test.dev' });
    expect(user).not.toBeNull();
    expect(await collabRepo.countBy({ fileId, userId: user!.id })).toBe(0);

    // 二次登录（用户已存在，创建路径跳过 → 回填不重跑）：仍 200、行仍 pending
    // 残差记录在案：失败的回填需 owner 重邀补救（见报告 fix note）
    const second = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ method: 'email', email: 'invite-x@test.dev', mode: 'code', code: '123456' });
    expect(second.status).toBe(200);
    const after = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-x@test.dev' });
    expect(after.status).toBe('pending');
    expect(await collabRepo.countBy({ fileId, userId: user!.id })).toBe(0);
  });
});
