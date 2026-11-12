import type { OrgDepartment, OrgDirectory, OrgGroup } from '@gmind/shared';
import { api, apiDel, apiPost } from './client';

/**
 * 组织管理（部门/分组）API 薄封装（第二期批次 A）：读登录即可、写仅超管（服务端
 * AdminGuard）。挂靠走 updateAdminUser 的 departmentId/groupIds 扩展（见 api/admin）。
 */

export function fetchOrgDirectory(): Promise<OrgDirectory> {
  return api<OrgDirectory>('/org/directory');
}

export function createOrgDepartment(name: string): Promise<OrgDepartment> {
  return apiPost<OrgDepartment>('/org/departments', { name });
}

export function deleteOrgDepartment(id: string): Promise<void> {
  return apiDel(`/org/departments/${id}`);
}

export function createOrgGroup(name: string): Promise<OrgGroup> {
  return apiPost<OrgGroup>('/org/groups', { name });
}

export function deleteOrgGroup(id: string): Promise<void> {
  return apiDel(`/org/groups/${id}`);
}
