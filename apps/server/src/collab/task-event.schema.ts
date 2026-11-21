import { z } from 'zod';
import type { TaskEventPayload } from '@gmind/shared';

/**
 * 任务动态声明（stateless 通道，第二轮 spec §5.5）：客户端在用户级任务写入口成功后
 * 经 provider.sendStateless 发 {type:'task-event', ...声明}；服务端处理器以连接身份
 * **盖章操作者**（payload.actor 一律覆盖）、拒绝 readOnly 连接、校验形状后落 events 表。
 * taskText/canvasId 由服务端从内存文档现值覆盖（不信任客户端文案）；related 仅做
 * 形状收敛（字符串数组、去重、上限）——它是「与我相关」查询依据，伪造只影响声明者
 * 自己的可见范围（如实登记的已知限制，不影响他人数据）。
 */

const ULID_RE = /^[0-9A-Z]{26}$/;

const statusProgress = z.object({
  status: z.string().max(16),
  progress: z.number().int().min(0).max(100),
});

/** 服务端落库前的最终 payload 形状（盖章/覆盖后），与 shared TaskEventPayload 对齐。 */
export type StampedTaskEventPayload = TaskEventPayload;

/** 客户端声明形状校验（宽松：额外键由显式字段白名单剔除）。 */
export const taskEventDeclSchema = z.object({
  /** 事件类型（粗集六类 + 子进度归 task_progress，与 shared TodoActivityType 同值域）。 */
  kind: z.enum([
    'task_assign',
    'task_assignee_add',
    'task_assignee_remove',
    'task_progress',
    'task_status',
    'task_complete',
    'task_reopen',
  ]),
  nodeId: z.string().max(64),
  /** 声明的操作者一律被服务端盖章覆盖——字段仅用于兼容旧客户端形状，不参与落库。 */
  actor: z.string().max(64).optional(),
  /** 操作瞬间相关人员（负责人+人员列成员）；服务端去重/收敛后并入 actor。 */
  related: z.array(z.string().regex(ULID_RE)).max(100).optional(),
  before: statusProgress.nullable().optional(),
  after: statusProgress.nullable().optional(),
  sub: z
    .object({
      user: z.string().regex(ULID_RE),
      before: z.number().int().min(0).max(100),
      after: z.number().int().min(0).max(100),
      colName: z.string().max(100).nullable().optional(),
    })
    .optional(),
  owner: z
    .object({ before: z.string().regex(ULID_RE).nullable(), after: z.string().regex(ULID_RE).nullable() })
    .optional(),
  member: z
    .object({
      user: z.string().regex(ULID_RE),
      colName: z.string().max(100).nullable().optional(),
    })
    .optional(),
});

export type TaskEventDecl = z.infer<typeof taskEventDeclSchema>;
