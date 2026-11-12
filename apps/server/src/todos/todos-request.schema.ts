import { z } from 'zod';

/** 待办端点请求 schema（zod 先例：controller .parse，ZodExceptionFilter 转 400）。 */

export const patchTodoSchema = z
  .object({
    progress: z.number().int().min(0).max(100).optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => v.progress !== undefined || v.done !== undefined, {
    message: '没有需要更新的字段，请至少指定进度或完成状态之一',
  });

export const remindTodoSchema = z.object({
  fileId: z.string().min(1),
  nodeId: z.string().min(1),
  ownerUserId: z.string().min(1),
});
