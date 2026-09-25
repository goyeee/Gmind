import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FileListItemDetailed, FolderItem } from '@gmind/shared';
import { api, apiDel, apiPatch, apiPost, apiPut } from '../api/client';
import { degradedSummary, importXmindFile } from '../editor/xmind-import';
import { onNotifyEvent, type NotifyItem } from '../notify';

/** 四视图（FR-FIL-001）：GET /api/files?view= 的合法值与页签文案。 */
type View = 'mine' | 'shared' | 'starred' | 'recent';

const VIEW_TABS: Array<{ key: View; label: string }> = [
  { key: 'mine', label: '我的文件' },
  { key: 'shared', label: '与我协作' },
  { key: 'starred', label: '星标' },
  { key: 'recent', label: '最近打开' },
];

/** 命名类弹窗的三种用途（统一 data-testid="rename-modal"，e2e 可稳定定位）： */
type PromptState =
  | { kind: 'file-rename'; fileId: string; title: string }
  | { kind: 'folder-create'; parentId: string | null }
  | { kind: 'folder-rename'; folderId: string; name: string };

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** 搜索结果标题高亮（M3b 清偿包，FR-FIL-008）：首个匹配片段（大小写不敏感，与服务端
 *  utf8mb4_unicode_ci 的 LIKE 口径对齐）包 <mark data-testid="search-hit">；未命中
 *  （如搜索态内改名后标题不再含 q）原样返回不折行。 */
function highlightTitle(title: string, q: string): ReactNode {
  const idx = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (idx === -1) return title;
  return (
    <>
      {title.slice(0, idx)}
      <mark data-testid="search-hit">{title.slice(idx, idx + q.length)}</mark>
      {title.slice(idx + q.length)}
    </>
  );
}

