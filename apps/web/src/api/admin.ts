import type { AccountStatus, AdminUserListItem, SystemRole } from '@gmind/shared';
import { api, apiPatch, apiPost } from './client';

/**
 * 账号管理 API 薄封装（契约类型全部来自 @gmind/shared，服务端 AdminGuard 鉴权）：
 * - 列表 GET /admin/users（注册时间升序）；
 * - 添加 POST /admin/users（409 手机号已注册 / 400 格式，文案两段式直接 toast）；
 * - 更新 PATCH /admin/users/:id（角色/状态/昵称；409 防呆文案、404 目标不存在）。
 */

export type { AccountStatus, AdminUserListItem, SystemRole } from '@gmind/shared';

/** 成员列表（仅超级管理员；member 403「仅超级管理员可执行该操作…」）。 */
export function fetchAdminUsers(): Promise<AdminUserListItem[]> {
  return api<AdminUserListItem[]>('/admin/users');
}

/** 添加账号：建号即启用成员、无密码（开发态凭手机号+验证码 123456 登录）。 */
export function createAdminUser(input: { phone: string; nickname: string }): Promise<AdminUserListItem> {
  return apiPost<AdminUserListItem>('/admin/users', input);
}

/** 更新账号：三字段均可选；停用/降级自己与最后超管由服务端 409 兜底。 */
export function updateAdminUser(
  id: string,
  patch: { systemRole?: SystemRole; status?: AccountStatus; nickname?: string },
): Promise<AdminUserListItem> {
  return apiPatch<AdminUserListItem>(`/admin/users/${id}`, patch);
}
