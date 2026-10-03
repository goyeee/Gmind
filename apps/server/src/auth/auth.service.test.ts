import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { UsersService } from '../users/users.service';
import { UserEntity } from '../users/user.entity';
import { AuthService } from './auth.service';

/** 登录闸（账号管理）：停用账号拒绝登录（401 两段式文案）；登录成功不改动 role/status。
 *  首注册者=超管的建号策略在 users.service.test。 */

const makeUser = (patch: Partial<UserEntity>): UserEntity =>
  ({ nickname: '甲', systemRole: 'member', status: 'active', ...patch }) as unknown as UserEntity;

const makeAuthService = (user: UserEntity | null, fresh: UserEntity) => {
  const usersRepo = {
    findOneBy: vi.fn(async () => user),
    count: vi.fn(async () => 1),
    create: vi.fn(() => fresh),
    save: vi.fn(async (u: UserEntity) => u),
  } as unknown as Repository<UserEntity>;
  const users = new UsersService(usersRepo);
  const sessions = { create: vi.fn(async () => ({ token: 'tok-1', expiresAt: 1 })) };
  const files = { createSeedFiles: vi.fn(async () => undefined) };
  const invites = { acceptPendingForNewUser: vi.fn(async () => undefined) };
  const svc = new AuthService(
    users,
    sessions as unknown as ConstructorParameters<typeof AuthService>[1],
    files as unknown as ConstructorParameters<typeof AuthService>[2],
    invites as unknown as ConstructorParameters<typeof AuthService>[3],
  );
  return { svc, sessions, files, invites, usersRepo };
};

describe('AuthService.login：停用闸与角色不动', () => {
  it('已停用账号登录 → 401「账号已被停用，请联系管理员」，不建会话不发邀请回填', async () => {
    const { svc, sessions, invites } = makeAuthService(makeUser({ id: 'u1', status: 'disabled' }), makeUser({ id: 'fresh' }));
    await expect(svc.login({ method: 'phone', phone: '13800138000' }, false)).rejects.toThrow(
      new UnauthorizedException('账号已被停用，请联系管理员'),
    );
    expect(sessions.create).not.toHaveBeenCalled();
    expect(invites.acceptPendingForNewUser).not.toHaveBeenCalled();
  });

  it('活跃账号登录 → 发 token，users.save 不被调用（role/status 原样不动）', async () => {
    const { svc, sessions, usersRepo } = makeAuthService(
      makeUser({ id: 'u1', systemRole: 'super_admin', status: 'active' }),
      makeUser({ id: 'fresh' }),
    );
    const res = await svc.login({ method: 'phone', phone: '13800138000' }, false);
    expect(res.token).toBe('tok-1');
    expect(sessions.create).toHaveBeenCalledWith('u1', false);
    expect(usersRepo.save).not.toHaveBeenCalled(); // 登录路径不改角色/状态/资料
  });
});
