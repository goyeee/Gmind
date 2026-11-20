import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactElement, type ReactNode } from 'react';
import { Avatar } from '../editor/TaskFields';

import { useNavigate } from 'react-router-dom';
import { api, apiPost, clearToken } from '../api/client';
import { onNotifyEvent, type NotifyItem } from '../notify';
import { Lucide } from '../components/lucide-data';

/**
 * 工作台外壳（2026-10-21 抽取；2026-10-24 按 Figma 原型重构——spec
 * 2026-10-24-phase2-features-design + 原型 UI 口径）：
 * - 顶栏：logo（回首页）+ 居中大搜索槽 + 右侧（新建下拉/通知铃/头像）；
 * - 侧栏导航按 2026-10-27 原型顺序：首页/我的文件/我的待办/统计面板/协作空间/
 *   模板中心/组织管理（仅超管渲染），回收站沉底 + 用户卡菜单（收藏退出侧栏，
 *   并入「我的文件」收藏页签）；
 * - 「新建」为下拉：新建脑图/新建表格/从模板创建（原型同款）。
 */

export type ShellNav =
  | 'home'
  | 'todo'
  | 'space'
  | 'files'
  | 'starred'
  | 'collab'
  | 'templates'
  | 'org'
  | 'trash';

/** 主导航（2026-10-27 原型重排）：首页 → 我的文件 → 我的待办 → 统计面板 →
 *  协作空间 → 模板中心；「收藏」退出侧栏（并入「我的文件」页签，?view=starred
 *  直达路由保留）；「待办空间」更名「统计面板」。 */
const SHELL_NAV: Array<{ key: ShellNav; label: string; icon: string; testid: string }> = [
  { key: 'home', label: '首页', icon: 'House', testid: 'nav-home' },
  { key: 'files', label: '我的文件', icon: 'FolderOpen', testid: 'nav-files' },
  { key: 'todo', label: '我的待办', icon: 'ListTodo', testid: 'nav-todo' },
  { key: 'space', label: '统计面板', icon: 'ChartColumn', testid: 'nav-space' },
  { key: 'collab', label: '协作空间', icon: 'Users', testid: 'nav-collab' },
  { key: 'templates', label: '模板中心', icon: 'LayoutTemplate', testid: 'nav-templates' },
];
const TRASH_NAV = { key: 'trash' as ShellNav, label: '回收站', icon: 'Trash2', testid: 'nav-trash' };
const ORG_NAV = { key: 'org' as ShellNav, label: '组织管理', icon: 'Building2', testid: 'nav-org' };

export interface ShellMe {
  id: string;
  nickname: string;
  systemRole?: 'super_admin' | 'member';
  /** 头像（服务端 fullUserView 字段名即 avatarUrl——2026-11-18 根因修复：
   *  此前误读 me.avatar 恒 undefined，左下角永远回退预置分配、换头像不生效）。 */
  avatarUrl?: string | null;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** 通知铃 + 下拉（自包含：未读角标轮询装载 + onNotifyEvent 实时刷新 + 点开已读跳转）。
 *  类型筛选（2026-10-28 P1）：全部/提及/回复/提醒——「提醒」=催办（payload.kind=
 *  'remind'），解决「被催的人没有查看入口」：催办提醒在通知面板可单独筛出。 */
function NotifyBell(): ReactElement {
  const navigate = useNavigate();
  const [unread, setUnread] = useState(0);
  const [notifs, setNotifs] = useState<NotifyItem[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'mention' | 'reply' | 'remind'>('all');
  // 外点关闭（需求方 2026-11-16：点开通知后点其他位置应收起）：监听 document
  // pointerdown，命中 .notify-wrap 之外即收起。wrap 内含铃铛按钮本身，故点击铃铛
  // 的 toggle 语义不被本监听抢先打断。
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!bellOpen) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [bellOpen]);

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

  async function markAllRead(): Promise<void> {
    try {
      await apiPost('/notifications/read-all');
    } catch {
      /* 非关键路径：失败保持未读态，下次打开重试 */
    }
    await Promise.all([loadUnread(), loadNotifs()]);
  }

