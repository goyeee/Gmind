import { z } from 'zod';

/** 待办端点请求 schema（zod 先例：controller .parse，ZodExceptionFilter 转 400）。 */

export const patchTodoSchema = z
  .object({
    progress: z.number().int().min(0).max(100).optional(),
    done: z.boolean().optional(),
    /** 我的子进度（第二轮）：写自己在该任务上的全部执行来源（人员列条目 + 负责人
     *  子进度）。与总进度/完成互斥——两者语义不同，混传按错误引导。 */
    mySubProgress: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (v) =>
      v.mySubProgress !== undefined ||
      v.progress !== undefined ||
      v.done !== undefined,
    { message: '没有需要更新的字段，请至少指定进度、完成状态或我的子进度之一' },
  )
  .refine((v) => v.mySubProgress === undefined || (v.progress === undefined && v.done === undefined), {
    message: '我的子进度与任务总进度/完成是两类更新，请分开操作',
  });

export const remindTodoSchema = z.object({
  fileId: z.string().min(1),
  nodeId: z.string().min(1),
  ownerUserId: z.string().min(1),
});

/** 参与范围配置写请求（2026-11-21 追加）：canvasId 缺省 '' = 文件级排除。 */
export const scopeUpdateSchema = z.object({
  fileId: z.string().min(1).max(26),
  canvasId: z.string().max(64).optional(),
  excluded: z.boolean(),
});
