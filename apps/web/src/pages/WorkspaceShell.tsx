import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, apiPost, clearToken } from '../api/client';
import { onNotifyEvent, type NotifyItem } from '../notify';

/**
 * 工作台外壳（2026-10-21 抽取自 WorkspacePage）：左侧栏导航 + 左下用户卡菜单 +
 * 顶栏（左扩展槽 + 通知铃 + 头像）三段式骨架，工作台首页/回收站/账号设置/账号管理
 * 共用同一外壳，保证布局与视觉语言一致（spec 2026-10-20-workspace-redesign-design
 * 延伸：子页面全部收进外壳）。
 *
 * - 侧栏导航跨页路由：文件类视图 → /workspace?view=xxx（WorkspacePage 以 URL
 *   search param 为视图唯一事实源），回收站 → /trash；
 * - 账号设置/账号管理从用户卡菜单进入（账号管理仅超管可见），不是侧栏一级项；
 * - 通知铃/用户菜单状态自包含，宿主页零接线。
 */

export type ShellNav = 'mine' | 'recent' | 'starred' | 'collab' | 'templates' | 'trash';

const SHELL_NAV: Array<{ key: ShellNav; label: string; icon: string; testid: string }> = [
  { key: 'mine', label: '我的文件', icon: '📁', testid: 'nav-mine' },
  { key: 'recent', label: '最近使用', icon: '🕘', testid: 'nav-recent' },
  { key: 'starred', label: '星标收藏', icon: '⭐', testid: 'nav-starred' },
  { key: 'collab', label: '协作空间', icon: '🤝', testid: 'nav-collab' },
  { key: 'templates', label: '模板库', icon: '📚', testid: 'nav-templates' },
  { key: 'trash', label: '回收站', icon: '🗑', testid: 'nav-trash' },
];

