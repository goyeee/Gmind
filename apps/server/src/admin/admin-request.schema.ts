import { z } from 'zod';
import { ACCOUNT_STATUSES, emailSchema, SYSTEM_ROLES } from '@gmind/shared';

/**
 * 账号管理端点请求 schema（照 users/files 的 zod 先例：controller 处 .parse(body)，
 * 失败由全局 ZodExceptionFilter 统一转 400 {message}，文案两段式=原因+下一步）。
 */

/** POST /api/admin/users 添加账号：邮箱口径与登录同源（shared emailSchema 单点归一 trim+lowercase）。 */
export const createAdminAccountSchema = z.object({
  email: emailSchema,
  nickname: z
    .string()
    .min(1, '昵称长度需为 1~32 字，请调整后重试')
    .max(32, '昵称长度需为 1~32 字，请调整后重试'),
});

/** PATCH /api/admin/users/:id：字段均可选但至少其一（空 patch 400）。
 *  departmentId/groupIds（组织管理批次 A）：部门单选（null=清空）、分组全量替换。 */
export const updateAdminAccountSchema = z
  .object({
    systemRole: z.enum(SYSTEM_ROLES, { message: '角色仅支持 super_admin/member，请重新选择' }).optional(),
    status: z.enum(ACCOUNT_STATUSES, { message: '状态仅支持 active/disabled，请重新选择' }).optional(),
    nickname: z
      .string()
      .min(1, '昵称长度需为 1~32 字，请调整后重试')
      .max(32, '昵称长度需为 1~32 字，请调整后重试')
      .optional(),
    departmentId: z.string().min(1).nullable().optional(),
    groupIds: z.array(z.string().min(1)).optional(),
  })
  .refine(
    (v) =>
      v.systemRole !== undefined ||
      v.status !== undefined ||
      v.nickname !== undefined ||
      v.departmentId !== undefined ||
      v.groupIds !== undefined,
    { message: '没有需要更新的字段，请至少指定角色、状态、昵称、部门或分组之一' },
  );
