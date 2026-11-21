import { assigneeEntriesOf, getNode } from '@gmind/core';
import type * as Y from 'yjs';

/**
 * 任务动态声明（第二轮 spec §5.5）：编辑器内每次用户级任务写（面板/表格/画布选盘等
 * ORIGIN_USER 写入口）成功后经既有 stateless 通道发声明，服务端以连接身份盖章落
 * events 表——操作者全链路不信任客户端声明（评审重点 3）。
 *
 * - trackTaskWrite 包装器：写前快照 → 执行 → 写后声明；write 抛错则无声明
 *   （校验先于事务，无写即无事件）；同值守卫零写入（前后一致）也不发；
 * - sink 由 EditorPage 装配 collab 后注册（provider.sendStateless），销毁时置 null；
 *   断线期间声明入队、重连后补发（provider.send 不抛错），页面销毁才真丢（评审
 *   P3-2 修正措辞）；撤销/重做不经声明入口，不留事件；事件不做同人短时合并（待办
 *   页滑条一次拖拽≈20 条进度事件，量级已知）；
 * - related = 写前相关人员快照 ∪ 声明对象（移除/换负责人场景的被移除者不丢）；
 *   服务端盖章时再 ∪ 文档现值 ∪ actor，最终口径以服务端为准。
 */

export type TaskWriteIntent = 'total' | 'sub' | 'owner' | 'member-add' | 'member-remove' | 'complete';

type Sink = (message: string) => void;
let sink: Sink | null = null;

/** EditorPage 装配 collab 后注册（provider.sendStateless）；destroy 时置 null。 */
export function setTaskEventSink(next: Sink | null): void {
  sink = next;
}

interface TaskSummary {
  status: string;
  progress: number;
}

function summaryOf(doc: Y.Doc, nodeId: string, canvasId: string | undefined): TaskSummary | null {
  const snap = getNode(doc, nodeId, canvasId);
  if (!snap || snap.deleted) return null;
  return { status: snap.task.status, progress: snap.task.progress };
}

/** 写前相关人员快照（总负责人 + 全体人员列成员）。 */
function relatedOf(doc: Y.Doc, nodeId: string, canvasId: string | undefined): string[] {
  const snap = getNode(doc, nodeId, canvasId);
  const owner = snap !== null && snap.task.ownerId !== null ? [snap.task.ownerId] : [];
  return [...owner, ...assigneeEntriesOf(doc, nodeId, canvasId).map((e) => e.user)];
}

export interface TaskWriteDetail {
  /** intent='sub'：子进度对象与前后值（负责人子进度/人员列条目）。 */
  sub?: { user: string; before: number; after: number; colName?: string | null };
  /** intent='owner'：新旧负责人。 */
  owner?: { before: string | null; after: string | null };
  /** intent='member-add'/'member-remove'：对象成员与列名。 */
  member?: { user: string; colName?: string | null };
}

/**
 * 用户级任务写包装器。write 抛错即无声明（异常向调用方传播，由既有 try/catch 呈现）。
 * intent='total'：由前后值细化事件类型——100=完成（task_complete）、完成态回非 100=重开
 * （task_reopen）、进度变化=task_progress、仅状态变化=task_status；前后一致（同值守卫
 * 零写）不发事件。
 */
export function trackTaskWrite(
  doc: Y.Doc,
  canvasId: string | undefined,
  nodeId: string,
  intent: TaskWriteIntent,
  write: () => void,
  detail: TaskWriteDetail = {},
): void {
  const before = summaryOf(doc, nodeId, canvasId);
  const preRelated = relatedOf(doc, nodeId, canvasId);
  write();
  const after = summaryOf(doc, nodeId, canvasId);
  if (!sink || before === null || after === null) return;
  const related = [...new Set([...preRelated, ...(detail.sub ? [detail.sub.user] : []), ...(detail.member ? [detail.member.user] : [])])];
  let kind: string;
  const decl: Record<string, unknown> = { nodeId, related };
  switch (intent) {
    case 'owner':
      if (detail.owner === undefined) return;
      kind = 'task_assign';
      decl.owner = detail.owner;
      break;
    case 'member-add':
    case 'member-remove':
      if (detail.member === undefined) return;
      kind = intent === 'member-add' ? 'task_assignee_add' : 'task_assignee_remove';
      decl.member = detail.member;
      break;
    case 'sub':
      if (detail.sub === undefined) return;
      kind = 'task_progress';
      decl.sub = detail.sub;
      break;
    case 'complete':
      kind = 'task_complete';
      decl.before = before;
      decl.after = after;
      break;
    case 'total':
    default: {
      if (after.progress === 100 && before.progress < 100) {
        kind = 'task_complete';
      } else if ((before.status === 'done' || before.progress === 100) && after.progress < 100) {
        kind = 'task_reopen';
      } else if (after.progress !== before.progress) {
        kind = 'task_progress';
      } else if (after.status !== before.status) {
        kind = 'task_status';
      } else {
        return; // 前后一致：同值守卫零写，无事件
      }
      decl.before = before;
      decl.after = after;
      break;
    }
  }
  sink(JSON.stringify({ type: 'task-event', decl: { kind, ...decl } }));
}
