/**
 * 账号管理（admin）契约（移植 mindgrid 账号体系，适配 Gmind 手机号登录）。
 * server 端点全部挂 AdminGuard（UserGuard + super_admin），web 按 AdminUserListItem 渲染成员列表。
 */

/** 系统角色：超级管理员可进入账号管理；member 为普通成员。 */
export const SYSTEM_ROLES = ['super_admin', 'member'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** 账号状态：只停用不删除——停用后登录与既有会话即刻失效（UserGuard 每请求查库校验）。 */
export const ACCOUNT_STATUSES = ['active', 'disabled'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** GET /api/admin/users 列表项：createdAt 为 ISO 字符串（历史脏数据防御回退 null）；fileCount 为名下存活文件数（回收站不计）。 */
export interface AdminUserListItem {
  id: string;
  nickname: string;
  phone: string | null;
  email: string | null;
  systemRole: SystemRole;
  status: AccountStatus;
  createdAt: string | null;
  fileCount: number;
}

/** GET /api/admin/users 分页响应（2026-10-21，需求方反馈「加载慢/无分页」——开发库
 *  累积 2 万+ 测试账号，全量列表不可行）：page 从 1 起，size 1~100（缺省 20），
 *  q 模糊匹配昵称/手机号/邮箱（LIKE %q%）。排序维持注册时间升序（mindgrid 口径）。 */
export interface AdminUserListPage {
  items: AdminUserListItem[];
  total: number;
  page: number;
  size: number;
}
