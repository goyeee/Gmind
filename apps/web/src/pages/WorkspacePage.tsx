import { useCallback, useEffect, useRef, useState, Fragment, type MouseEvent, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { FileListItemDetailed } from '@gmind/shared';
import { createTemplateDoc, docToState } from '@gmind/core';
import { api, apiDel, apiPatch, apiPost, apiPut } from '../api/client';
import { GUIDE_DONE_KEY, GuideOverlay, type GuideStep } from './GuideOverlay';
import { degradedSummary, importXmindFile } from '../editor/xmind-import';
import { TEMPLATE_CATALOG, type WorkspaceTemplate } from '../editor/templates';
import { useRealThumb } from '../editor/thumbnail';
import { WorkspaceShell } from './WorkspaceShell';
import './workspace.css';

/**
 * 工作台（2026-10-20 整体重设计，spec 2026-10-20-workspace-redesign-design）：
 * 外壳（左侧栏导航 + 顶栏通知铃/头像 + 用户卡菜单）由 WorkspaceShell 共享组件
 * 承载（2026-10-21 抽取——回收站/账号设置/账号管理同壳）；本页只保留顶栏左槽
 * （搜索/导入/新建脑图）与内容区（问候语 → 快速创建卡 → 文件卡片流）。
 * 视图以 URL search param 为唯一事实源（?view=recent/starred/collab/templates），
 * 外壳侧栏跨页导航与本页内切换同一条通道。文件夹概念已下线（server folders
 * 休眠不删）。文件卡片 = 装饰性缩略图（fileId 哈希取色，不渲染真实文档内容）+
 * 标题（行内重命名）+ 相对时间·所属 + 星标 + hover ⋯ 菜单。
 */

/** 视图（FR-FIL-001 口径扩展）：侧栏一级导航。 */
type View = 'mine' | 'recent' | 'starred' | 'collab' | 'templates';

const VIEW_PARAMS: ReadonlySet<string> = new Set(['recent', 'starred', 'collab', 'templates']);

/** 最近使用的归属筛选（协作文件带协作图标 + 筛选，2026-10-20 裁定 3）。 */
type RecentFilter = 'all' | 'mine' | 'collab';

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

/** 相对时间（卡片用）：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期。 */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 时段问候语（首页用）。 */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '上午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** 装饰性缩略图取色板（企微色系；fileId 哈希取模，同文件恒定同色）。 */
const THUMB_COLORS = ['#3370ff', '#0d9488', '#7c3aed', '#ea580c', '#db2777', '#0891b1'];

function thumbColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return THUMB_COLORS[h % THUMB_COLORS.length]!;
}

/** 装饰性脑图缩略图（参考图同款：色块 root + 三分支，不渲染真实文档内容）。 */
function Thumb({ seed, accent }: { seed: string; accent?: string }): ReactElement {
  const color = accent ?? thumbColor(seed);
  return (
    <svg className="file-thumb-svg" viewBox="0 0 120 64" aria-hidden>
      <rect x="8" y="26" width="34" height="14" rx="7" fill={color} />
      <line x1="42" y1="33" x2="72" y2="12" stroke="#c5cdd8" strokeWidth="1.5" />
      <line x1="42" y1="33" x2="72" y2="33" stroke="#c5cdd8" strokeWidth="1.5" />
      <line x1="42" y1="33" x2="72" y2="54" stroke="#c5cdd8" strokeWidth="1.5" />
      <rect x="72" y="6" width="40" height="12" rx="6" fill="#fff" stroke="#e5e6eb" />
      <rect x="72" y="27" width="40" height="12" rx="6" fill="#fff" stroke="#e5e6eb" />
      <rect x="72" y="48" width="40" height="12" rx="6" fill="#fff" stroke="#e5e6eb" />
    </svg>
  );
}

