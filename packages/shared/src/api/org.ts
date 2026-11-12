/**
 * 组织管理（部门/分组）契约（2026-10-24 第二期批次 A，spec 2026-10-24-phase2-features-design §二）。
 * 服务端点：写（建/删/挂靠）挂 AdminGuard；GET directory 仅需登录（UserGuard）——
 * 我的待办/待办空间的部门·分组筛选数据源。
 */

/** 部门（账号挂靠，单选）。 */
export interface OrgDepartment {
  id: string;
  name: string;
}

/** 分组（账号挂靠，多选；color 为标签底色，缺省由前端调色板取）。 */
export interface OrgGroup {
  id: string;
  name: string;
  color: string | null;
}

/** GET /api/org/directory：组织目录全量（部门/分组/成员挂靠关系）。 */
export interface OrgDirectory {
  departments: OrgDepartment[];
  groups: OrgGroup[];
  /** 有任一挂靠关系的账号（未挂靠账号不出现；挂靠查询走 AdminUserListItem 扩展字段）。 */
  memberships: Array<{ userId: string; departmentId: string | null; groupIds: string[]; nickname: string | null }>;
}
