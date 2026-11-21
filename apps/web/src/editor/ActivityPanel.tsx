import { useEffect, useState } from 'react';
import { api } from '../api/client';
import './activity-panel.css';

/** 服务端条目形状（GET /files/:fileId/events?limit=50 → {items}，created_at DESC）。 */
interface ActivityItem {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  userName: string | null;
}

/**
 * 既有埋点事件类型 → 中文动作名（M6 Task 8 裁定：服务端只回 type 原值，中文化是
 * web 侧职责）；未知类型回原值（events 是开放遥测通道，新类型先落库后补映射）。
 * 任务动态类型（第二轮 spec §5.5）：task_* 行的 payload 渲染安全性由服务端保证——
 * task_ 前缀在开放上报端点 400 保留（event.schema.ts），盖章通道 actor/taskText 均
 * 服务端盖章/覆盖，故摘要文案可安全引用 payload。
 */
const TYPE_LABEL: Record<string, string> = {
  comment_create: '评论',
  export_done: '导出',
  version_restore: '恢复版本',
  doc_create: '创建文档',
  invite_send: '邀请',
  collab_join: '加入协作',
};

/** 任务动态 payload（GET /files/:id/events 条目的 payload 还原对象；损坏行 null）。 */
interface TaskEventShape {
  taskText?: unknown;
  sub?: { user?: unknown; after?: unknown } | null;
  after?: { progress?: unknown } | null;
}

/** 任务动态类型 → 行摘要（task_* 专用；与待办页动态流的文案各自实现，裁定 6）。 */
function taskEventLabel(type: string, payload: Record<string, unknown> | null): string {
  const p = (payload ?? {}) as TaskEventShape;
  const task = typeof p.taskText === 'string' ? p.taskText : '';
  const taskPart = task === '' ? '' : `：${task}`;
  switch (type) {
    case 'task_assign':
      return `指派了负责人${taskPart}`;
    case 'task_assignee_add':
      return `添加了执行人${taskPart}`;
    case 'task_assignee_remove':
      return `移除了执行人${taskPart}`;
    case 'task_complete':
      return `完成了任务${taskPart}`;
    case 'task_reopen':
      return `重新打开了任务${taskPart}`;
    case 'task_status':
      return `更新了状态${taskPart}`;
    case 'task_progress':
      if (p.sub && typeof p.sub.after === 'number') return `更新子进度到 ${p.sub.after}%${taskPart}`;
      if (p.after && typeof p.after.progress === 'number') return `更新进度到 ${p.after.progress}%${taskPart}`;
      return `更新了进度${taskPart}`;
    default:
      return type;
  }
}

/** 相对时间：<1min 刚刚 / N 分钟前 / N 小时前 / N 天前（<7 天）/ 跨周 MM-DD HH:mm。 */
function relativeTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '--';
  const diffMs = Date.now() - at.getTime();
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  const mo = String(at.getMonth() + 1).padStart(2, '0');
  const dd = String(at.getDate()).padStart(2, '0');
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

export interface ActivityPanelProps {
  fileId: string;
  open: boolean;
  onClose(): void;
}

/**
 * 文档动态面板 — M6 Task 8（企微对标，FR-COL-007 提前）。
 *
 * - 抽屉复用 ThemePanel 模式（右上角工具栏下方浮层；open=false 时 return null
 *   整棵不渲染，重开由 effect 上升沿自然重拉——面板是旁路视图，不订阅推送）；
 * - 列表 = 服务端 created_at DESC 直渲染（新→旧）；条目 = 操作人中文名（userName，
 *   null 兜底 '—'）+ 类型中文（TYPE_LABEL）+ 相对时间；
 *   **payload 渲染仅限 task_* 任务动态**（第二轮 spec §5.5）：task_ 前缀在开放上报
 *   端点保留 400（event.schema.ts），行值全出自盖章/服务端直记/重建补记三条可信
 *   路径（actor 连接身份、taskText 文档现值），摘要文案才可引用 payload；其余类型
 *   维持 M6 Task 8 裁定不渲染任意字段——POST /api/events 是开放遥测通道，按
 *   title/memberName 白名单渲染仍属开放面；
 * - testid activity-panel / activity-item-{id} / activity-panel-close；空态「暂无动态」；
 *   拉取失败呈现空态（旁路视图不打扰编辑主流程）。
 */
export function ActivityPanel({ fileId, open, onClose }: ActivityPanelProps) {
  // null = 加载中；[] = 无动态（含拉取失败的收敛呈现）
  const [items, setItems] = useState<ActivityItem[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api<{ items: ActivityItem[] }>(`/files/${fileId}/events?limit=50`)
      .then((r) => {
        if (alive) setItems(r.items);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [open, fileId]);

  if (!open) return null;
  return (
    <aside className="activity-panel" data-testid="activity-panel" aria-label="文档动态">
      <header className="activity-panel-header">
        <span className="activity-panel-title">动态</span>
        <button
          type="button"
          className="activity-panel-close"
          data-testid="activity-panel-close"
          aria-label="关闭动态面板"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      {items === null ? (
        <p className="activity-panel-empty">加载中…</p>
      ) : items.length === 0 ? (
        <p className="activity-panel-empty" data-testid="activity-empty">
          暂无动态
        </p>
      ) : (
        <ul className="activity-items">
          {items.map((item) => (
            <li key={item.id} className="activity-item" data-testid={`activity-item-${item.id}`}>
              <div className="activity-item-head">
                <span className="activity-item-user">{item.userName ?? '—'}</span>
                <span className="activity-item-action">
                  {item.type.startsWith('task_') ? taskEventLabel(item.type, item.payload) : (TYPE_LABEL[item.type] ?? item.type)}
                </span>
              </div>
              <time className="activity-item-time">{relativeTime(item.createdAt)}</time>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