/** 引导三步（M5 Task 3 保留，目标 testid 随重设计更新）：新建 → 打开文档编辑 → 协作。 */
const GUIDE_STEPS: GuideStep[] = [
  { selector: '[data-testid="new-file-btn"]', title: '创建你的第一份脑图', sub: '点击新建，空白文档即刻开始' },
  { selector: '.file-card', title: '添加节点组织思路', sub: '打开任意文档，Tab 建子级、Enter 建同级' },
  { selector: '.file-card', title: '邀请伙伴协作', sub: '打开文档，成员面板一键拉取站内用户' },
];

/** FileCard 回调集（模块级组件的 props 收口——组件必须定义在模块顶层：函数体内
 *  定义 = 每次渲染全新组件类型，整棵卸载重挂，输入框无法驻留/打字丢焦）。 */
interface FileCardProps {
  f: FileListItemDetailed;
  meId: string | undefined;
  renaming: boolean;
  renameDraft: string;
  menuOpen: boolean;
  onOpen(): void;
  onMenuToggle(): void;
  onRenameStart(): void;
  onRenameDraft(v: string): void;
  onRenameCommit(): void;
  onRenameCancel(): void;
  onStar(): void;
  onCopy(): void;
  onShare(): void;
  onDelete(): void;
}

/** 文件卡片（重设计主形态）：装饰性缩略图 + 标题（行内重命名）+ 相对时间·所属 +
 *  星标 + hover ⋯ 菜单（重命名/复制/复制分享链接/删除——后两项 owner-only）。 */
