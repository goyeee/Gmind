import type { TodoActivityItem, TodoPage, TodoReport, TodoScope } from '@gmind/shared';
import { api, apiPatch, apiPost, apiPut } from './client';

/**
 * 跨文件待办 API 薄封装（第二期批次 B/C；2026-11-21 第二轮扩口径）：
 * 数据范围服务端收敛（负责人或参与人含我+可见文件）。
 */

export function fetchTodos(view: string, tab: string, who?: string): Promise<TodoPage> {
  const whoQ = who ? `&who=${who}` : '';
  return api<TodoPage>(`/todos?view=${view}&tab=${tab}${whoQ}`);
}

export function patchTodo(
  fileId: string,
  nodeId: string,
  patch: { progress?: number; done?: boolean; mySubProgress?: number },
): Promise<void> {
  return apiPatch(`/todos/${fileId}/${nodeId}`, patch);
}

export function remindTodo(fileId: string, nodeId: string, ownerUserId: string): Promise<void> {
  return apiPost('/todos/remind', { fileId, nodeId, ownerUserId });
}

export function fetchTodoReport(range: string): Promise<TodoReport> {
  return api<TodoReport>(`/todos/report?range=${range}`);
}

/** 跨文件任务动态流（第二轮）：行点击跳文件编辑器，范围=与我相关 ∪ 我操作。 */
export function fetchTodoActivity(limit = 50): Promise<{ items: TodoActivityItem[] }> {
  return api<{ items: TodoActivityItem[] }>(`/todos/activity?limit=${limit}`);
}

/** 参与范围配置读侧（2026-11-21 追加）：我可见文件 + 有任务画布 + 排除行。 */
export function fetchTodoScope(): Promise<TodoScope> {
  return api<TodoScope>('/todos/scope');
}

/** 增删排除行（幂等）：canvasId 缺省（''）= 文件级；excluded=false = 恢复参与。 */
export function updateTodoScope(input: { fileId: string; canvasId?: string; excluded: boolean }): Promise<{ ok: true }> {
  return apiPut('/todos/scope', { fileId: input.fileId, canvasId: input.canvasId ?? '', excluded: input.excluded });
}
