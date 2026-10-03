import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from './support/app-test';

/**
 * 账号管理端点 E2E（移植 mindgrid 账号体系）：
 * - 首注册者=super_admin（登录建号路径按空库判定；存量库由迁移升最早用户）；
 * - GET / POST / PATCH /api/admin/users 全挂 AdminGuard：未登录 401、member 403；
 * - 添加账号：手机号去重 409、格式 400、建号即 active member 无密码、不种示例文件；
 * - PATCH：角色升降（多超管在场可降）、自我保护 409（不停用/降级自己）、
 *   空字段 400、目标不存在 404、昵称可改；
 * - 停用踢号：停用后该号登录 401（两段式文案）、既有 token 请求 401（UserGuard 查库拒绝）、
 *   恢复后可再登录且角色不变（登录不改动 role/status）。
 */

const phone = (): string => '137' + String(Math.floor(10000000 + Math.random() * 89999999));

type Method = 'get' | 'post' | 'patch';
const authed = (app: INestApplication, token: string, method: Method, url: string) =>
  request(app.getHttpServer())[method](url).set('Authorization', `Bearer ${token}`);

const loginPhone = (app: INestApplication, p: string) =>
  request(app.getHttpServer()).post('/api/auth/login').send({ method: 'phone', phone: p, code: '123456' });

interface AdminItem {
  id: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  systemRole: 'super_admin' | 'member';
  status: 'active' | 'disabled';
  createdAt: string;
  fileCount: number;
}

