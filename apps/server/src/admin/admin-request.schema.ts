import { z } from 'zod';
import { ACCOUNT_STATUSES, SYSTEM_ROLES } from '@gmind/shared';

/**
 * 账号管理端点请求 schema（照 users/files 的 zod 先例：controller 处 .parse(body)，
 * 失败由全局 ZodExceptionFilter 统一转 400 {message}，文案两段式=原因+下一步）。
 */

/** POST /api/admin/users 添加账号：手机号口径与登录 phoneLoginSchema 同源（/^1\d{10}$/）。 */
export const createAdminAccountSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/, '手机号格式不正确，请检查后重试'),
  nickname: z
    .string()
    .min(1, '昵称长度需为 1~32 字，请调整后重试')
    .max(32, '昵称长度需为 1~32 字，请调整后重试'),
});

/** PATCH /api/admin/users/:id：三字段均可选但至少其一（空 patch 400）。 */
export const updateAdminAccountSchema = z
  .object({
    systemRole: z.enum(SYSTEM_ROLES, { message: '角色仅支持 super_admin/member，请重新选择' }).optional(),
    status: z.enum(ACCOUNT_STATUSES, { message: '状态仅支持 active/disabled，请重新选择' }).optional(),
    nickname: z
      .string()
      .min(1, '昵称长度需为 1~32 字，请调整后重试')
      .max(32, '昵称长度需为 1~32 字，请调整后重试')
      .optional(),
  })
  .refine((v) => v.systemRole !== undefined || v.status !== undefined || v.nickname !== undefined, {
    message: '没有需要更新的字段，请至少指定角色、状态或昵称之一',
  });
