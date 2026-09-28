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
 */
const TYPE_LABEL: Record<string, string> = {
  comment_create: '评论',
  export_done: '导出',
  version_restore: '恢复版本',
  doc_create: '创建文档',
  invite_send: '邀请',
  collab_join: '加入协作',
};

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

/** payload 携带 title/memberName 时带入描述（brief 口径：如邀请/加入协作的事件载荷）；
 *  其余类型（评论/导出等载荷为 nodeId/format 等内部字段）不硬译——描述行留空。 */
function describePayload(payload: Record<string, unknown> | null): string | null {
  if (payload === null) return null;
  const memberName = typeof payload.memberName === 'string' ? payload.memberName.trim() : '';
  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  const parts: string[] = [];
  if (memberName !== '') parts.push(memberName);
  if (title !== '') parts.push(`「${title}」`);
  return parts.length > 0 ? parts.join(' ') : null;
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
 *   null 兜底 '—'）+ 类型中文（TYPE_LABEL）+ 可选描述（payload 的 title/memberName）
 *   + 相对时间；
 * - testid activity-panel / activity-item-{id} / activity-panel-close；空态「暂无动态」；
 * - 拉取失败呈现空态（旁路视图不打扰编辑主流程）。
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
          {items.map((item) => {
            const desc = describePayload(item.payload);
            return (
              <li key={item.id} className="activity-item" data-testid={`activity-item-${item.id}`}>
                <div className="activity-item-head">
                  <span className="activity-item-user">{item.userName ?? '—'}</span>
                  <span className="activity-item-action">{TYPE_LABEL[item.type] ?? item.type}</span>
                </div>
                {desc !== null && <p className="activity-item-desc">{desc}</p>}
                <time className="activity-item-time">{relativeTime(item.createdAt)}</time>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