export interface ShellMe {
  id: string;
  nickname: string;
  systemRole?: 'super_admin' | 'member';
  avatar?: string | null;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** 通知铃 + 下拉（自包含：未读角标轮询装载 + onNotifyEvent 实时刷新 + 点开已读跳转）。 */
function NotifyBell(): ReactElement {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [notifs, setNotifs] = useState<NotifyItem[]>([]);
  const [bellOpen, setBellOpen] = useState(false);

  const loadUnread = useCallback(async () => {
    try {
      const { count } = await api<{ count: number }>('/notifications/unread-count');
      setUnread(count);
    } catch {
      /* 铃铛非关键路径 */
    }
  }, []);
  const loadNotifs = useCallback(async () => {
    try {
      setNotifs(await api<NotifyItem[]>('/notifications'));
    } catch {
      /* 同上 */
    }
  }, []);
  useEffect(() => {
    void loadUnread();
  }, [loadUnread]);
  useEffect(
    () =>
      onNotifyEvent(() => {
        void loadUnread();
        if (bellOpen) void loadNotifs();
      }),
    [loadUnread, loadNotifs, bellOpen],
  );

  function toggleBell(): void {
    const next = !bellOpen;
    setBellOpen(next);
    if (next) void loadNotifs();
  }

  async function openNotification(n: NotifyItem): Promise<void> {
    setBellOpen(false);
    if (n.readAt === null) {
      try {
        await apiPost(`/notifications/${n.id}/read`);
      } catch {
        /* 不阻断跳转 */
      }
      void loadUnread();
    }
    const fileId = n.payload?.fileId;
    if (fileId) {
      const nodeId = n.payload?.nodeId;
      navigate(nodeId ? `/edit/${fileId}?node=${encodeURIComponent(nodeId)}` : `/edit/${fileId}`);
    }
  }

  return (
    <div className="notify-wrap">
      <button className="notify-bell" data-testid="notify-bell" title="通知" onClick={toggleBell}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M12 22a2.2 2.2 0 0 0 2.2-2.2H9.8A2.2 2.2 0 0 0 12 22Zm7-5.6v-1.1l-1.8-1.8V9.8A5.2 5.2 0 0 0 13.3 4.7V4a1.3 1.3 0 1 0-2.6 0v.7A5.2 5.2 0 0 0 6.8 9.8v3.7L5 15.3v1.1Z"
            fill="currentColor"
          />
        </svg>
        {unread > 0 && (
          <span className="notify-badge" data-testid="notify-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {bellOpen && (
        <div className="notify-dropdown" data-testid="notify-list">
          <div className="notify-head">通知</div>
          {notifs.length === 0 && <div className="notify-empty">暂无通知</div>}
          {notifs.map((n) => (
            <div
              key={n.id}
              className={'notify-item' + (n.readAt === null ? ' unread' : '')}
              data-testid="notify-item"
              onClick={() => void openNotification(n)}
            >
              <span className="notify-item-head">
                <span className="notify-type">
                  {n.type === 'mention' ? '提及' : n.type === 'reply' ? '回复' : '通知'}
                </span>
                <span className="notify-text">
                  {n.type === 'mention'
                    ? `${n.payload?.commenterName ?? '有人'} 在「${n.payload?.title ?? '文件'}」中提到了你`
                    : n.type === 'reply'
                      ? `${n.payload?.commenterName ?? '有人'} 在「${n.payload?.title ?? '文件'}」中回复了你`
                      : (n.payload?.title ?? '')}
                </span>
              </span>
              {n.payload?.content && <span className="notify-content">{n.payload.content}</span>}
              <span className="notify-time">{fmtTime(n.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WorkspaceShell({
  activeNav,
  topbar,
  children,
}: {
  /** 当前页对应的侧栏导航项（账号设置/账号管理等用户菜单页传 null）。 */
  activeNav: ShellNav | null;
  /** 顶栏左扩展槽（工作台首页放搜索/导入/新建；子页可空）。 */
  topbar?: ReactNode;
  children: ReactNode;
}): ReactElement {
  const navigate = useNavigate();
  const [me, setMe] = useState<ShellMe | null>(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  useEffect(() => {
    void api<ShellMe>('/users/me')
      .then(setMe)
      .catch(() => undefined);
  }, []);

  return (
    <div className="ws">
      {/* 左侧栏：导航 + 用户卡 */}
      <aside className="ws-side">
        <div className="ws-logo" data-testid="ws-logo" onClick={() => navigate('/workspace')} role="link" aria-label="回到工作台">
          <span className="ws-logo-mark">G</span> Gmind
        </div>
        <nav className="ws-nav">
          {SHELL_NAV.map((n) => (
            <button
              key={n.key}
              className={'ws-nav-item' + (activeNav === n.key ? ' active' : '')}
              data-testid={n.testid}
              onClick={() => navigate(n.key === 'trash' ? '/trash' : n.key === 'mine' ? '/workspace' : `/workspace?view=${n.key}`)}
            >
              <span className="ws-nav-icon" aria-hidden>
                {n.icon}
              </span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ws-user">
          <button className="ws-user-card" data-testid="user-card" onClick={() => setUserMenuOpen((v) => !v)}>
            <span className="ws-avatar" aria-hidden>
              {(me?.nickname ?? '…').charAt(0)}
            </span>
            <span className="ws-user-name" data-testid="user-nickname">
              {me?.nickname ?? ''}
            </span>
          </button>
          {userMenuOpen && (
            <div className="ws-user-menu" data-testid="user-menu">
              <button data-testid="settings-entry" onClick={() => navigate('/settings')}>
                账号设置
              </button>
              {me?.systemRole === 'super_admin' && (
                <button data-testid="admin-users-entry" onClick={() => navigate('/admin/users')}>
                  账号管理
                </button>
              )}
              <button
                data-testid="logout-button"
                onClick={() => {
                  void api('/auth/logout', { method: 'POST' }).catch(() => undefined);
                  clearToken();
                  navigate('/login');
                }}
              >
                退出登录
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* 顶栏 + 内容区 */}
      <div className="ws-main">
        <header className="ws-topbar">
          {topbar}
          <div className="ws-top-actions">
            <NotifyBell />
            <button
              className="ws-avatar ws-avatar-top"
              data-testid="top-avatar"
              aria-label="用户菜单"
              onClick={() => setUserMenuOpen((v) => !v)}
            >
              {(me?.nickname ?? '…').charAt(0)}
            </button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
