import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { FileListItemDetailed, FolderItem } from '@gmind/shared';
import { api, apiDel, apiPatch, apiPost, apiPut } from '../api/client';

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

export function WorkspacePage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<{ nickname: string } | null>(null);
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
          placeholder="搜索文件标题，回车确认"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
        />
        <div className="header-actions">
          <button onClick={() => navigate('/trash')}>回收站</button>
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
                <span className="cell title">{f.title}</span>
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
                      <button
                        onClick={() => {
                          setMoveTarget(f);
                          setMoveTo(f.folderId ?? '');
                          setMenuFor(null);
                        }}
                      >
                        移动到文件夹
                      </button>
                      <button onClick={withReload(() => apiPost(`/files/${f.id}/copy`))}>复制</button>
                      <button className="danger" onClick={withReload(() => apiDel(`/files/${f.id}`))}>
                        删除
                      </button>
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