  return (
    <div className="notify-wrap" ref={wrapRef}>
      <button className="notify-bell" data-testid="notify-bell" title="通知" onClick={toggleBell}>
        <Lucide name="Bell" size={22} />
        {unread > 0 && (
          <span className="notify-badge" data-testid="notify-badge">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {bellOpen && (
        <div className="notify-dropdown" data-testid="notify-list">
          <div className="notify-head">
            通知
            {unread > 0 && (
              <button
                type="button"
                className="notify-read-all"
                data-testid="notify-read-all"
                onClick={() => void markAllRead()}
              >
                全部已读
              </button>
            )}
          </div>
          {/* 类型筛选 chips（2026-10-28 P1）：催办提醒可单独筛出 */}
          <div className="notify-filter" data-testid="notify-filter">
            {(
              [
                ['all', '全部'],
                ['mention', '提及'],
                ['reply', '回复'],
                ['remind', '提醒'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={filter === k ? 'chip active' : 'chip'}
                data-testid={`notify-filter-${k}`}
                onClick={() => setFilter(k)}
              >
                {label}
              </button>
            ))}
          </div>
          {notifs.length === 0 && <div className="notify-empty">暂无通知</div>}
          {notifs.length > 0 &&
            notifs.filter((n) => {
              if (filter === 'all') return true;
              if (filter === 'remind') return n.payload?.kind === 'remind';
              if (filter === 'mention') return n.type === 'mention' && n.payload?.kind !== 'remind';
              return n.type === filter;
            }).length === 0 && <div className="notify-empty">该类型下暂无通知</div>}
          {notifs
            .filter((n) => {
              if (filter === 'all') return true;
              if (filter === 'remind') return n.payload?.kind === 'remind';
              if (filter === 'mention') return n.type === 'mention' && n.payload?.kind !== 'remind';
              return n.type === filter;
            })
            .map((n) => (
            <div
              key={n.id}
              className={'notify-item' + (n.readAt === null ? ' unread' : '')}
              data-testid="notify-item"
              onClick={() => void openNotification(n)}
            >
              <span className="notify-item-head">
                <span className="notify-type">
                  {n.payload?.kind === 'remind' ? '提醒' : n.type === 'mention' ? '提及' : n.type === 'reply' ? '回复' : '通知'}
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
  search,
  onCreate,
  children,
}: {
  /** 当前页对应的侧栏导航项（无对应项传 null）。 */
  activeNav: ShellNav | null;
  /** 顶栏居中搜索（可选；子页可不带）。 */
  search?: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    inputRef?: MutableRefObject<HTMLInputElement | null>;
  };
  /** 「新建」下拉回调（原型：新建脑图/新建表格/从模板创建）。 */
  onCreate?: (k: 'map' | 'table' | 'template') => void;
  children: ReactNode;
}): ReactElement {
  const navigate = useNavigate();
  const [me, setMe] = useState<ShellMe | null>(null);
  const [userMenuAt, setUserMenuAt] = useState<'side' | 'top' | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  // 外点关闭（需求方 2026-11-16：点开用户菜单后点其他位置应收起）：.ws-user 包含
  // 用户卡按钮与弹出的菜单，命中其外即收起；点按钮自身的 toggle 由 onClick 处理。
  const userWrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (userMenuAt === null) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (userWrapRef.current && !userWrapRef.current.contains(e.target as Node)) setUserMenuAt(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [userMenuAt]);

  useEffect(() => {
    void api<ShellMe>('/users/me').then(setMe).catch(() => undefined);
  }, []);

  // 换头像后刷新（设置页 dispatch 'gmind:avatar-updated' → 本壳重拉 me）
  useEffect(() => {
    const onAvatarUpdated = (): void => {
      void api<ShellMe>('/users/me').then(setMe).catch(() => undefined);
    };
    window.addEventListener('gmind:avatar-updated', onAvatarUpdated);
    return () => window.removeEventListener('gmind:avatar-updated', onAvatarUpdated);
  }, []);

  function navTarget(key: ShellNav): string {
    if (key === 'trash') return '/trash';
    if (key === 'home') return '/workspace';
    if (key === 'todo') return '/todos';
    if (key === 'space') return '/todo-space';
    if (key === 'org') return '/admin/users';
    return `/workspace?view=${key}`;
  }

  const userMenu = userMenuAt === null ? null : (
    <div className={'ws-user-menu' + (userMenuAt === 'top' ? ' ws-user-menu-top' : '')} data-testid="user-menu">
      <button data-testid="settings-entry" onClick={() => navigate('/settings')}>
        设置
      </button>
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
  );

  const navItem = (n: { key: ShellNav; label: string; icon: string; testid: string }) => {
    const active = activeNav === n.key;
    return (
      <button
        key={n.key}
        className={'ws-nav-item' + (active ? ' active' : '')}
        data-testid={n.testid}
        aria-current={active ? 'page' : undefined}
        title={n.label}
        onClick={() => navigate(navTarget(n.key))}
      >
        <Lucide name={n.icon} size={20} fill={active ? 'currentColor' : 'none'} fillOpacity={0.25} />
        {n.label}
      </button>
    );
  };

  return (
    <div className="ws">
      {/* 通栏顶栏（原型 Shell）：logo + 分隔线 + 搜索 + 新建主钮/通知；侧栏在其下方 */}
      <header className="ws-header">
        <button className="ws-logo" data-testid="ws-logo" aria-label="回到工作台" onClick={() => navigate('/workspace')}>
          <Lucide name="Share2" size={22} strokeWidth={2.6} />
          <span className="ws-logo-text">Gmind</span>
        </button>
        <i className="ws-header-sep" aria-hidden />
        {search ? (
          <label className="ws-search">
            <Lucide name="Search" size={18} />
            <input
              data-testid="search-input"
              ref={(el) => {
                if (search.inputRef) search.inputRef.current = el;
              }}
              placeholder={search.placeholder ?? '搜索文件、模板...'}
              value={search.value}
              onChange={(e) => search.onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') search.onSubmit();
              }}
            />
            {search.value !== '' && (
              <button type="button" aria-label="清除搜索" onClick={() => search.onChange('')}>
                <Lucide name="X" size={15} />
              </button>
            )}
          </label>
        ) : (
          <span className="ws-search ws-search-empty" aria-hidden />
        )}
        <div className="ws-header-actions">
          {onCreate && (
            <div className="ws-create-wrap">
              <button className="ws-create-primary" data-testid="new-file-btn" onClick={() => setCreateOpen((v) => !v)}>
                <Lucide name="Plus" size={18} />
                新建
              </button>
              {createOpen && (
                <>
                  <div className="popover-mask" onClick={() => setCreateOpen(false)} />
                  <div className="ws-create-menu" data-testid="create-menu">
                    <button
                      data-testid="create-menu-map"
                      onClick={() => {
                        setCreateOpen(false);
                        onCreate('map');
                      }}
                    >
                      <Lucide name="Network" size={16} />
                      新建脑图
                    </button>
                    <button
                      data-testid="create-menu-table"
                      onClick={() => {
                        setCreateOpen(false);
                        onCreate('table');
                      }}
                    >
                      <Lucide name="Table2" size={16} />
                      新建表格
                    </button>
                    <button
                      data-testid="create-menu-template"
                      onClick={() => {
                        setCreateOpen(false);
                        onCreate('template');
                      }}
                    >
                      <Lucide name="LayoutTemplate" size={16} />
                      从模板创建
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <NotifyBell />
        </div>
      </header>

      <div className="ws-body">
        {/* 侧栏（原型 Sidebar）：导航 + 超管组织管理 + 回收站沉底 + 用户卡（名+部门+设置） */}
        <aside className="ws-side">
          <nav className="ws-nav" aria-label="主导航">
            {SHELL_NAV.map(navItem)}
            {me?.systemRole === 'super_admin' && (
              <>
                <div className="ws-nav-divider" aria-hidden />
                {navItem(ORG_NAV)}
              </>
            )}
          </nav>
          <div className="ws-side-bottom">
            <div className="ws-nav">{navItem(TRASH_NAV)}</div>
          </div>
          <div className="ws-user" ref={userWrapRef}>
            <button
              className="ws-user-card"
              data-testid="user-card"
              onClick={() => setUserMenuAt((v) => (v === 'side' ? null : 'side'))}
            >
              <span className="ws-avatar" aria-hidden>
                {/* 2026-11-19 需求方「头像不要有圆环」：38px 图片撑满 .ws-avatar 圆，
                    紫圈不露出；白描边由 workspace.css 作用域规则去掉 */}
                {me ? <Avatar userId={me.id} nickname={me.nickname} avatar={me.avatarUrl} size={38} /> : '…'}
              </span>
              <span className="ws-user-meta">
                <span className="ws-user-name" data-testid="user-nickname">
                  {me?.nickname ?? ''}
                </span>
                <span className="ws-user-sub">{me?.systemRole === 'super_admin' ? '管理员' : '普通成员'}</span>
              </span>
              <Lucide name="Settings" size={17} className="ws-user-gear" />
            </button>
            {userMenuAt === 'side' && userMenu}
          </div>
        </aside>

        {/* 内容区（原型 main：弹性留白 + 纵向滚动) */}
        <main className="ws-content">{children}</main>
      </div>
    </div>
  );
}

