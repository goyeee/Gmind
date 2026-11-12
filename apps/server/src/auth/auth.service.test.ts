import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { EmailCodeService } from './email-code.service';
import { AuthService } from './auth.service';
import { UserEntity } from '../users/user.entity';
import type { UsersService } from '../users/users.service';
import type { SessionService } from '../session/session.service';
import type { FilesService } from '../files/files.service';
import type { InviteService } from '../share/invite.service';

/**
 * AuthService 单测（2026-11-12 账号体系重做，brief Step 1 用例清单逐条覆盖）：
 * login 三条 401 文案逐字 + 回填失败隔离；register 验码→建号→种文件→回填→建会话
 * 的顺序即契约 + 码错 400/并发被占 409；resetPassword 验码→覆写→吊销全部会话。
 * 密码用真实 bcrypt（cost=10 与实现一致）；EmailCodeService 以桩注入（其行为已在
 * email-code.service.test.ts 钉死）。错误文案与 HTTP 状态码逐字断言。
 */

const PASSWORD = 'pass123456';

/** 断言 rejects 的异常体：文案逐字 + HTTP 状态码（镜像 email-code.service.test.ts）。 */
async function expectStatus(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  const err: { getStatus?: () => number; message?: string } = await promise.then(
    () => {
      throw new Error(`应当抛出 ${status}，却正常完成`);
    },
    (e: unknown) => e as { getStatus?: () => number; message?: string },
  );
  expect(err.message).toBe(message);
  expect(err.getStatus?.()).toBe(status);
}

/** 造库内用户（passwordHash 传明文则落真实 hash，供登录核身用例）。 */
async function makeUser(patch: Partial<UserEntity> & { passwordHash?: string }): Promise<UserEntity> {
  const u = new UserEntity();
  const { passwordHash, ...rest } = patch;
  Object.assign(u, {
    nickname: '甲',
    systemRole: 'member',
    status: 'active',
    avatarUrl: null,
    email: null,
    phone: null,
    passwordHash: null,
    ...rest,
    ...(passwordHash !== undefined ? { passwordHash: await hash(passwordHash, 10) } : {}),
  });
  return u;
}

/** 服务桩：AuthService 只触达这些方法；调用顺序经 mock.invocationCallOrder 钉死。 */
function makeDeps(found: UserEntity | null, opts: { created?: UserEntity } = {}) {
  const users = {
    findByEmail: vi.fn(async () => found),
    createByEmail: vi.fn(async () => opts.created ?? new UserEntity()),
    setPasswordForReset: vi.fn(async () => undefined),
    save: vi.fn(async (u: UserEntity) => u),
  };
  const sessions = {
    create: vi.fn(async () => ({ token: 'tok-1', expiresAt: 123456 })),
    revokeAllForUser: vi.fn(async () => undefined),
  };
  const files = { createSeedFiles: vi.fn(async () => undefined) };
  const invites = { acceptPendingForNewUser: vi.fn(async () => undefined) };
  const emailCode = { verify: vi.fn(async () => undefined), issue: vi.fn(async () => undefined) };
  const svc = new AuthService(
    users as unknown as UsersService,
    sessions as unknown as SessionService,
    files as unknown as FilesService,
    invites as unknown as InviteService,
    emailCode as unknown as EmailCodeService,
  );
  return { svc, users, sessions, files, invites, emailCode };
}

