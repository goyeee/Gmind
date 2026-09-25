import { z } from 'zod';

/**
 * FR-SHR-004 批量邀请请求体：1~50 个联系人。
 * 数量边界在此层拒绝（ZodExceptionFilter → 400）；单条格式（邮箱/手机号）在
 * InviteService 分类时校验——400 需逐条回列非法条目，zod 单条 message 表达不了集合语义。
 */
export const inviteRequestSchema = z.object({
  contacts: z
    .array(z.string().min(1).max(191))
    .min(1, '至少邀请 1 个联系人')
    .max(50, '单次最多邀请 50 个联系人'),
});

export type InviteRequest = z.infer<typeof inviteRequestSchema>;