export function WorkspacePage() {
  const navigate = useNavigate();
  // me.id（M3b 清偿包）：行菜单删除/移动的 owner-only 判定（视图无关）
  const [me, setMe] = useState<{ id: string; nickname: string } | null>(null);
  const [view, setView] = useState<View>('mine');
  const [items, setItems] = useState<FileListItemDetailed[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  /** 选中的文件夹（客户端过滤：mine 视图条目按 folderId+后代筛，裁定口径）。 */
  const [folderId, setFolderId] = useState<string | null>(null);
  /** 非 null 即搜索结果态：替换列表与页签，清除按钮返回。 */
  const [search, setSearch] = useState<{ q: string; results: FileListItemDetailed[] } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [promptValue, setPromptValue] = useState('');
  const [promptError, setPromptError] = useState('');
  const [moveTarget, setMoveTarget] = useState<FileListItemDetailed | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // 站内通知（M3b Task 8，FR-CMT-005）：未读角标 + 通知下拉；事件由 notify.ts 的
  // SSE 连接分发（App.tsx 建连），此处只消费
  const [unread, setUnread] = useState(0);
  const [notifs, setNotifs] = useState<NotifyItem[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  // 分享/复制等动作的轻提示（M3b Task 4，FR-SHR-001）：复用 EditorPage 的 toast 形态
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // XMind 导入入口（M4 Task 4）：隐藏 file input，由「导入」按钮代点
  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Ctrl/Cmd+Shift+F 聚焦搜索框（M3b 清偿包，FR-FIL-008）：document 级监听，
  // Shift 使 key 为 'F'，统一按小写比较；Ctrl 与 Cmd（macOS）都算命中。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const loadFiles = useCallback(async (v: View) => {
    setItems(await api<FileListItemDetailed[]>(`/files?view=${v}`));
  }, []);
  const loadFolders = useCallback(async () => {
    setFolders(await api<FolderItem[]>('/folders'));
  }, []);

  useEffect(() => {
    void api<{ id: string; nickname: string }>('/users/me').then(setMe).catch(() => undefined);
    void loadFiles('mine').catch((e) => setError(msgOf(e)));
    void loadFolders().catch((e) => setError(msgOf(e)));
  }, [loadFiles, loadFolders]);

  // ---- 通知中心（M3b Task 8，FR-CMT-005）----------------------------------
  const loadUnread = useCallback(async () => {
    try {
      const { count } = await api<{ count: number }>('/notifications/unread-count');
      setUnread(count);
    } catch {
      // 铃铛是非关键路径：失败保持现状（不进全局 error 条）
    }
  }, []);
  const loadNotifs = useCallback(async () => {
    try {
      setNotifs(await api<NotifyItem[]>('/notifications'));
    } catch {
      // 同上：下拉打开失败静默，保留旧列表
    }
  }, []);

  useEffect(() => {
    void loadUnread();
  }, [loadUnread]);

  // SSE 推送到达：未读数重取；下拉展开时连列表一起刷新
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

  /** 点击通知条目：未读则标记已读（POST :id/read）+ 角标重取，随后按 payload.fileId
   *  跳转编辑页（mention/reply 均锚定文件）；无 fileId 的通知仅关闭下拉。 */
  async function openNotification(n: NotifyItem): Promise<void> {
    setBellOpen(false);
    if (n.readAt === null) {
      try {
        await apiPost(`/notifications/${n.id}/read`);
      } catch {
        // 已读失败不阻断跳转（下次进入工作台角标自会纠正）
      }
      void loadUnread();
    }
    const fileId = n.payload?.fileId;
    if (fileId) navigate(`/edit/${fileId}`);
  }

  /** 变更后回刷：搜索态重跑同一关键词（更新 results），列表态回刷当前视图。 */
  async function refresh(): Promise<void> {
    if (search) {
      const results = await api<FileListItemDetailed[]>(`/search?q=${encodeURIComponent(search.q)}`);
      setSearch({ q: search.q, results });
      return;
    }
    await loadFiles(view);
  }

  function withReload(fn: () => Promise<unknown>): () => void {
    return () => {
      setMenuFor(null);
      void fn()
        .then(() => refresh())
        .catch((e) => setError(msgOf(e)));
    };
  }

  async function switchView(v: View): Promise<void> {
    setView(v);
    setFolderId(null);
    setSearch(null);
    setSearchText('');
    setMenuFor(null);
    try {
      await loadFiles(v);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 点击文件夹行：客户端过滤 + 必要时切回 mine 视图（过滤只作用于 mine 条目）。 */
  function openFolder(id: string | null): void {
    setFolderId(id);
    setMenuFor(null);
    if (view !== 'mine') {
      setView('mine');
      void loadFiles('mine').catch((e) => setError(msgOf(e)));
    }
  }

  async function runSearch(): Promise<void> {
    const q = searchText.trim();
    if (!q) return;
    setMenuFor(null);
    try {
      const results = await api<FileListItemDetailed[]>(`/search?q=${encodeURIComponent(q)}`);
      setSearch({ q, results });
      setError('');
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 清除搜索：回页签并回刷底层列表（fix round 1——搜索态的变更只重跑了搜索、
   *  未回刷 items，不清列表会出现已删文件复现/旧标题/旧星标的陈旧列表）。 */
  async function clearSearch(): Promise<void> {
    setSearch(null);
    setSearchText('');
    setError('');
    try {
      await loadFiles(view);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  async function createFile(): Promise<void> {
    try {
      await apiPost('/files', {});
      // 新文件落在根目录：退出过滤/搜索/其他视图，保证「新建即见」（M0 验收口径）
      setView('mine');
      setFolderId(null);
      setSearch(null);
      setSearchText('');
      await loadFiles('mine');
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** XMind 导入（M4 Task 4，FR-IO-001/002）：file → xmind-import 胶水（错误已按
   *  FR-IO-001 归因为 Error.message）→ POST /api/files 携带 docState 建文件 →
   *  与新建脑图同款回刷（退出过滤/搜索/其他视图，「导入即见」）。降级提示 toast
   *  （degraded.length > 0，FR-IO-002）；失败 toast 显示归因文案（不进全局 error 条，
   *  导入失败不阻断工作台其余操作）。 */
  async function importXmind(file: File): Promise<void> {
    try {
      const { title, state, degraded } = await importXmindFile(file);
      await apiPost('/files', { title, docState: state });
      setView('mine');
      setFolderId(null);
      setSearch(null);
      setSearchText('');
      await loadFiles('mine');
      if (degraded.length > 0) showToast(degradedSummary(degraded));
    } catch (e) {
      showToast(msgOf(e));
    }
  }

  function showToast(message: string): void {
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
    setToast(message);
  }

  /** 复制分享链接（M3b Task 4，FR-SHR-001）：POST /api/files/:id/share（owner only，
   *  重复创建返回既有 active token）→ 剪贴板写 `${origin}/s/${token}` → toast。
   *  剪贴板失败（非安全上下文/权限拒绝）以错误提示兜底，不静默。 */
  async function copyShareLink(fileId: string): Promise<void> {
    setMenuFor(null);
    try {
      const { shareToken } = await apiPost<{ shareToken: string }>(`/files/${fileId}/share`);
      await navigator.clipboard.writeText(`${location.origin}/s/${shareToken}`);
      showToast('链接已复制');
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** mine 视图条目的客户端文件夹过滤：选中文件夹及其全部后代（folders 深度升序，
   *  单趟扫不净时迭代收敛——防御性，规模个人级可忽略）。 */
  const visibleItems = useMemo(() => {
    if (view !== 'mine' || folderId === null) return items;
    const under = new Set<string>([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId !== null && under.has(f.parentId) && !under.has(f.id)) {
          under.add(f.id);
          grew = true;
        }
      }
    }
    return items.filter((f) => f.folderId !== null && under.has(f.folderId));
  }, [items, folders, folderId, view]);

  function openPrompt(p: PromptState): void {
    setPrompt(p);
    setPromptValue(p.kind === 'folder-create' ? '' : p.kind === 'folder-rename' ? p.name : p.title);
    setPromptError('');
    setMenuFor(null);
  }

  async function confirmPrompt(): Promise<void> {
    if (!prompt) return;
    const value = promptValue.trim();
    try {
      if (prompt.kind === 'file-rename') {
        if (!value) return setPromptError('名称不能为空');
        await apiPatch(`/files/${prompt.fileId}`, { title: value });
      } else if (prompt.kind === 'folder-create') {
        if (!value) return setPromptError('文件夹名称不能为空');
        await apiPost('/folders', { name: value, parentId: prompt.parentId ?? undefined });
        await loadFolders();
      } else {
        if (!value) return setPromptError('文件夹名称不能为空');
        await apiPatch(`/folders/${prompt.folderId}`, { name: value });
        await Promise.all([loadFolders(), loadFiles(view)]);
      }
      setPrompt(null);
      await refresh();
    } catch (e) {
      setPromptError(msgOf(e));
    }
  }

  async function confirmMove(): Promise<void> {
    if (!moveTarget) return;
    try {
      await apiPatch(`/files/${moveTarget.id}`, { folderId: moveTo === '' ? null : moveTo });
      setMoveTarget(null);
      await refresh();
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 文件夹删除（context op）：window.confirm 二次确认；整棵子树文件入回收站。 */
  async function deleteFolder(f: FolderItem): Promise<void> {
    if (!window.confirm(`删除文件夹「${f.name}」？其中全部文件将进入回收站。`)) return;
    try {
      await apiDel(`/folders/${f.id}`);
      if (folderId !== null && subtreeContains(f.id, folderId)) setFolderId(null);
      await Promise.all([loadFolders(), loadFiles(view)]);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 子树判定（folders 深度升序，迭代收敛；与 visibleItems 同一套客户端组树口径）。 */
  function subtreeContains(ancestorId: string, targetId: string): boolean {
    const byParent = new Map<string | null, string[]>();
    for (const f of folders) {
      const list = byParent.get(f.parentId) ?? [];
      list.push(f.id);
      byParent.set(f.parentId, list);
    }
    const frontier = [ancestorId];
    while (frontier.length > 0) {
      const cur = frontier.pop() as string;
      if (cur === targetId) return true;
      frontier.push(...(byParent.get(cur) ?? []));
    }
    return false;
  }

  const stop = (e: MouseEvent) => e.stopPropagation();

  /** 渲染用条目：搜索态用搜索结果，列表态用视图条目（mine 再按文件夹过滤）。 */
  const shownItems = search ? search.results : visibleItems;

  return (
    <div className="workspace">
      <header className="workspace-header">
        <h2>Gmind 工作台</h2>
        <input
          className="search-input"
          data-testid="search-input"
          ref={searchInputRef}
          placeholder="搜索文件标题，回车确认"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
        />
        <div className="header-actions">
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
                {notifs.length === 0 && <div className="notify-empty">暂无通知</div>}
                {notifs.map((n) => (
                  <div
                    key={n.id}
                    className={'notify-item' + (n.readAt === null ? ' unread' : '')}
                    data-testid="notify-item"
                    onClick={() => void openNotification(n)}
                  >
                    <span className="notify-item-head">
                      <span className="notify-type">{n.type === 'mention' ? '提及' : n.type === 'reply' ? '回复' : '通知'}</span>
                      <span className="notify-text">
                        {n.type === 'mention'
                          ? `${n.payload?.commenterName ?? '有人'} 在「${n.payload?.title ?? '文件'}」中提到了你`
                          : n.type === 'reply'
                            ? `${n.payload?.commenterName ?? '有人'} 在「${n.payload?.title ?? '文件'}」中回复了你`
                            : n.payload?.title ?? ''}
                      </span>
                    </span>
                    {n.payload?.content && <span className="notify-content">{n.payload.content}</span>}
                    <span className="notify-time">{fmtTime(n.createdAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => navigate('/trash')}>回收站</button>
          <button data-testid="import-button" onClick={() => importInputRef.current?.click()}>
            导入
          </button>
          {/* accept 仅为系统选择器提示；e2e setInputFiles 直接注入 bytes 不受其约束 */}
          <input
            ref={importInputRef}
            type="file"
            accept=".xmind"
            data-testid="import-input"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ''; // 复位以允许连续导入同名文件
              if (file) void importXmind(file);
            }}
          />
          <button className="primary" onClick={() => void createFile()}>
            新建脑图
          </button>
          <span className="user-nickname" data-testid="user-nickname">
            {me?.nickname ?? ''}
          </span>
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="workspace-body">
        {!search && (
          <aside className="folder-rail">
            <div className="rail-head">
              <span>文件夹</span>
              <button data-testid="new-folder-btn" onClick={() => openPrompt({ kind: 'folder-create', parentId: folderId })}>
                新建文件夹
              </button>
            </div>
            <div className="folder-tree" data-testid="folder-tree">
              <div className={'folder-row root' + (folderId === null ? ' active' : '')} onClick={() => openFolder(null)}>
                <span className="folder-name">全部文件</span>
              </div>
              {folders.map((f) => (
                <div
                  key={f.id}
                  className={'folder-row' + (folderId === f.id ? ' active' : '')}
                  style={{ paddingLeft: 8 + (f.depth - 1) * 16 }}
                  onClick={() => openFolder(f.id)}
                >
                  <span className="folder-name">{f.name}</span>
                  <span className="folder-ops" onClick={stop}>
                    <button data-testid="folder-rename-btn" title="重命名文件夹" onClick={() => openPrompt({ kind: 'folder-rename', folderId: f.id, name: f.name })}>
                      重命名
                    </button>
                    <button data-testid="folder-delete-btn" title="删除文件夹" onClick={() => void deleteFolder(f)}>
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </aside>
        )}

        <section className="main-pane">
          {search ? (
            <div className="search-bar" data-testid="search-results">
              <h3>「{search.q}」的搜索结果（{search.results.length}）</h3>
              <button data-testid="search-clear" onClick={() => void clearSearch()}>
                清除搜索
              </button>
            </div>
          ) : (
            <div className="view-tabs" data-testid="view-tabs">
              {VIEW_TABS.map((t) => (
                <button key={t.key} className={view === t.key ? 'active' : ''} onClick={() => void switchView(t.key)}>
                  {t.label}
                </button>
              ))}
            </div>
          )}

          <div className="file-list-header">
            <span>文件名</span>
            <span>所有者</span>
            <span>修改时间</span>
            <span>修改人</span>
            <span>位置</span>
            <span>操作</span>
          </div>
          <ul className="file-list">
            {shownItems.map((f) => (
              <li key={f.id} className="file-row" onClick={() => navigate(`/edit/${f.id}`)}>
                <span className="cell title">{search ? highlightTitle(f.title, search.q) : f.title}</span>
                <span className="cell">{f.ownerName ?? '—'}</span>
                <span className="cell">{fmtTime(f.updatedAt)}</span>
                <span className="cell">{f.lastModifierName ?? '—'}</span>
                <span className="cell">{f.folderName ?? '根目录'}</span>
                <span className="cell ops" onClick={stop}>
                  <button
                    className="star-btn"
                    data-testid="star-btn"
                    title={f.starred ? '取消星标' : '加星标'}
                    onClick={withReload(() => (f.starred ? apiDel(`/files/${f.id}/star`) : apiPut(`/files/${f.id}/star`)))}
                  >
                    {f.starred ? '★' : '☆'}
                  </button>
                  <button data-testid="row-menu" title="更多操作" onClick={() => setMenuFor(menuFor === f.id ? null : f.id)}>
                    ⋯
                  </button>
                  {menuFor === f.id && (
                    <div className="row-menu" data-testid="row-menu-popup">
                      <button onClick={() => openPrompt({ kind: 'file-rename', fileId: f.id, title: f.title })}>重命名</button>
                      {/* 删除/移动仅 owner（M3b 清偿包，PRD 2.2.1）：按归属判定、视图无关
                          ——shared 视图（及 recent/starred 中他人文件）不出现这两项，
                          避免点了必 404 的入口；重命名/复制/星标对所有可访问文件保留。 */}
                      {f.ownerUserId === me?.id && (
                        <button
                          onClick={() => {
                            setMoveTarget(f);
                            setMoveTo(f.folderId ?? '');
                            setMenuFor(null);
                          }}
                        >
                          移动到文件夹
                        </button>
                      )}
                      {/* 复制分享链接（M3b Task 4，FR-SHR-001）：owner only（FR-SHR-001
                          「文档所有者可创建」，与删除/移动同一归属判定） */}
                      {f.ownerUserId === me?.id && (
                        <button data-testid="share-action" onClick={() => void copyShareLink(f.id)}>
                          复制分享链接
                        </button>
                      )}
                      <button onClick={withReload(() => apiPost(`/files/${f.id}/copy`))}>复制</button>
                      {f.ownerUserId === me?.id && (
                        <button className="danger" onClick={withReload(() => apiDel(`/files/${f.id}`))}>
                          删除
                        </button>
                      )}
                    </div>
                  )}
                </span>
              </li>
            ))}
            {shownItems.length === 0 && (
              <li className="empty">{search ? '没有匹配的文件' : '暂无文件，点击「新建脑图」开始'}</li>
            )}
          </ul>
        </section>
      </div>

      {toast && (
        <div className="workspace-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}

      {prompt && (
        <div className="modal-mask" data-testid="rename-modal">
          <div className="modal">
            <h3>
              {prompt.kind === 'file-rename'
                ? '重命名文件'
                : prompt.kind === 'folder-create'
                  ? '新建文件夹'
                  : '重命名文件夹'}
            </h3>
            <input
              autoFocus
              data-testid="rename-input"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmPrompt();
              }}
            />
            {promptError && <p className="error">{promptError}</p>}
            <div className="modal-actions">
              <button onClick={() => setPrompt(null)}>取消</button>
              <button className="primary" data-testid="rename-confirm" onClick={() => void confirmPrompt()}>
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {moveTarget && (
        <div className="modal-mask" data-testid="move-modal">
          <div className="modal">
            <h3>移动「{moveTarget.title}」到</h3>
            <select data-testid="move-select" value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
              <option value="">根目录</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {'　'.repeat(f.depth - 1)}
                  {f.name}
                </option>
              ))}
            </select>
            <div className="modal-actions">
              <button onClick={() => setMoveTarget(null)}>取消</button>
              <button className="primary" data-testid="move-confirm" onClick={() => void confirmMove()}>
                移动
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