function FileCard(p: FileCardProps): ReactElement {
  const { f, meId } = p;
  const collab = meId !== undefined && f.ownerUserId !== meId;
  const stop = (e: MouseEvent) => e.stopPropagation();
  // 真实内容缩略图（2026-10-21）：有快照出真图，无快照回退装饰性示意图
  const realThumb = useRealThumb(f.id);
  return (
    <div className="file-card" data-testid="file-card" onClick={() => !p.renaming && p.onOpen()}>
      <div className="file-thumb">
        <span className="card-kind" aria-hidden>
          脑图
        </span>
        {realThumb ? <img className="file-thumb-img" data-testid="file-thumb-img" src={realThumb} alt="" /> : <Thumb seed={f.id} />}
        <button
          className={'card-star' + (f.starred ? ' starred' : '')}
          data-testid="star-btn"
          title={f.starred ? '取消星标' : '加星标'}
          onClick={(e) => {
            stop(e);
            p.onStar();
          }}
        >
          {f.starred ? '★' : '☆'}
        </button>
      </div>
      <div className="file-card-body">
        {p.renaming ? (
          <input
            className="card-rename-input"
            data-testid="rename-input"
            autoFocus
            value={p.renameDraft}
            onClick={stop}
            onChange={(e) => p.onRenameDraft(e.target.value)}
            onBlur={p.onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') p.onRenameCommit();
              if (e.key === 'Escape') p.onRenameCancel();
            }}
          />
        ) : (
          <div className="card-title" title={f.title}>
            {collab && (
              <span className="card-collab-icon" title="协作文件" aria-label="协作文件">
                🤝
              </span>
            )}
            {f.title}
          </div>
        )}
        <div className="card-meta">
          {f.nodeCount} 节点 · {relTime(f.updatedAt)}
        </div>
      </div>
      <div className="card-ops" onClick={stop}>
        <button
          className="card-menu-btn"
          data-testid="card-menu-btn"
          title="更多操作"
          aria-label="更多操作"
          onClick={p.onMenuToggle}
        >
          ⋯
        </button>
        {p.menuOpen && (
          <div className="card-menu" data-testid="card-menu">
            <button onClick={p.onRenameStart}>重命名</button>
            <button onClick={p.onCopy}>复制</button>
            {f.ownerUserId === meId && (
              <button data-testid="share-action" onClick={p.onShare}>
                复制分享链接
              </button>
            )}
            {f.ownerUserId === meId && (
              <button className="danger" onClick={p.onDelete}>
                删除
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 卡片网格（空态文案随视图；testid 供 e2e 区分首页双网格——最近/我的同文件
 *  双卡并存，操作类断言须按网格定界）。 */
function CardGrid({
  list,
  empty,
  testid,
  renderCard,
}: {
  list: FileListItemDetailed[];
  empty: string;
  testid?: string;
  renderCard: (f: FileListItemDetailed, scope: string) => ReactElement;
}): ReactElement {
  return (
    <div className="file-grid" data-testid={testid ?? 'file-grid'}>
      {list.map((f) => (
        <Fragment key={f.id}>{renderCard(f, testid ?? 'file-grid')}</Fragment>
      ))}
      {list.length === 0 && <p className="grid-empty">{empty}</p>}
    </div>
  );
}

export function WorkspacePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [me, setMe] = useState<{ id: string; nickname: string; systemRole?: 'super_admin' | 'member'; avatar?: string | null } | null>(null);
  const [items, setItems] = useState<FileListItemDetailed[]>([]);
  const [recentItems, setRecentItems] = useState<FileListItemDetailed[]>([]);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('all');
  // 模板中心分类（2026-10-24 原型换装）：'all' | category
  const [tplCat, setTplCat] = useState<string>('all');
  const [search, setSearch] = useState<{ q: string; results: FileListItemDetailed[] } | null>(null);
  const [searchText, setSearchText] = useState('');
  const [error, setError] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [previewTpl, setPreviewTpl] = useState<WorkspaceTemplate | null>(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);

  /** 视图以 URL 为唯一事实源（2026-10-21 外壳抽取：侧栏跨页导航 → /workspace?view=x）。 */
  const rawView = searchParams.get('view') ?? 'mine';
  const view: View = VIEW_PARAMS.has(rawView) ? (rawView as View) : 'mine';

  // Ctrl/Cmd+Shift+F 聚焦搜索框（M3b 清偿包，FR-FIL-008）
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

  /** 视图 → 服务端 view 参数（协作空间 = shared，2026-10-20 裁定 3）。 */
  const viewParam = (v: View): string =>
    v === 'collab' ? 'shared' : v === 'templates' ? 'mine' : v;

  /** 列表装载序号（2026-10-21 修竞态）：URL 驱动视图后并发 loadFiles（视图 effect ×
   *  动作后 refresh）可能乱序回包——慢的旧响应会把新视图的列表盖掉（星标取消后 starred
   *  视图仍见该卡的 e2e 红案）。只认最后一次发起的响应。 */
  const loadSeq = useRef(0);
  const loadFiles = useCallback(async (v: View) => {
    const seq = ++loadSeq.current;
    const data = await api<FileListItemDetailed[]>(`/files?view=${viewParam(v)}`);
    if (seq === loadSeq.current) setItems(data);
  }, []);
  const loadRecent = useCallback(async () => {
    setRecentItems(await api<FileListItemDetailed[]>('/files?view=recent'));
  }, []);

  // 挂载：身份 + 首页「最近文件」流（失败静默，非关键路径）
  useEffect(() => {
    void api<{ id: string; nickname: string; systemRole?: 'super_admin' | 'member'; avatar?: string | null }>('/users/me')
      .then(setMe)
      .catch(() => undefined);
    void loadRecent().catch(() => undefined);
  }, [loadRecent]);

  // 视图切换（含外壳侧栏跨页带参进入）→ 装载对应列表；模板库纯客户端目录无请求
  useEffect(() => {
    if (view === 'templates') return;
    void loadFiles(view).catch((e) => setError(msgOf(e)));
  }, [view, loadFiles]);

  // 引导触发（M5 Task 3）：完成/跳过前首进即开
  useEffect(() => {
    if (!guideOpen && localStorage.getItem(GUIDE_DONE_KEY) === null && items.length > 0) {
      setGuideOpen(true);
    }
  }, [items, guideOpen]);

  async function refresh(): Promise<void> {
    if (search) {
      const results = await api<FileListItemDetailed[]>(`/search?q=${encodeURIComponent(search.q)}`);
      setSearch({ q: search.q, results });
      return;
    }
    await loadFiles(view);
    if (view === 'mine') await loadRecent();
  }

  function withReload(fn: () => Promise<unknown>): () => void {
    return () => {
      setMenuFor(null);
      void fn()
        .then(() => refresh())
        .catch((e) => setError(msgOf(e)));
    };
  }

  /** 视图切换 = 写 URL（外壳侧栏同一通道）；本地瞬态（搜索/菜单/重命名）一律收敛。 */
  function switchView(v: View): void {
    setSearch(null);
    setSearchText('');
    setMenuFor(null);
    setRenamingId(null);
    setSearchParams(v === 'mine' ? {} : { view: v });
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
      const created = await apiPost<{ id: string }>('/files', {});
      navigate(`/edit/${created.id}`); // 2026-10-20 重设计：新建即开（参考图「空白脑图」卡语义）
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 使用模板（2026-10-20 裁定 5）：客户端 createTemplateDoc 直出 docState →
   *  POST /files（导入落库路径）→ 建完即开。 */
  async function createFromTemplate(tpl: WorkspaceTemplate): Promise<void> {
    try {
      const doc = createTemplateDoc(tpl.spec);
      const state = btoa(String.fromCharCode(...docToState(doc)));
      doc.destroy();
      const created = await apiPost<{ id: string }>('/files', { title: tpl.spec.title, docState: state });
      setPreviewTpl(null);
      navigate(`/edit/${created.id}`);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** XMind 导入（M4 Task 4 保留）：入口收进顶栏「导入」文字钮。 */
  async function importXmind(file: File): Promise<void> {
    try {
      const { title, state, degraded } = await importXmindFile(file);
      await apiPost('/files', { title, docState: state });
      switchView('mine');
      await loadFiles('mine'); // 已在 mine 时 URL 不变、视图 effect 不触发——手动补装
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

  /** 行内重命名提交（2026-10-20：对话框退役）：Enter 提交 / Esc 取消，空值不提交。 */
  async function commitRename(f: FileListItemDetailed): Promise<void> {
    const value = renameDraft.trim();
    setRenamingId(null);
    if (!value || value === f.title) return;
    try {
      await apiPatch(`/files/${f.id}`, { title: value });
      await refresh();
    } catch (e) {
      setError(msgOf(e));
    }
  }

  const stop = (e: MouseEvent) => e.stopPropagation();
  const isCollab = (f: FileListItemDetailed): boolean => me !== null && f.ownerUserId !== me.id;

  /** 最近使用筛选（全部/个人/协作，客户端过滤）。 */
  const recentShown = recentItems.filter((f) =>
    recentFilter === 'all' ? true : recentFilter === 'collab' ? isCollab(f) : !isCollab(f),
  );

  const shownItems = search ? search.results : items;

  /** 卡片渲染闭包（模块级 FileCard/CardGrid 的回调装配）。renamingId/menuFor 带网格
   *  作用域前缀（`${scope}:${fileId}`）——首页最近/我的双网格同文件双卡并存，不区分
   *  会双 autoFocus 输入框抢焦点互 blur 同归于尽（2026-10-20 实测实证）。 */
  const renderCard = (f: FileListItemDetailed, scope: string): ReactElement => (
    <FileCard
      f={f}
      meId={me?.id}
      renaming={renamingId === `${scope}:${f.id}`}
      renameDraft={renameDraft}
      menuOpen={menuFor === `${scope}:${f.id}`}
      onOpen={() => navigate(`/edit/${f.id}`)}
      onMenuToggle={() => setMenuFor(menuFor === `${scope}:${f.id}` ? null : `${scope}:${f.id}`)}
      onRenameStart={() => {
        setRenamingId(`${scope}:${f.id}`);
        setRenameDraft(f.title);
        setMenuFor(null);
      }}
      onRenameDraft={setRenameDraft}
      onRenameCommit={() => void commitRename(f)}
      onRenameCancel={() => setRenamingId(null)}
      onStar={withReload(() => (f.starred ? apiDel(`/files/${f.id}/star`) : apiPut(`/files/${f.id}/star`)))}
      onCopy={withReload(() => apiPost(`/files/${f.id}/copy`))}
      onShare={() => void copyShareLink(f.id)}
      onDelete={withReload(() => apiDel(`/files/${f.id}`))}
    />
  );

  return (
    <WorkspaceShell
      activeNav={search ? null : view}
      topbar={
        <>
          <input
            className="search-input"
            data-testid="search-input"
            ref={searchInputRef}
            placeholder="搜索脑图，回车确认"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch();
            }}
          />
          <button className="ws-import" data-testid="import-button" onClick={() => importInputRef.current?.click()}>
            导入
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".xmind"
            data-testid="import-input"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (file) void importXmind(file);
            }}
          />
          <button className="ws-create" data-testid="new-file-btn" onClick={() => void createFile()}>
            ＋ 新建脑图
          </button>
        </>
      }
    >
      {error && <p className="error">{error}</p>}

      <main className="ws-content">
        {search ? (
          <>
            <div className="search-bar" data-testid="search-results">
              <h3>
                「{search.q}」的搜索结果（{search.results.length}）
              </h3>
              <button data-testid="search-clear" onClick={() => void clearSearch()}>
                清除搜索
              </button>
            </div>
            <CardGrid list={shownItems} empty="没有匹配的文件" renderCard={renderCard} />
          </>
        ) : view === 'mine' ? (
          <>
            <section className="ws-hello">
              <h1 data-testid="ws-greeting">
                {greeting()}，{me?.nickname ?? ''}
              </h1>
              <p>今天也来整理一下思绪吧</p>
            </section>
            <section className="ws-quick">
              <button className="quick-card quick-primary" data-testid="quick-create-blank" onClick={() => void createFile()}>
                <span className="quick-icon" style={{ background: 'rgba(255,255,255,0.18)' }} aria-hidden>
                  🧠
                </span>
                <span className="quick-text">
                  <strong>新建脑图</strong>
                  <em>从空白画布开始</em>
                </span>
              </button>
              <button className="quick-card" data-testid="quick-create-template" onClick={() => switchView('templates')}>
                <span className="quick-icon" style={{ background: '#e8f6ee' }} aria-hidden>
                  📚
                </span>
                <span className="quick-text">
                  <strong>模板中心</strong>
                  <em>精选模板，快速开始</em>
                </span>
              </button>
              <button className="quick-card quick-dashed" data-testid="quick-create-import" onClick={() => importInputRef.current?.click()}>
                <span className="quick-icon" style={{ background: '#f2f3f5' }} aria-hidden>
                  📥
                </span>
                <span className="quick-text">
                  <strong>导入文件</strong>
                  <em>支持 XMind</em>
                </span>
              </button>
            </section>
            <section>
              <div className="ws-section-head">
                <h2>最近文件</h2>
                <button className="link" data-testid="recent-view-all" onClick={() => switchView('recent')}>
                  查看全部 →
                </button>
              </div>
              <CardGrid list={recentItems.slice(0, 4)} empty="暂无最近文件" testid="home-recent-grid" renderCard={renderCard} />
            </section>
            <section>
              <div className="ws-section-head">
                <h2>推荐模板</h2>
                <button className="link" data-testid="home-more-templates" onClick={() => switchView('templates')}>
                  更多模板 →
                </button>
              </div>
              <div className="tpl-mini-row">
                {TEMPLATE_CATALOG.slice(0, 3).map((t) => (
                  <button key={t.id} className="tpl-mini" data-testid={`tpl-mini-${t.id}`} onClick={() => switchView('templates')}>
                    <span className="tpl-mini-thumb" aria-hidden>
                      <Thumb seed={t.id} accent={t.accent} />
                    </span>
                    <span className="tpl-mini-name">{t.name}</span>
                    <span className="tpl-mini-blurb">{t.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
            <section>
              <div className="ws-section-head">
                <h2>我的文件</h2>
              </div>
              <CardGrid list={items} empty='暂无文件，点击「新建脑图」开始' testid="mine-grid" renderCard={renderCard} />
            </section>
          </>
        ) : view === 'recent' ? (
          <>
            <div className="ws-section-head">
              <h2>最近使用</h2>
              <div className="recent-filter" data-testid="recent-filter">
                {(
                  [
                    ['all', '全部'],
                    ['mine', '个人'],
                    ['collab', '协作'],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    className={recentFilter === k ? 'active' : ''}
                    data-testid={`recent-filter-${k}`}
                    onClick={() => setRecentFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <CardGrid list={recentShown} empty="暂无最近文件" renderCard={renderCard} />
          </>
        ) : view === 'starred' ? (
          <>
            <div className="ws-section-head">
              <h2>星标收藏</h2>
            </div>
            <CardGrid list={items} empty="暂无星标文件" renderCard={renderCard} />
          </>
        ) : view === 'collab' ? (
          <>
            <div className="ws-section-head">
              <h2>协作空间</h2>
              <span className="ws-section-sub">和团队在同一张画布上思考</span>
            </div>
            <CardGrid list={items} empty="暂无协作文件——打开文档，成员面板一键拉取站内用户" renderCard={renderCard} />
          </>
        ) : (
          <>
            {(() => {
              const hero = TEMPLATE_CATALOG[0];
              return hero ? (
                <section className="tpl-hero" data-testid="template-hero">
                  <div className="tpl-hero-text">
                    <span className="tpl-hero-badge">本周精选</span>
                    <h2>{hero.name}</h2>
                    <p>{hero.blurb}</p>
                    <div className="tpl-hero-actions">
                      <button className="tpl-hero-use" data-testid="template-hero-use" onClick={() => void createFromTemplate(hero)}>
                        使用此模板 →
                      </button>
                      <button className="tpl-hero-preview" onClick={() => setPreviewTpl(hero)}>
                        预览
                      </button>
                    </div>
                  </div>
                  <div className="tpl-hero-thumb" aria-hidden>
                    <Thumb seed={hero.id} accent={hero.accent} />
                  </div>
                </section>
              ) : null;
            })()}
            <div className="tpl-cats" data-testid="template-cats">
              {(['all', ...Array.from(new Set(TEMPLATE_CATALOG.map((t) => t.category ?? ''))).filter(Boolean)] as string[]).map((c) => (
                <button key={c} className={tplCat === c ? 'active' : ''} data-testid={`template-cat-${c}`} onClick={() => setTplCat(c)}>
                  {c === 'all' ? '全部' : c}
                </button>
              ))}
            </div>
            <div className="ws-section-head">
              <h2>模板库</h2>
              <span className="ws-section-sub">内置精选模板，一键套用</span>
            </div>
            <div className="file-grid" data-testid="template-grid">
              {TEMPLATE_CATALOG.filter((t) => tplCat === 'all' || t.category === tplCat).map((t) => (
                <button
                  key={t.id}
                  className="file-card template-card"
                  data-testid={`template-card-${t.id}`}
                  onClick={() => setPreviewTpl(t)}
                >
                  <div className="file-thumb">
                    <Thumb seed={t.id} accent={t.accent} />
                  </div>
                  <div className="file-card-body">
                    <div className="card-title">{t.name}</div>
                    <div className="card-meta">
                      {t.category && <span className="tpl-cat-tag">{t.category}</span>}
                      {t.blurb}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </main>

      {/* 模板预览（大缩略图 + 简介 + 使用模板） */}
      {previewTpl && (
        <div className="modal-mask" data-testid="template-preview" onClick={() => setPreviewTpl(null)}>
          <div className="modal template-modal" onClick={stop}>
            <div className="template-preview-thumb">
              <Thumb seed={previewTpl.id} accent={previewTpl.accent} />
            </div>
            <h3>{previewTpl.name}</h3>
            <p className="template-blurb">{previewTpl.blurb}</p>
            <div className="modal-actions">
              <button onClick={() => setPreviewTpl(null)}>取消</button>
              <button className="primary" data-testid="template-use" onClick={() => void createFromTemplate(previewTpl)}>
                使用模板
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="workspace-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}

      {guideOpen && <GuideOverlay steps={GUIDE_STEPS} onClose={() => setGuideOpen(false)} />}
    </WorkspaceShell>
  );
}
