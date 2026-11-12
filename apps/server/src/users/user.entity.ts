import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';
import type { AccountStatus, SystemRole } from '@gmind/shared';

@Entity('users')
export class UserEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null = null;

  // 邮箱注册制（2026-11-12 重做）：唯一身份键，列 NOT NULL（迁移 AuthEmailFoundation）；
  // TS 初值 '' 仅满足建空实体（admin/旧通道），注册路径必显式赋邮箱
  @Column({ type: 'varchar', length: 191 })
  email: string = '';

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'wechat_openid' })
  wechatOpenid: string | null = null;

  // 微信扫码登录预留（2026-11-12 重做 spec §3-11）：真实绑定/扫码待公众号与开放平台就绪
  @Column({ type: 'varchar', length: 64, nullable: true, name: 'wechat_unionid' })
  wechatUnionid: string | null = null;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'password_hash' })
  passwordHash: string | null = null;

  @Column({ type: 'varchar', length: 64 })
  nickname: string = '用户';

  @Column({ type: 'varchar', length: 500, nullable: true, name: 'avatar_url' })
  avatarUrl: string | null = null;

  @Column({ type: 'text', nullable: true, name: 'notify_prefs' })
  notifyPrefs: string | null = null;

  // 系统角色（账号管理，移植 mindgrid）：super_admin 可进 /api/admin/users；member 为普通成员。
  // 首注册者=超管（UsersService.create 按 count 判定），存量数据由迁移升最早用户。
  @Column({ type: 'varchar', length: 20, name: 'system_role', default: 'member' })
  systemRole: SystemRole = 'member';

  // 账号状态（只停用不删除）：disabled 时登录拒绝（401）且既有会话即刻失效
  //（UserGuard 每请求 findById 后校验，无额外查询代价）。
  @Column({ type: 'varchar', length: 20, name: 'status', default: 'active' })
  status: AccountStatus = 'active';

  // 所属部门（组织管理批次 A，2026-10-24）：可空；挂靠经组织管理页/账号管理行内改。
  @Column({ type: 'char', length: 26, nullable: true, name: 'department_id' })
  departmentId: string | null = null;

  // 显式 name 对齐迁移的 snake_case 列名（typeorm 默认用属性名，会生成 `createdAt` 而非 `created_at`）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
