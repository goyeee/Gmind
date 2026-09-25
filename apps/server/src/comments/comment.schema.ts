import { z } from 'zod';

/**
 * 评论域请求体（M3b Task 6，FR-CMT-001）。
 *
 * content：1~500 字符（按码点计数——与 node_text_snapshot varchar(500) 的字符口径一致，
 * z.string().max 的 UTF-16 code unit 计数会把 500 个 emoji 误拒为 1000，故用 refine）；
 * 内容原样存储（前端 React 转义，服务端只做长度边界，FR-CMT-001）。
 * mentions：可选的 userId 数组——格式在此层，语义（是否为本文件协作者/owner）在
 * service 层归一化过滤（非法 userId 静默剔除而非 400，见 CommentsService）。
 */
const contentSchema = z
  .string({ required_error: '评论内容不能为空' })
  .min(1, '评论内容不能为空')
  .refine((s) => Array.from(s).length <= 500, '评论内容最多 500 字');

const mentionsSchema = z.array(z.string().min(1)).optional();

/** POST /api/files/:id/comments：{nodeId, content, mentions?}。 */
export const createCommentSchema = z.object({
  // nodeId 形状从宽（ULID 26 位或 'root'）：不存在/已删统一在 service 层 400
  // 「节点不存在或已删除」，schema 层只拦空值
  nodeId: z.string().min(1, 'nodeId 不能为空').max(64),
  content: contentSchema,
  mentions: mentionsSchema,
});

/** POST /api/files/:id/comments/:commentId/replies：{content, mentions?}。
 *  回复不做节点存在性校验（讨论不随节点死亡终止，binding 裁定）。 */
export const createReplySchema = z.object({
  content: contentSchema,
  mentions: mentionsSchema,
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type CreateReplyInput = z.infer<typeof createReplySchema>;
