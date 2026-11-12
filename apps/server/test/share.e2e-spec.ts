import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';
import { createAccount, loginToken, type TestAccount } from './support/auth-test';
import { EventEntity } from '../src/events/event.entity';
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
 * - 注册回填（准入 7.10 起为登录回填）：按 email/phone 匹配 pending 邀请 → accepted +
 *   editor 协作者行，新用户首登与已注册用户再次登录均触发（幂等：pending 过滤 + uk_invite）；
 *   M4 清偿包起回填成功 → owner 收 permission 通知（M3b 的「owner 零通知」口径废止）。
 */
describe('share 域', () => {
  let app: INestApplication;
  let files: import('../src/files/files.service').FilesService;
  let collabRepo: import('typeorm').Repository<FileCollaboratorEntity>;
  let shareRepo: import('typeorm').Repository<ShareLinkEntity>;
  let inviteRepo: import('typeorm').Repository<InviteEntity>;
  let notifRepo: import('typeorm').Repository<NotificationEntity>;
  let eventRepo: import('typeorm').Repository<EventEntity>;

  /** 邮箱注册建号（走真实 API，注册即登录）；需断言昵称的用例显式传 nickname。 */
  async function newUser(
    opts?: { nickname?: string },
  ): Promise<{ id: string; email: string; nickname: string; token: string }> {
    const acct = await createAccount(app, opts);
    return { id: acct.id, email: acct.email, nickname: opts?.nickname ?? '', token: acct.token };
  }

  /** 受邀手机号回填装置（2026-11-12 重做后注册仅邮箱）：注册 → 换绑手机号（密码核身）
   *  → 再登录一次触发回填（acceptPendingForNewUser 按 email/phone 匹配 pending 邀请）。 */
  async function registerWithPhone(email: string, phone: string): Promise<{ id: string; token: string }> {
    const acct = await createAccount(app, { email });
    const rebind = await request(app.getHttpServer())
      .post('/api/users/me/phone')
      .set('Authorization', `Bearer ${acct.token}`)
      .send({ currentPassword: 'pass123456', phone });
    expect(rebind.status).toBe(204);
    const token = await loginToken(app, email);
    return { id: acct.id, token };
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
    files = app.get((await import('../src/files/files.service')).FilesService);
    collabRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(FileCollaboratorEntity));
    shareRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(ShareLinkEntity));
    inviteRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(InviteEntity));
    notifRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(NotificationEntity));
    eventRepo = app.get((await import('@nestjs/typeorm')).getRepositoryToken(EventEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  it('owner 创建分享链接：token 为 32 位 hex，DB 落 active 行', async () => {
    const owner = await newUser();
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
    const owner = await newUser();
    const outsider = await newUser();
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
    const owner = await newUser();
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
    const owner = await newUser({ nickname: '分享链接甲' });
    const { fileId, shareToken } = await makeSharedFile(owner);

    const res = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ fileId, title: '待分享脑图', ownerName: '分享链接甲', status: 'active', role: 'editor' }));
  });

  it('GET 未知/已关闭 token 统一 200 { status:"closed" }（不泄露存在性差异）', async () => {
    const missing = await request(app.getHttpServer()).get(`/api/share/${'ab'.repeat(16)}`);
    expect(missing.status).toBe(200);
    expect(missing.body).toEqual({ status: 'closed' });

    const owner = await newUser();
    const { fileId, shareToken } = await makeSharedFile(owner);
    await request(app.getHttpServer())
      .delete(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    const closed = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(closed.status).toBe(200);
    expect(closed.body).toEqual({ status: 'closed' });
  });

  it('GET 源文件已删的链接同样 closed（死链不外泄 title/owner）', async () => {
    const owner = await newUser();
    const { fileId, shareToken } = await makeSharedFile(owner);
    await files.deleteOwned(owner.id, fileId);
    const res = await request(app.getHttpServer()).get(`/api/share/${shareToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'closed' });
  });

  it('join 写 editor 协作者行（DB 断言）；二次 join 幂等 no-op；shared 视图可见', async () => {
    const owner = await newUser();
    const bob = await newUser();
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
    const bob = await newUser();

    const missing = await request(app.getHttpServer())
      .post(`/api/share/${'cd'.repeat(16)}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe('链接已失效');

    const owner = await newUser();
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
    const owner = await newUser();
    const { fileId, shareToken } = await makeSharedFile(owner);
    const res = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ fileId });
    expect(await collabRepo.countBy({ fileId })).toBe(0);
  });

  it('DELETE 关闭链接：owner 成功、DB 置 closed+closed_at；再次 DELETE 404；非 owner 404', async () => {
    const owner = await newUser();
    const outsider = await newUser();
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

  /** 受邀邮箱注册（走真实 register API），返回 { id, token }；注册即触发回填。 */
  async function loginByCode(email: string): Promise<{ id: string; token: string }> {
    const acct = await createAccount(app, { email });
    return { id: acct.id, token: acct.token };
  }

  it('批量邀请 3 联系人（2 邮箱 1 手机号）：pending 行 + invited_by 正确 + 邮件含邀请人/文件名/注册链接', async () => {
    const owner = await newUser();
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
    const owner = await newUser();
    const outsider = await newUser();
    const fileId = await makeFile(owner);

    const byOutsider = await invite(outsider, fileId, ['invite-c@test.dev']);
    expect(byOutsider.status).toBe(404);
    expect(byOutsider.body.message).toBe('文件不存在');

    const empty = await invite(owner, fileId, []);
    expect(empty.status).toBe(400);
  });

  it('未注册邮箱受邀后以该邮箱注册 → 邀请自动 accepted + collaborator 行 + shared 视图可见', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-d@test.dev']);

    const invitee = await loginByCode('invite-d@test.dev');

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

  it('手机号受邀回填（注册后换绑手机号 → 登录触发回填）（accepted + editor 协作者行）', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['13700020002']);

    const invitee = await registerWithPhone('phone-rebind@test.dev', '13700020002');

    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'phone', contact: '13700020002' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).toBe(invitee.id);
    expect(await collabRepo.countBy({ fileId, userId: invitee.id })).toBe(1);
    expect((await collabRepo.findOneByOrFail({ fileId, userId: invitee.id })).role).toBe('editor');
  });

  it('重复邀请幂等：pending 重邀 no-op，invited/skipped 计数正确、行不翻倍', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    const contacts = ['invite-e@test.dev', 'invite-f@test.dev', '13700020003'];

    expect((await invite(owner, fileId, contacts)).body).toEqual({ invited: 3, skipped: 0 });
    expect((await invite(owner, fileId, contacts)).body).toEqual({ invited: 0, skipped: 3 });
    expect(await inviteRepo.countBy({ fileId })).toBe(3);
  });

  it('已 accepted 再邀请 no-op：行不变、计 skipped（回填后重发场景）', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-g@test.dev']);
    await loginByCode('invite-g@test.dev');

    const res = await invite(owner, fileId, ['invite-g@test.dev']);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ invited: 0, skipped: 1 });

    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-g@test.dev' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).not.toBeNull();
  });

  it('批量 >50 拒 400', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    const contacts = Array.from({ length: 51 }, (_, i) => `invite-x${i}@test.dev`);

    const res = await invite(owner, fileId, contacts);
    expect(res.status).toBe(400);
  });

  it('非法格式 400 且逐条列出非法条目（合法条目不误伤）', async () => {
    const owner = await newUser();
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

  it('M4 清偿：邀请回填成功 → owner 收 permission 通知（payload.memberName/action=joined）', async () => {
    // M4 清偿包推翻 M3b「owner 零通知」口径：回填写入协作者行成功后，owner 收到
    // type='permission'、payload {fileId, title, memberName, action:'joined'} 的站内通知
    // （口径与 joinByToken 一致；通知失败静默，不波及回填主流程）。
    const owner = await newUser();
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-h@test.dev', '13700020005']);
    await loginByCode('invite-h@test.dev');
    await registerWithPhone('phone-rebind-m4@test.dev', '13700020005');

    const rows = await notifRepo.find({ where: { userId: owner.id } });
    expect(rows).toHaveLength(2); // 两位受邀者各一条（同文件不去重——不同 memberName）
    expect(rows.every((r) => r.type === 'permission')).toBe(true);
    const payloads = rows.map((r) => JSON.parse(r.payload ?? '{}') as Record<string, unknown>);
    for (const p of payloads) {
      expect(p).toMatchObject({ fileId, title: '批量邀请域用例', action: 'joined' });
      expect(typeof p.memberName).toBe('string');
      expect(p.memberName as string).not.toBe('');
    }
  });

  it('M5 清偿：回填时文件已软删 → 回填照常但 owner 不收「已加入」通知', async () => {
    // 软删文件（回收站可恢复语义）不产 owner 通知：notifyOwnersJoined 的 fileRepo.find
    // 过滤 deletedAt——通知是「成员加入了你的文件」的提醒，文件已删时提醒无意义；
    // 回填主流程（accepted + 协作者行）不受影响（授权事实与文件存活是两件事）。
    const owner = await newUser();
    const fileId = await makeFile(owner, '软删回填用例');
    await invite(owner, fileId, ['invite-softdel@test.dev']);
    await files.deleteOwned(owner.id, fileId); // owner 软删（trash 口径，行不消失）
    await loginByCode('invite-softdel@test.dev');

    // 回填本身照常：邀请 accepted（文件恢复后授权已在）
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-softdel@test.dev' });
    expect(row.status).toBe('accepted');
    // owner 通知计数不变（软删文件零「已加入」通知）
    expect(await notifRepo.countBy({ userId: owner.id })).toBe(0);
  });

  it('revoked 邀请不因注册回填复活：行保持 revoked、accepted_user_id 空、无协作者行', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner);
    await invite(owner, fileId, ['invite-r@test.dev']);
    // 模拟撤销端点后的状态（当前无端点，直改 DB 行）
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-r@test.dev' });
    row.status = 'revoked';
    await inviteRepo.save(row);

    const invitee = await loginByCode('invite-r@test.dev');

    const after = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-r@test.dev' });
    expect(after.status).toBe('revoked');
    expect(after.acceptedUserId).toBeNull();
    expect(await collabRepo.countBy({ fileId, userId: invitee.id })).toBe(0);
  });

  it('回填中途失败与注册/登录隔离：注册仍 200、事务回滚（行保持 pending、无协作者行）；二次登录按 7.10 天然重试成功', async () => {
    const owner = await newUser();
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

    let acct: TestAccount;
    try {
      // 注册即登录也触发回填（register → backfillInvites）：失败被隔离，注册主流程不波及
      acct = await createAccount(app, { email: 'invite-x@test.dev' });
    } finally {
      spy.mockRestore();
    }
    expect(acct.id).toBeTruthy();
    expect(acct.token).toBeTruthy();

    // 事务整体回滚：无「已 accepted 无协作者行」脏状态
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-x@test.dev' });
    expect(row.status).toBe('pending');
    expect(row.acceptedUserId).toBeNull();
    expect(await collabRepo.countBy({ fileId, userId: acct.id })).toBe(0);

    // 二次登录（准入 7.10：回填对已注册用户同样生效，每次登录尽力触发）：
    // 首次失败的 pending 残差在本次登录天然重试并成功——行 accepted、协作者行补齐
    const second = await loginToken(app, 'invite-x@test.dev');
    expect(second).toBeTruthy();
    const after = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'invite-x@test.dev' });
    expect(after.status).toBe('accepted');
    expect(after.acceptedUserId).toBe(acct.id);
    expect(await collabRepo.countBy({ fileId, userId: acct.id })).toBe(1);
  });

  // ---------- 准入 7.10（M4 T1）：已注册受邀者登录回填 ----------

  it('准入 7.10：已注册用户被邀请，登录后自动获得授权（不再永久悬挂）', async () => {
    // ① 受邀者先注册（产生既有账号；此时尚无邀请，回填空跑）
    const invitee = await loginByCode('reg710@test.dev');
    // ② owner 邀请该已注册邮箱 → pending 行 + 邀请邮件
    const owner = await newUser();
    const fileId = await makeFile(owner, '准入 7.10 用例');
    expect((await invite(owner, fileId, ['reg710@test.dev'])).status).toBe(201);
    // ③ 受邀者用同一邮箱再次登录（修复前：回填仅新用户创建路径，此处必失败）
    const againToken = await loginToken(app, 'reg710@test.dev');
    expect(againToken).toBeTruthy(); // 命中同一既有账号，非新建
    // ④ 回填生效：邀请 accepted + editor 协作者行 + shared 视图可见
    const row = await inviteRepo.findOneByOrFail({ fileId, contactType: 'email', contact: 'reg710@test.dev' });
    expect(row.status).toBe('accepted');
    expect(row.acceptedUserId).toBe(invitee.id);
    expect(await collabRepo.countBy({ fileId, userId: invitee.id })).toBe(1);
    const shared = await request(app.getHttpServer())
      .get('/api/files?view=shared')
      .set('Authorization', `Bearer ${againToken}`);
    expect(shared.status).toBe(200);
    expect(shared.body.map((f: { id: string }) => f.id)).toContain(fileId);
  });

  // ---------- 分享/邀请漏斗埋点（M5 Task 4，PRD 6.4：invite_send → collab_join） ----------

  /** 该文件某事件类型的 payload 列表（JSON 反序列化，附带 __userId 便于断言归属）。 */
  const eventPayloads = async (
    type: string,
    fileId: string,
  ): Promise<Array<Record<string, unknown> & { __userId?: string }>> =>
    (await eventRepo.find({ where: { type, fileId } })).map((r) => {
      const p = JSON.parse(r.payload ?? '{}') as Record<string, unknown>;
      return { ...p, __userId: r.userId ?? undefined };
    });

  it('埋点：创建分享链接落 invite_send {channel:"link"}；重复创建（幂等返回既有 token）不重复落', async () => {
    const owner = await newUser();
    const { fileId } = await makeSharedFile(owner);

    const rows = await eventPayloads('invite_send', fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ channel: 'link', __userId: owner.id });

    // 幂等复创建（无新链接生成）不重复计
    await request(app.getHttpServer())
      .post(`/api/files/${fileId}/share`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(await eventRepo.countBy({ type: 'invite_send', fileId })).toBe(1);
  });

  it('埋点：join 成功落 collab_join {viaRegistration:false}；幂等/owner 自开不重复落', async () => {
    const owner = await newUser();
    const bob = await newUser();
    const { fileId, shareToken } = await makeSharedFile(owner);

    const join = await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(join.status).toBe(201);

    const rows = await eventPayloads('collab_join', fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ viaRegistration: false, __userId: bob.id });

    // 二次 join 幂等 no-op：不重复落
    await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${bob.token}`);
    // owner 自开链接 no-op：不落
    await request(app.getHttpServer())
      .post(`/api/share/${shareToken}/join`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(await eventRepo.countBy({ type: 'collab_join', fileId })).toBe(1);
  });

  it('埋点：批量邀请按批落一条 invite_send {channel:"member",count}（非逐联系人）；全跳过批次不落', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner, '成员邀请埋点用例');

    const res = await invite(owner, fileId, ['invite-m1@test.dev', 'invite-m2@test.dev', '13700030001']);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ invited: 3, skipped: 0 });

    const rows = await eventPayloads('invite_send', fileId);
    expect(rows).toHaveLength(1); // 每次调用一行，非每联系人一行
    expect(rows[0]).toEqual({ channel: 'member', count: 3, __userId: owner.id });

    // 全 no-op 重邀批次（invited=0）：不产生新 invite_send 行
    await invite(owner, fileId, ['invite-m1@test.dev']);
    expect(await eventRepo.countBy({ type: 'invite_send', fileId })).toBe(1);
  });

  it('埋点：注册回填落 collab_join {viaRegistration:true}（逐文件一行）', async () => {
    const owner = await newUser();
    const fileId = await makeFile(owner, '回填埋点用例');
    await invite(owner, fileId, ['invite-bt@test.dev']);

    const invitee = await loginByCode('invite-bt@test.dev');

    const rows = await eventPayloads('collab_join', fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ viaRegistration: true, __userId: invitee.id });
  });
});
