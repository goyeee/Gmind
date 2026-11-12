import type { TodoPage, TodoReport } from '@gmind/shared';
import { api, apiPatch, apiPost } from './client';

/**
 * 跨文件待办 API 薄封装（第二期批次 B/C）：数据范围服务端收敛（负责人含我+可见文件）。
 */

export function fetchTodos(view: string, tab: string, who?: string): Promise<TodoPage> {
  const whoQ = who ? `&who=${who}` : '';
  return api<TodoPage>(`/todos?view=${view}&tab=${tab}${whoQ}`);
}

export function patchTodo(fileId: string, nodeId: string, patch: { progress?: number; done?: boolean }): Promise<void> {
  return apiPatch(`/todos/${fileId}/${nodeId}`, patch);
}

export function remindTodo(fileId: string, nodeId: string, ownerUserId: string): Promise<void> {
  return apiPost('/todos/remind', { fileId, nodeId, ownerUserId });
}

export function fetchTodoReport(range: string): Promise<TodoReport> {
  return api<TodoReport>(`/todos/report?range=${range}`);
}
