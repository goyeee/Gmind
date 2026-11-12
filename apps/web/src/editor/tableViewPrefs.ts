import type { TableViewMeta } from '@gmind/core';

/**
 * 表格视图显示偏好（2026-10-28 P2 归属统一裁定）：**列序/显隐/固定/排序归个人**
 * （localStorage 按文件隔离，同简洁模式/筛选视图先例）；**列定义**（customColumns
 * 的新增/改名/类型/删除）仍归文档（meta.customColumns，全员共享）。
 *
 * 此前 tableView 整体存文档导致「我想隐藏进度列→全组跟着隐藏」；本模块把显示
 * 偏好层从文档剥离。读取语义：本地有值用本地，无本地回退文档现值（迁移零成本——
 * 老文档的 tableView 作为初始默认，各用户首次改动后各自独立）。
 */

const keyOf = (fileId: string): string => `gmind.tableViewPrefs:${fileId}`;

export function readTableViewPrefs(fileId: string): Partial<TableViewMeta> | null {
  try {
    const raw = localStorage.getItem(keyOf(fileId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Partial<TableViewMeta>;
  } catch {
    return null;
  }
}

export function writeTableViewPrefs(fileId: string, next: TableViewMeta): void {
  try {
    localStorage.setItem(keyOf(fileId), JSON.stringify(next));
  } catch {
    /* 存储满等异常静默——偏好不可丢主流程 */
  }
}
