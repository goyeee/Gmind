import { describe, expect, it, vi } from 'vitest';
import type { Repository } from 'typeorm';
import { UsersService } from './users.service';
import { UserEntity } from './user.entity';

/** 首注册者=super_admin（对齐 mindgrid）：建号时按空库判定；存量库的超管由迁移升最早用户。 */

const makeService = (existingCount: number): { svc: UsersService; saved: () => UserEntity } => {
  let last: UserEntity | null = null;
  const repo = {
    count: vi.fn(async () => existingCount),
    create: vi.fn(() => new UserEntity()),
    save: vi.fn(async (u: UserEntity) => {
      last = u;
      return u;
    }),
  } as unknown as Repository<UserEntity>;
  return { svc: new UsersService(repo), saved: () => last as UserEntity };
};

describe('UsersService.create：首注册者=超管', () => {
  it('空库（count=0）建号 → systemRole=super_admin', async () => {
    const { svc, saved } = makeService(0);
    await svc.create({ method: 'phone', phone: '13800138000' });
    expect(saved().systemRole).toBe('super_admin');
    expect(saved().status).toBe('active');
  });

  it('已有用户（count>0）建号 → systemRole=member', async () => {
    const { svc, saved } = makeService(3);
    await svc.create({ method: 'phone', phone: '13800138000' });
    expect(saved().systemRole).toBe('member');
  });
});
