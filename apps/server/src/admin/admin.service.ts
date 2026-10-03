import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { AccountStatus, AdminUserListItem, SystemRole } from '@gmind/shared';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
import { isDuplicateKeyError } from '../utils/duplicate-key';

/** PATCH 入参（已过 updateAdminAccountSchema 校验：至少其一）。 */
export interface AdminUpdateInput {
  systemRole?: SystemRole;
  status?: AccountStatus;
  nickname?: string;
}

/**
 * 账号管理（移植 mindgrid admin 轨道，适配 Gmind 手机号建号）：
 * - 列表/添加/改角色/改状态/改昵称，全部经 AdminGuard（super_admin）；
 * - 只停用不删除：停用后登录 401、既有会话被 UserGuard 即刻拒绝；
 * - 防呆两道（顺序固定）：先自我保护（不得停用/降级自己），再最后超管保护
 *   （不得让「启用状态的超级管理员」一个不剩，口径同 mindgrid countActiveSuperAdmins）。
 */
@Injectable()
export class AdminService {
  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(FileEntity) private readonly files: Repository<FileEntity>,
  ) {}

  /** 成员列表：注册时间升序（同毫秒以 id 决出，口径同 mindgrid listAllUsers）；
   *  fileCount=名下存活文件数（deleted_at IS NULL，与配额 countBy 口径一致，回收站不计）。 */
  async list(): Promise<AdminUserListItem[]> {
    const users = await this.users.find({ order: { createdAt: 'ASC', id: 'ASC' } });
    const rows = (await this.files
      .createQueryBuilder('f')
      .select('f.owner_user_id', 'owner_user_id')
      .addSelect('COUNT(*)', 'n')
      .where('f.deleted_at IS NULL')
      .groupBy('f.owner_user_id')
      .getRawMany()) as Array<{ owner_user_id: string; n: string | number }>;
    const counts = new Map(rows.map((r) => [r.owner_user_id, Number(r.n)]));
    return users.map((u) => this.toItem(u, counts.get(u.id) ?? 0));
  }

  /** 添加账号：建号即 active member、无密码（开发态凭验证码登录，与手机号注册同通道）。
   *  不种示例文件——种子只在「登录首建号」路径；此号首登走既有身份，不重复种。 */
  async createAccount(input: { phone: string; nickname: string }): Promise<AdminUserListItem> {
    const dup = await this.users.findOneBy({ phone: input.phone });
    if (dup) throw new ConflictException('该手机号已注册，请更换手机号或让该成员直接登录');
    const user = this.users.create();
    user.phone = input.phone;
    user.nickname = input.nickname;
    user.systemRole = 'member';
    user.status = 'active';
    try {
      return this.toItem(await this.users.save(user), 0);
    } catch (err) {
      // 并发窗口内的重复注册由 uk_users_phone 兜底（同 files 先例），文案与前置检查一致
      if (isDuplicateKeyError(err)) {
        throw new ConflictException('该手机号已注册，请更换手机号或让该成员直接登录');
      }
      throw err;
    }
  }

  /** 改角色/状态/昵称：自我保护 → 最后超管保护 → 落库（校验全部在写之前完成）。 */
  async updateAccount(operatorId: string, targetId: string, input: AdminUpdateInput): Promise<AdminUserListItem> {
    const target = await this.users.findOneBy({ id: targetId });
    if (!target) throw new NotFoundException('用户不存在，请刷新成员列表后重试');
    const nextRole = input.systemRole ?? target.systemRole;
    const nextStatus = input.status ?? target.status;

    // 防呆一：自我保护——避免超管误把自己锁在门外（mindgrid 同款语义，Gmind 统一 409）
    if (target.id === operatorId) {
      if (nextStatus !== 'active') throw new ConflictException('不能停用自己的账号，请让其他超级管理员操作');
      if (nextRole !== 'super_admin') {
        throw new ConflictException('不能取消自己的超级管理员身份，请让其他超级管理员操作');
      }
    }

    // 防呆二：最后超管保护——目标是「启用状态超管」且本次会使其离开该集合时，
    // 库中启用超管须 >1（含操作者自身）。count 口径同 mindgrid countActiveSuperAdmins；
    // 正常请求里操作者自身即占一席，此闸主要拦截并发互降/异常态（防御性第二道）。
    const wasActiveSuperAdmin = target.systemRole === 'super_admin' && target.status === 'active';
    const losesSuperAdmin = wasActiveSuperAdmin && (nextRole !== 'super_admin' || nextStatus !== 'active');
    if (losesSuperAdmin && (await this.countActiveSuperAdmins()) <= 1) {
      throw new ConflictException('至少需要保留一个启用状态的超级管理员，请先指定其他超管后再操作');
    }

    target.systemRole = nextRole;
    target.status = nextStatus;
    if (input.nickname !== undefined) target.nickname = input.nickname;
    const saved = await this.users.save(target);
    return this.toItem(saved, await this.aliveFileCount(saved.id));
  }

  /** 启用状态的超级管理员数（降级/停用前的最后防线，同 mindgrid 口径）。 */
  private countActiveSuperAdmins(): Promise<number> {
    return this.users.count({ where: { systemRole: 'super_admin', status: 'active' } });
  }

  /** 名下存活文件数（与配额 countBy 口径一致）。 */
  private aliveFileCount(userId: string): Promise<number> {
    return this.files.countBy({ ownerUserId: userId, deletedAt: IsNull() });
  }

  private toItem(u: UserEntity, fileCount: number): AdminUserListItem {
    return {
      id: u.id,
      nickname: u.nickname,
      phone: u.phone,
      email: u.email,
      systemRole: u.systemRole,
      status: u.status,
      // 防御历史脏数据（created_at='0000-00-00' 等 Date 零值）：toISOString 会抛
      // RangeError 使整个列表 500——无效日期回退 null（列表仍可用，排序在 SQL 侧）。
      createdAt: u.createdAt instanceof Date && !Number.isNaN(u.createdAt.getTime())
        ? u.createdAt.toISOString()
        : null,
      fileCount,
    };
  }
}
