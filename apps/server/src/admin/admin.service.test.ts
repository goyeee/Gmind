import { describe, expect, it, vi } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { UserEntity } from '../users/user.entity';
import type { FileEntity } from '../files/file.entity';
import { AdminService } from './admin.service';

/**
 * AdminService 单测（service 级防呆规则）：角色升降、自我保护、最后超管保护、
 * 建号去重、列表 fileCount 聚合。停用拒登录闸在 auth.service.test。
 * 说明：最后超管保护在正常 HTTP 请求里被「操作者自身即一席启用超管」遮蔽
 * （操作者≠目标时计数恒 ≥2），此处于 service 层直接以 count=1 钉死规则本身。
 */

const makeUser = (patch: Partial<UserEntity>): UserEntity =>
  ({ systemRole: 'member', status: 'active', nickname: '甲', createdAt: new Date('2026-01-01T00:00:00Z'), ...patch }) as unknown as UserEntity;

/** users 仓储桩：save 落到 spy 并回传原实体（service 直接改实体再 save）。 */
const makeUsersRepo = (opts: {
  byId?: Record<string, UserEntity>;
  byPhone?: Record<string, UserEntity>;
  all?: UserEntity[];
  activeSuperAdmins?: number;
}) => {
  const save = vi.fn(async (u: UserEntity) => u);
  const repo = {
    findOneBy: vi.fn(async (w: Record<string, unknown>) => {
      if (w.id !== undefined) return opts.byId?.[w.id as string] ?? null;
      if (w.phone !== undefined) return opts.byPhone?.[w.phone as string] ?? null;
      return null;
    }),
    find: vi.fn(async () => opts.all ?? []),
    count: vi.fn(async () => opts.activeSuperAdmins ?? 0),
    create: vi.fn(() => new UserEntity()),
    save,
  };
  return { repo: repo as unknown as Repository<UserEntity>, save };
};

/** files 仓储桩：countBy 单人计数；list 用 raw 聚合行不桩 QB——list 用例走 countBy 兜底外仅映射。 */
const makeFilesRepo = (opts: { aliveByOwner?: Record<string, number>; groupRows?: Array<{ owner_user_id: string; n: string | number }> }) => {
  const repo = {
    countBy: vi.fn(async (w: Record<string, unknown>) => opts.aliveByOwner?.[w.ownerUserId as string] ?? 0),
    createQueryBuilder: vi.fn(() => {
      throw new Error('单测不触达列表聚合 QB');
    }),
  };
  return repo as unknown as Repository<FileEntity>;
};

const OPERATOR = '01ADMINOPERATOR000000000';

describe('AdminService.updateAccount：角色升降与防呆', () => {
  it('member 升 super_admin → 200 落库（save 携新角色）', async () => {
    const target = makeUser({ id: 'u-target', phone: '13800000001' });
    const { repo, save } = makeUsersRepo({ byId: { 'u-target': target }, activeSuperAdmins: 2 });
    const svc = new AdminService(repo, makeFilesRepo({}));
    const item = await svc.updateAccount(OPERATOR, 'u-target', { systemRole: 'super_admin' });
    expect(item.systemRole).toBe('super_admin');
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0].systemRole).toBe('super_admin');
  });

  it('super_admin 降 member（另有启用超管）→ 落库成功', async () => {
    const target = makeUser({ id: 'u-target', systemRole: 'super_admin' });
    const { repo, save } = makeUsersRepo({ byId: { 'u-target': target }, activeSuperAdmins: 3 });
    const svc = new AdminService(repo, makeFilesRepo({}));
    const item = await svc.updateAccount(OPERATOR, 'u-target', { systemRole: 'member' });
    expect(item.systemRole).toBe('member');
    expect(save).toHaveBeenCalled();
  });

  it('最后超管防呆：唯一启用超管被降级/停用 → 409 且不落库', async () => {
    const target = makeUser({ id: 'u-target', systemRole: 'super_admin' });
    const { repo, save } = makeUsersRepo({ byId: { 'u-target': target }, activeSuperAdmins: 1 });
    const svc = new AdminService(repo, makeFilesRepo({}));
    await expect(svc.updateAccount(OPERATOR, 'u-target', { systemRole: 'member' })).rejects.toThrow(ConflictException);
    await expect(svc.updateAccount(OPERATOR, 'u-target', { status: 'disabled' })).rejects.toThrow(
      '至少需要保留一个启用状态的超级管理员',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('自我保护：不得停用/降级自己（即便还有其他超管）→ 409', async () => {
    const me = makeUser({ id: OPERATOR, systemRole: 'super_admin' });
    const { repo, save } = makeUsersRepo({ byId: { [OPERATOR]: me }, activeSuperAdmins: 5 });
    const svc = new AdminService(repo, makeFilesRepo({}));
    await expect(svc.updateAccount(OPERATOR, OPERATOR, { status: 'disabled' })).rejects.toThrow('不能停用自己的账号');
    await expect(svc.updateAccount(OPERATOR, OPERATOR, { systemRole: 'member' })).rejects.toThrow(
      '不能取消自己的超级管理员身份',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('目标不存在 → 404；仅改昵称 → 直落库不走防呆', async () => {
    const target = makeUser({ id: 'u-target', systemRole: 'super_admin', status: 'active' });
    const { repo, save } = makeUsersRepo({ byId: { 'u-target': target }, activeSuperAdmins: 1 });
    const svc = new AdminService(repo, makeFilesRepo({ aliveByOwner: { 'u-target': 7 } }));
    await expect(svc.updateAccount(OPERATOR, 'nope', { nickname: '乙' })).rejects.toThrow(NotFoundException);
    // 超管对自己改昵称：nextRole/nextStatus 均不变，两道防呆都不触发
    const item = await svc.updateAccount(OPERATOR, 'u-target', { nickname: '乙' });
    expect(item.nickname).toBe('乙');
    expect(item.fileCount).toBe(7);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('AdminService.createAccount：建号语义', () => {
  it('手机号已存在 → 409 不建号', async () => {
    const { repo, save } = makeUsersRepo({ byPhone: { '13800138000': makeUser({ id: 'u1' }) } });
    const svc = new AdminService(repo, makeFilesRepo({}));
    await expect(svc.createAccount({ phone: '13800138000', nickname: '甲' })).rejects.toThrow('该手机号已注册');
    expect(save).not.toHaveBeenCalled();
  });

  it('新号：active member、无密码、fileCount=0', async () => {
    const { repo, save } = makeUsersRepo({});
    const svc = new AdminService(repo, makeFilesRepo({}));
    const item = await svc.createAccount({ phone: '13800138001', nickname: '新同事' });
    expect(item.systemRole).toBe('member');
    expect(item.status).toBe('active');
    expect(item.fileCount).toBe(0);
    const saved = save.mock.calls[0]?.[0] as UserEntity;
    expect(saved.passwordHash).toBeNull();
    expect(saved.phone).toBe('13800138001');
    expect(saved.nickname).toBe('新同事');
  });
});
