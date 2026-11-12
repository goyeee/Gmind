import type { AccountStatus, AdminUserListItem, AdminUserListPage, SystemRole } from '@gmind/shared';
import { api, apiPatch, apiPost } from './client';

/**
 * 账号管理 API 薄封装（契约类型全部来自 @gmind/shared，服务端 AdminGuard 鉴权）：
 * - 列表 GET /admin/users?page&size&q（注册时间升序；2026-10-21 分页化）；
 * - 添加 POST /admin/users（2026-11-12 邮箱化：409 邮箱被占 / 400 格式，文案两段式直接 toast）；
 * - 更新 PATCH /admin/users/:id（角色/状态/昵称；409 防呆文案、404 目标不存在）。
 */

export type { AccountStatus, AdminUserListItem, AdminUserListPage, SystemRole } from '@gmind/shared';

/** 成员列表分页（仅超级管理员；member 403「仅超级管理员可执行该操作…」）。 */
export function fetchAdminUsers(page: number, size: number, q: string): Promise<AdminUserListPage> {
  const params = new URLSearchParams({ page: String(page), size: String(size) });
  if (q !== '') params.set('q', q);
  return api<AdminUserListPage>(`/admin/users?${params.toString()}`);
}

/** 添加账号：建号即启用成员、无密码（2026-11-12 邮箱化——首次登录前先走「忘记密码」
 *  邮箱验证码设密；409 邮箱被占/400 格式文案两段式直接 toast）。 */
export function createAdminUser(input: { email: string; nickname: string }): Promise<AdminUserListItem> {
  return apiPost<AdminUserListItem>('/admin/users', input);
}

/** 更新账号：字段均可选；停用/降级自己与最后超管由服务端 409 兜底；部门/分组挂靠走组织通道（批次 A）。 */
export function updateAdminUser(
  id: string,
  patch: {
    systemRole?: SystemRole;
    status?: AccountStatus;
    nickname?: string;
    departmentId?: string | null;
    groupIds?: string[];
  },
): Promise<AdminUserListItem> {
  return apiPatch<AdminUserListItem>(`/admin/users/${id}`, patch);
}
