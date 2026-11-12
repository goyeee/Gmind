import { describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import type { MailService } from '../mail/mail.service';
import { EmailCodeService } from '../auth/email-code.service';
import { UsersService } from './users.service';
import { UserEntity } from './user.entity';

/**
 * users 域邮箱化单测（2026-11-12 账号体系重做，brief Step 1 用例清单逐条覆盖）：
 * createByEmail 首注册超管/第二人 member；changePassword 旧密错 400/成功；rebindEmail
 * 密码错 400/码错 400/占用 409/成功；rebindPhone 占用 409/成功；updateNickname 落库；
 * setPasswordForReset 覆写。密码用真实 bcrypt（cost 与实现一致=10），验码走真
 * EmailCodeService + ioredis-mock（用法镜像 email-code.service.test.ts），
 * 错误文案与 HTTP 状态码逐字断言。
 */

const OLD_PASSWORD = 'old-pass-123';
const NEW_PASSWORD = 'new-pass-456';

/** email_bind 场景验证码键（EmailCodeService 私有键名，此处直写模拟「已发码」）。 */
const bindCodeKey = (email: string) => `email_code:email_bind:${email}`;

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

/** 造库内已有用户（passwordHash 为真实 hash，供核身类用例）。 */
async function seededUser(patch: { id: string; email: string; phone?: string; password: string }): Promise<UserEntity> {
  const u = new UserEntity();
  u.id = patch.id;
  u.email = patch.email;
  u.phone = patch.phone ?? null;
  u.passwordHash = await hash(patch.password, 10);
  return u;
}

async function makeService(existing: UserEntity[] = [], count = existing.length) {
  let last: UserEntity | null = null;
  const repo = {
    count: vi.fn(async () => count),
    create: vi.fn(() => new UserEntity()),
    save: vi.fn(async (u: UserEntity) => {
      last = u;
      return u;
    }),
    findOneBy: vi.fn(async (where: Record<string, unknown>) =>
      existing.find((u) =>
        Object.entries(where).every(([k, v]) => (u as unknown as Record<string, unknown>)[k] === v),
      ) ?? null),
  } as unknown as Repository<UserEntity>;
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock 的数据在同一模块域内的所有实例间共享，先清空以保证用例间隔离
  await redis.flushall();
  // dev/test 语境：EmailCodeService.generateCode 恒 DEV_MAIL_CODE（'123456'）且不发信
  const emailCode = new EmailCodeService(redis, { sendMail: vi.fn(async () => true) } as unknown as MailService);
  const svc = new UsersService(repo, emailCode);
  return { svc, redis, repo, saved: () => last as UserEntity };
}

describe('UsersService.createByEmail：首注册者=超管', () => {
  it('空库（count=0）首注册 → super_admin，email/nickname 落库，密码为可 compare 的真实 hash', async () => {
    const { svc, saved } = await makeService([], 0);
    const user = await svc.createByEmail({ email: 'a@x.dev', nickname: '甲', password: NEW_PASSWORD });
    expect(saved().systemRole).toBe('super_admin');
    expect(saved().email).toBe('a@x.dev');
    expect(saved().nickname).toBe('甲');
    expect(await compare(NEW_PASSWORD, user.passwordHash as string)).toBe(true);
  });

  it('已有用户（count>0）建号 → systemRole=member', async () => {
    const { svc, saved } = await makeService([], 3);
    await svc.createByEmail({ email: 'a@x.dev', nickname: '甲', password: NEW_PASSWORD });
    expect(saved().systemRole).toBe('member');
  });
});

describe('UsersService.findByEmail（Task 4 register/login 消费）', () => {
  it('命中返回用户、未命中返回 null', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc } = await makeService([me]);
    expect((await svc.findByEmail('a@x.dev'))?.id).toBe('u1');
    expect(await svc.findByEmail('nope@x.dev')).toBeNull();
  });
});

