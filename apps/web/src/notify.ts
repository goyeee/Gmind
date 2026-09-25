import { getToken } from './api/client';

/** 站内通知（M3b Task 8，FR-CMT-005）：SSE 订阅与事件分发。
 *
 * 连接策略（binding 裁定）：每个应用加载至多一条连接——App.tsx 在路由挂载/切换时调用
 * connectNotifications()（已连接或未登录为 no-op），登录后首次导航即建立连接；断线
 * 重连不写自旋循环，只靠「error 时关闭 + 下次路由切换重建」+ EventSource 内建重试。
 *
 * token 经 query 传递（GET /api/notify?token=...）：EventSource 浏览器 API 不允许
 * 自定义 header，与 WS 升级 ?token= 的裁定同口径；服务端同路径校验会话。
 */

/** SSE 推送事件（服务端 NotifyService.push 的帧体）。 */
export interface NotifyEvent {
  id: string;
  type: 'mention' | 'reply' | 'permission' | 'system';
  payload: {
    fileId?: string;
    title?: string;
    commenterId?: string;
    commenterName?: string;
    content?: string;
    nodeId?: string;
  } | null;
  createdAt: string;
}

/** 通知中心条目（GET /api/notifications）。 */
export interface NotifyItem extends NotifyEvent {
  readAt: string | null;
}

type Listener = (event: NotifyEvent) => void;

const listeners = new Set<Listener>();
let es: EventSource | null = null;

/** 建立 SSE 连接（幂等）：未登录 / 已连接时 no-op。onopen 置 window.__gmindNotifyReady
 *  供 e2e 等待握手完成；onerror 关闭并复位（下次 connectNotifications 调用重建）。 */
export function connectNotifications(): void {
  const token = getToken();
  if (!token || es) return;
  es = new EventSource(`/api/notify?token=${encodeURIComponent(token)}`);
  es.onopen = () => {
    (window as unknown as Record<string, unknown>)['__gmindNotifyReady'] = true;
  };
  es.onmessage = (e: MessageEvent<string>) => {
    let event: NotifyEvent;
    try {
      event = JSON.parse(e.data) as NotifyEvent;
    } catch {
      return; // 坏帧丢弃（服务端写入恒为 JSON，理论不可达）
    }
    for (const listener of listeners) listener(event);
  };
  es.onerror = () => {
    es?.close();
    es = null;
    (window as unknown as Record<string, unknown>)['__gmindNotifyReady'] = false;
  };
}

/** 订阅推送事件（UI 层据此刷新未读角标/列表），返回取消订阅函数。 */
export function onNotifyEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
