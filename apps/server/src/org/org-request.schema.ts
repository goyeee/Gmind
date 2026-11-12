import { z } from 'zod';

/** 组织管理端点请求 schema（zod 先例同 admin-request：controller .parse，ZodExceptionFilter 转 400）。 */

export const createDepartmentSchema = z.object({
  name: z
    .string()
    .min(1, '部门名称需为 1~32 字，请调整后重试')
    .max(32, '部门名称需为 1~32 字，请调整后重试'),
});

export const createGroupSchema = z.object({
  name: z
    .string()
    .min(1, '分组名称需为 1~32 字，请调整后重试')
    .max(32, '分组名称需为 1~32 字，请调整后重试'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, '颜色格式不正确，请重新选择')
    .optional(),
});