describe('UsersService.changePassword：旧密码核身', () => {
  it('旧密码错误 → 400「当前密码错误，请重新输入」，且不落库（校验先于写）', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, repo } = await makeService([me]);
    await expectStatus(
      svc.changePassword('u1', { currentPassword: 'wrong-pass', newPassword: NEW_PASSWORD }),
      400,
      '当前密码错误，请重新输入',
    );
    expect(repo.save).not.toHaveBeenCalled();
    expect(await compare(OLD_PASSWORD, me.passwordHash as string)).toBe(true);
  });

  it('旧密码正确 → 覆写 hash：新密码可 compare、旧密码不可', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, saved } = await makeService([me]);
    await svc.changePassword('u1', { currentPassword: OLD_PASSWORD, newPassword: NEW_PASSWORD });
    expect(await compare(NEW_PASSWORD, saved().passwordHash as string)).toBe(true);
    expect(await compare(OLD_PASSWORD, saved().passwordHash as string)).toBe(false);
  });
});

describe('UsersService.rebindEmail：密码 → 码 → 占用（顺序即契约）', () => {
  it('当前密码错误 → 400「当前密码错误，请重新输入」，验证码未被消费（先密码后验码）', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, redis } = await makeService([me]);
    await redis.set(bindCodeKey('b@x.dev'), '123456');
    await expectStatus(
      svc.rebindEmail('u1', { email: 'b@x.dev', code: '123456', currentPassword: 'wrong-pass' }),
      400,
      '当前密码错误，请重新输入',
    );
    expect(await redis.get(bindCodeKey('b@x.dev'))).toBe('123456');
  });

  it('验证码错误 → 400「验证码错误或已过期，请重新获取后再试」，email 未改', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, redis, repo } = await makeService([me]);
    await redis.set(bindCodeKey('b@x.dev'), '123456');
    await expectStatus(
      svc.rebindEmail('u1', { email: 'b@x.dev', code: '000000', currentPassword: OLD_PASSWORD }),
      400,
      '验证码错误或已过期，请重新获取后再试',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('目标邮箱已被他人占用 → 409「该邮箱已绑定其他账号，请换用其他邮箱」', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const other = await seededUser({ id: 'u2', email: 'b@x.dev', password: OLD_PASSWORD });
    const { svc, redis } = await makeService([me, other]);
    await redis.set(bindCodeKey('b@x.dev'), '123456');
    await expectStatus(
      svc.rebindEmail('u1', { email: 'b@x.dev', code: '123456', currentPassword: OLD_PASSWORD }),
      409,
      '该邮箱已绑定其他账号，请换用其他邮箱',
    );
  });

  it('核身全过 → email 落库', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, redis, saved } = await makeService([me]);
    await redis.set(bindCodeKey('b@x.dev'), '123456');
    await svc.rebindEmail('u1', { email: 'b@x.dev', code: '123456', currentPassword: OLD_PASSWORD });
    expect(saved().email).toBe('b@x.dev');
  });
});

describe('UsersService.rebindPhone：仅密码核身', () => {
  it('目标手机号已被他人占用 → 409「该手机号已绑定其他账号，请换用其他手机号」', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', phone: '13800138000', password: OLD_PASSWORD });
    const other = await seededUser({ id: 'u2', email: 'b@x.dev', phone: '13900139000', password: OLD_PASSWORD });
    const { svc } = await makeService([me, other]);
    await expectStatus(
      svc.rebindPhone('u1', { phone: '13900139000', currentPassword: OLD_PASSWORD }),
      409,
      '该手机号已绑定其他账号，请换用其他手机号',
    );
  });

  it('密码正确且未被占用 → phone 落库', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', phone: '13800138000', password: OLD_PASSWORD });
    const { svc, saved } = await makeService([me]);
    await svc.rebindPhone('u1', { phone: '13900139000', currentPassword: OLD_PASSWORD });
    expect(saved().phone).toBe('13900139000');
  });
});

describe('UsersService.updateNickname / setPasswordForReset', () => {
  it('updateNickname 落库并返回实体', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc } = await makeService([me]);
    const user = await svc.updateNickname('u1', '新昵称');
    expect(user.nickname).toBe('新昵称');
  });

  it('setPasswordForReset 无需当前密码，直接覆写 hash（resetPassword 专用）', async () => {
    const me = await seededUser({ id: 'u1', email: 'a@x.dev', password: OLD_PASSWORD });
    const { svc, saved } = await makeService([me]);
    await svc.setPasswordForReset('u1', NEW_PASSWORD);
    expect(await compare(NEW_PASSWORD, saved().passwordHash as string)).toBe(true);
    expect(await compare(OLD_PASSWORD, saved().passwordHash as string)).toBe(false);
  });
});