describe('账号管理（/api/admin/users）：角色/状态/防呆/停用踢号', () => {
  let app: INestApplication;
  let adminToken: string; // 首注册者 → super_admin
  let adminId: string;
  let memberToken: string;
  let memberPhone: string;

  const list = async (): Promise<AdminItem[]> => {
    const res = await authed(app, adminToken, 'get', '/api/admin/users');
    expect(res.status).toBe(200);
    return res.body as AdminItem[];
  };
  const findItem = async (id: string): Promise<AdminItem | undefined> =>
    (await list()).find((u) => u.id === id);

  beforeAll(async () => {
    app = await createTestApp();
    // 首个登录建号 = 空库第一人 → super_admin（策略：首注册者=超管）
    const adminLogin = await loginPhone(app, phone());
    adminToken = (adminLogin.body as { token: string }).token;
    adminId = (adminLogin.body as { user: { id: string } }).user.id;

    memberPhone = phone();
    const memberLogin = await loginPhone(app, memberPhone);
    memberToken = (memberLogin.body as { token: string }).token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('鉴权门：未登录 401；member 403（仅超级管理员）', async () => {
    expect((await request(app.getHttpServer()).get('/api/admin/users')).status).toBe(401);
    expect((await request(app.getHttpServer()).post('/api/admin/users').send({})).status).toBe(401);

    const byMember = await authed(app, memberToken, 'get', '/api/admin/users');
    expect(byMember.status).toBe(403);
    expect(String(byMember.body.message)).toContain('仅超级管理员');

    const memberLogin = await loginPhone(app, memberPhone);
    const memberId = (memberLogin.body as { user: { id: string } }).user.id;
    const patchByMember = await authed(app, memberToken, 'patch', `/api/admin/users/${memberId}`).send({
      systemRole: 'super_admin',
    });
    expect(patchByMember.status).toBe(403);
  });

  it('GET 列表：首号 super_admin、次号 member；fileCount=3（登录建号种 3 个示例文件）；createdAt 为 ISO', async () => {
    const items = await list();
    expect(items).toHaveLength(2);
    const admin = items.find((u) => u.id === adminId);
    const member = items.find((u) => u.id !== adminId);
    expect(admin?.systemRole).toBe('super_admin');
    expect(admin?.status).toBe('active');
    expect(admin?.fileCount).toBe(3); // SEED_TEMPLATES 3 个模板
    expect(member?.systemRole).toBe('member');
    expect(member?.fileCount).toBe(3);
    for (const u of items) expect(Number.isNaN(Date.parse(u.createdAt))).toBe(false);
    // 注册时间升序：首号在前
    expect(items[0]?.id).toBe(adminId);
  });

  it('POST 添加账号：201 member/active/无密码/不种示例文件；重复 409；非法手机号 400；昵称超长 400', async () => {
    const addedPhone = phone();
    const created = await authed(app, adminToken, 'post', '/api/admin/users').send({
      phone: addedPhone,
      nickname: '新同事',
    });
    expect(created.status).toBe(201);
    const item = created.body as AdminItem;
    expect(item.systemRole).toBe('member');
    expect(item.status).toBe('active');
    expect(item.nickname).toBe('新同事');
    expect(item.phone).toBe(addedPhone);
    expect(item.fileCount).toBe(0); // 管理端建号不种示例文件（种子只在登录首建号路径）
    expect(Number.isNaN(Date.parse(item.createdAt))).toBe(false);

    // 该号可凭验证码登录（无密码形态）且 /me 显示 hasPassword=false
    const login = await loginPhone(app, addedPhone);
    expect(login.status).toBe(200);
    const token = (login.body as { token: string }).token;
    const me = await authed(app, token, 'get', '/api/users/me');
    expect(me.status).toBe(200);
    expect((me.body as { hasPassword: boolean }).hasPassword).toBe(false);

    const dup = await authed(app, adminToken, 'post', '/api/admin/users').send({ phone: addedPhone, nickname: '又一人' });
    expect(dup.status).toBe(409);
    expect(String(dup.body.message)).toContain('该手机号已注册');

    const badPhone = await authed(app, adminToken, 'post', '/api/admin/users').send({ phone: 'not-a-phone', nickname: '甲' });
    expect(badPhone.status).toBe(400);
    const badNickname = await authed(app, adminToken, 'post', '/api/admin/users').send({
      phone: phone(),
      nickname: '长'.repeat(33),
    });
    expect(badNickname.status).toBe(400);
    const empty = await authed(app, adminToken, 'post', '/api/admin/users').send({});
    expect(empty.status).toBe(400);
  });

  it('PATCH：昵称可改；空字段 400；目标不存在 404', async () => {
    const items = await list();
    const member = items.find((u) => u.id !== adminId) as AdminItem;

    const renamed = await authed(app, adminToken, 'patch', `/api/admin/users/${member.id}`).send({ nickname: '改了名' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as AdminItem).nickname).toBe('改了名');
    expect((await findItem(member.id))?.nickname).toBe('改了名');

    const empty = await authed(app, adminToken, 'patch', `/api/admin/users/${member.id}`).send({});
    expect(empty.status).toBe(400);
    const missing = await authed(app, adminToken, 'patch', `/api/admin/users/01NOPE0000000000000000000`).send({
      nickname: '谁',
    });
    expect(missing.status).toBe(404);
  });

  it('PATCH 角色升降：member 升超管 → 200；多超管在场时可降回 member → 200', async () => {
    const items = await list();
    const member = items.find((u) => u.id !== adminId) as AdminItem;

    const promoted = await authed(app, adminToken, 'patch', `/api/admin/users/${member.id}`).send({
      systemRole: 'super_admin',
    });
    expect(promoted.status).toBe(200);
    expect((promoted.body as AdminItem).systemRole).toBe('super_admin');

    // 降级后旧超管角色即时生效：此时用 member 的旧 token 也无法进管理端（member token 本来就是它，改用其升超管后验证）
    const nowAdmin = await authed(app, memberToken, 'get', '/api/admin/users');
    expect(nowAdmin.status).toBe(200); // 角色每请求查库，升权即时生效

    const demoted = await authed(app, adminToken, 'patch', `/api/admin/users/${member.id}`).send({
      systemRole: 'member',
    });
    expect(demoted.status).toBe(200); // 仍有 adminToken 一个启用超管在场
    expect((demoted.body as AdminItem).systemRole).toBe('member');
    // 降权即时生效：member token 再进管理端 → 403
    expect((await authed(app, memberToken, 'get', '/api/admin/users')).status).toBe(403);
  });

  it('PATCH 自我保护：不停用/降级自己 → 409（文案各自可辨）', async () => {
    const disableMe = await authed(app, adminToken, 'patch', `/api/admin/users/${adminId}`).send({ status: 'disabled' });
    expect(disableMe.status).toBe(409);
    expect(String(disableMe.body.message)).toContain('不能停用自己的账号');

    const downgradeMe = await authed(app, adminToken, 'patch', `/api/admin/users/${adminId}`).send({
      systemRole: 'member',
    });
    expect(downgradeMe.status).toBe(409);
    expect(String(downgradeMe.body.message)).toContain('不能取消自己的超级管理员身份');

    // 状态未被部分写入
    const me = await findItem(adminId);
    expect(me?.systemRole).toBe('super_admin');
    expect(me?.status).toBe('active');
  });

  it('停用踢号：停用后既有 token 401、登录 401（两段式文案）；恢复后再登录 200 且角色不变', async () => {
    const victimPhone = phone();
    const created = await authed(app, adminToken, 'post', '/api/admin/users').send({ phone: victimPhone, nickname: '待停用' });
    expect(created.status).toBe(201);
    const victimId = (created.body as AdminItem).id;

    const login1 = await loginPhone(app, victimPhone);
    expect(login1.status).toBe(200);
    const victimToken = (login1.body as { token: string }).token;
    expect((await authed(app, victimToken, 'get', '/api/users/me')).status).toBe(200);

    const disabled = await authed(app, adminToken, 'patch', `/api/admin/users/${victimId}`).send({ status: 'disabled' });
    expect(disabled.status).toBe(200);
    expect((disabled.body as AdminItem).status).toBe('disabled');

    // 既有会话即刻失效：Redis 会话仍在，但 UserGuard 查库见 disabled → 401
    const oldToken = await authed(app, victimToken, 'get', '/api/users/me');
    expect(oldToken.status).toBe(401);
    expect(String(oldToken.body.message)).toBe('账号已被停用，请联系管理员');

    // 再登录也被拒（登录闸）
    const login2 = await loginPhone(app, victimPhone);
    expect(login2.status).toBe(401);
    expect(String((login2.body as { message: string }).message)).toBe('账号已被停用，请联系管理员');

    // 恢复启用：原 token 复通、可再登录，且角色/状态未被登录路径改动
    const reactivated = await authed(app, adminToken, 'patch', `/api/admin/users/${victimId}`).send({ status: 'active' });
    expect(reactivated.status).toBe(200);
    expect((await authed(app, victimToken, 'get', '/api/users/me')).status).toBe(200);
    const login3 = await loginPhone(app, victimPhone);
    expect(login3.status).toBe(200);
    const after = await findItem(victimId);
    expect(after?.systemRole).toBe('member');
    expect(after?.status).toBe('active');
  });
});