describe('AuthService.login（邮箱+密码）', () => {
  it('邮箱不存在 → 401「账号不存在，请先注册」，不建会话', async () => {
    const { svc, sessions } = makeDeps(null);
    await expectStatus(svc.login('nope@x.dev', PASSWORD, false), 401, '账号不存在，请先注册');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('密码错误（真实 bcrypt compare 失败）→ 401「密码错误，请重新输入或找回密码」，不建会话', async () => {
    const me = await makeUser({ id: 'u1', email: 'a@x.dev', passwordHash: PASSWORD });
    const { svc, sessions } = makeDeps(me);
    await expectStatus(svc.login('a@x.dev', 'wrong-pass-1', false), 401, '密码错误，请重新输入或找回密码');
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('已停用账号（密码正确）→ 401「账号已被停用，请联系管理员」，不建会话不发回填', async () => {
    const me = await makeUser({ id: 'u1', email: 'a@x.dev', status: 'disabled', passwordHash: PASSWORD });
    const { svc, sessions, invites } = makeDeps(me);
    await expectStatus(svc.login('a@x.dev', PASSWORD, false), 401, '账号已被停用，请联系管理员');
    expect(sessions.create).not.toHaveBeenCalled();
    expect(invites.acceptPendingForNewUser).not.toHaveBeenCalled();
  });

  it('成功 → sessions.create(id, rememberMe)，返回 {token, expiresAt, user}，不 save（role/status 原样不动）', async () => {
    const me = await makeUser({
      id: 'u1',
      email: 'a@x.dev',
      nickname: '乙',
      avatarUrl: '/avatars/preset-1.svg',
      systemRole: 'super_admin',
      passwordHash: PASSWORD,
    });
    const { svc, sessions, users } = makeDeps(me);
    const res = await svc.login('a@x.dev', PASSWORD, true);
    expect(res).toEqual({
      token: 'tok-1',
      expiresAt: 123456,
      user: { id: 'u1', nickname: '乙', avatarUrl: '/avatars/preset-1.svg' },
    });
    expect(sessions.create).toHaveBeenCalledWith('u1', true);
    expect(users.save).not.toHaveBeenCalled(); // 登录路径不改角色/状态/资料
  });

  it('邀请回填失败被隔离（log-only）：登录仍发 token，console.error 带 user 上下文（M5 清偿）', async () => {
    const me = await makeUser({ id: 'u1', email: 'a@x.dev', passwordHash: PASSWORD });
    const { svc, invites, sessions } = makeDeps(me);
    vi.mocked(invites.acceptPendingForNewUser).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await svc.login('a@x.dev', PASSWORD, false);
    expect(res.token).toBe('tok-1');
    expect(sessions.create).toHaveBeenCalledWith('u1', false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('user=u1'), expect.anything());
    errSpy.mockRestore();
  });
});

describe('AuthService.register（邮箱注册制）', () => {
  const input = { email: 'a@x.dev', code: '123456', password: PASSWORD, nickname: '丙' };

  it('成功链路顺序即契约：验码(register) → createByEmail → 种示例文件 → 邀请回填 → 建会话(rememberMe=false)', async () => {
    const fresh = await makeUser({ id: 'u-new', email: 'a@x.dev', nickname: '丙' });
    const { svc, emailCode, users, files, invites, sessions } = makeDeps(null, { created: fresh });
    const res = await svc.register(input);
    const order = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0] as number;
    expect(order(emailCode.verify)).toBeLessThan(order(users.createByEmail));
    expect(order(users.createByEmail)).toBeLessThan(order(files.createSeedFiles));
    expect(order(files.createSeedFiles)).toBeLessThan(order(invites.acceptPendingForNewUser));
    expect(order(invites.acceptPendingForNewUser)).toBeLessThan(order(sessions.create));
    expect(emailCode.verify).toHaveBeenCalledWith('register', 'a@x.dev', '123456');
    expect(users.createByEmail).toHaveBeenCalledWith({ email: 'a@x.dev', nickname: '丙', password: PASSWORD });
    expect(files.createSeedFiles).toHaveBeenCalledWith('u-new');
    expect(invites.acceptPendingForNewUser).toHaveBeenCalledWith(fresh);
    expect(sessions.create).toHaveBeenCalledWith('u-new', false);
    expect(res).toEqual({
      token: 'tok-1',
      expiresAt: 123456,
      user: { id: 'u-new', nickname: '丙', avatarUrl: null },
    });
  });

  it('码错 → 400「验证码错误或已过期，请重新获取后再试」，不建号不种文件不建会话', async () => {
    const { svc, emailCode, users, files, sessions } = makeDeps(null);
    vi.mocked(emailCode.verify).mockRejectedValueOnce(new BadRequestException('验证码错误或已过期，请重新获取后再试'));
    await expectStatus(svc.register(input), 400, '验证码错误或已过期，请重新获取后再试');
    expect(users.createByEmail).not.toHaveBeenCalled();
    expect(files.createSeedFiles).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('邮箱被占（并发兜底 uk_users_email）→ 409「该邮箱已注册，请直接登录」，不种文件不建会话', async () => {
    const { svc, users, files, sessions } = makeDeps(null);
    vi.mocked(users.createByEmail).mockRejectedValueOnce(Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' }));
    await expectStatus(svc.register(input), 409, '该邮箱已注册，请直接登录');
    expect(files.createSeedFiles).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword（忘记密码）', () => {
  it('成功顺序即契约：验码(password_reset) → setPasswordForReset → revokeAllForUser 被调用', async () => {
    const me = await makeUser({ id: 'u1', email: 'a@x.dev', passwordHash: PASSWORD });
    const { svc, emailCode, users, sessions } = makeDeps(me);
    await svc.resetPassword({ email: 'a@x.dev', code: '123456', newPassword: 'new-pass-456' });
    expect(emailCode.verify).toHaveBeenCalledWith('password_reset', 'a@x.dev', '123456');
    expect(users.setPasswordForReset).toHaveBeenCalledWith('u1', 'new-pass-456');
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith('u1');
    const order = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0] as number;
    expect(order(emailCode.verify)).toBeLessThan(order(users.setPasswordForReset));
    expect(order(users.setPasswordForReset)).toBeLessThan(order(sessions.revokeAllForUser));
  });

  it('码错 → 400「验证码错误或已过期，请重新获取后再试」，不覆写不吊销', async () => {
    const me = await makeUser({ id: 'u1', email: 'a@x.dev' });
    const { svc, emailCode, users, sessions } = makeDeps(me);
    vi.mocked(emailCode.verify).mockRejectedValueOnce(new BadRequestException('验证码错误或已过期，请重新获取后再试'));
    await expectStatus(
      svc.resetPassword({ email: 'a@x.dev', code: '000000', newPassword: 'new-pass-456' }),
      400,
      '验证码错误或已过期，请重新获取后再试',
    );
    expect(users.setPasswordForReset).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('邮箱不存在（发码后账号被删的防御分支）→ 404「该邮箱尚未注册，请确认后重试或先注册」，不吊销', async () => {
    const { svc, users, sessions } = makeDeps(null);
    await expectStatus(
      svc.resetPassword({ email: 'gone@x.dev', code: '123456', newPassword: 'new-pass-456' }),
      404,
      '该邮箱尚未注册，请确认后重试或先注册',
    );
    expect(users.setPasswordForReset).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
});
