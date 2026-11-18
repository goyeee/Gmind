import { useCallback, useEffect, useMemo, useRef, useState, Fragment, type MouseEvent, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { FileListItemDetailed } from '@gmind/shared';
import { createTemplateDoc, docToState } from '@gmind/core';
import { api, apiDel, apiPatch, apiPost, apiPut } from '../api/client';
import { GUIDE_DONE_KEY, GuideOverlay, type GuideStep } from './GuideOverlay';
import { degradedSummary, importXmindFile } from '../editor/xmind-import';
import { uploadImage } from '../editor/imageUpload';
import { TEMPLATE_CATALOG, type WorkspaceTemplate } from '../editor/templates';
import { TemplateThumb, specNodeCount } from '../editor/TemplateThumb';
import { useRealThumb } from '../editor/thumbnail';
import { WorkspaceShell, type ShellNav } from './WorkspaceShell';
import { Lucide } from '../components/lucide-data';
import { avatarSrcOf } from '../editor/TaskFields';
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
type View = 'mine' | 'files' | 'recent' | 'starred' | 'collab' | 'templates';

const VIEW_PARAMS: ReadonlySet<string> = new Set(['files', 'recent', 'starred', 'collab', 'templates']);

/** 最近使用的归属筛选（协作文件带协作图标 + 筛选，2026-10-20 裁定 3）。 */
type RecentFilter = 'all' | 'mine' | 'collab';

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败';
}

/* —— 文件列表 SWR 缓存（2026-10-27 需求方：进入先出缓存、拿到数据再更新，消掉
 *    首秒空白）：内存 Map + sessionStorage 双层，键 = `${userId}:${view}`。
 *    进入视图先 setItems(缓存) 秒渲染，后台拉新后覆盖（loadSeq 竞态守卫不变）。 */
const FILE_CACHE_KEY = 'gmind.files.cache.v1';
const fileCacheMem = new Map<string, FileListItemDetailed[]>();

function readFileCache(): Record<string, FileListItemDetailed[]> {
  try {
    return JSON.parse(sessionStorage.getItem(FILE_CACHE_KEY) ?? '{}') as Record<string, FileListItemDetailed[]>;
  } catch {
    return {};
  }
}

function writeFileCacheEntry(key: string, data: FileListItemDetailed[]): void {
  fileCacheMem.set(key, data);
  try {
    const all = readFileCache();
    all[key] = data;
    sessionStorage.setItem(FILE_CACHE_KEY, JSON.stringify(all));
  } catch {
    // 存储满/隐私模式：内存缓存仍生效
  }
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

/** 创建者头像（2026-10-25 原型文件卡）：自定义头像经 avatarSrcOf 转 URL（预置直出/
 *  上传键经 /api/images/ 端点）；无头像=ownerUserId 稳定色相的首字符圆块。 */
function OwnerAvatar({ userId, name, url }: { userId: string; name: string | null; url: string | null }) {
  const label = (name ?? '').trim().charAt(0) || '?';
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setImgFailed(false);
  }, [url]);
  const hue = [...userId].reduce((acc, ch) => acc + (ch.codePointAt(0) ?? 0), 0) % 360;
  const showImg = url && !imgFailed;
  return showImg ? (
    <img
      className="card-owner-avatar"
      src={avatarSrcOf(url, userId)}
      alt=""
      aria-hidden
      title={name ?? undefined}
      data-testid="card-owner-avatar"
      onError={() => setImgFailed(true)}
    />
  ) : (
    <span
      className="card-owner-avatar"
      style={{ background: `hsl(${hue} 62% 58%)` }}
      aria-hidden
      title={name ?? undefined}
      data-testid="card-owner-avatar"
    >
      {label}
    </span>
  );
}

/** 文件卡片（重设计主形态）：装饰性缩略图 + 标题（行内重命名）+ 相对时间·所属 +
 *  星标 + hover ⋯ 菜单（重命名/复制/复制分享链接/删除——后两项 owner-only）。
 *  2026-10-25 原型：meta 行尾追加创建者头像（ownerAvatarUrl，无头像兜底首字符）。 */
function FileCard(p: FileCardProps): ReactElement {
  const { f, meId } = p;
  const collab = meId !== undefined && f.ownerUserId !== meId;
  const stop = (e: MouseEvent) => e.stopPropagation();
  // 真实内容缩略图（2026-10-21）：有快照出真图，无快照回退装饰性示意图
  const realThumb = useRealThumb(f.id);
  return (
    <div className="file-card" data-testid="file-card" onClick={() => !p.renaming && p.onOpen()}>
      <div className="file-thumb">
        <span className={f.kind === 'table' ? 'card-kind kind-table' : 'card-kind'} aria-hidden>
          {f.kind === 'table' ? '表格' : '脑图'}
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
          <span className="card-meta-text">
            {f.nodeCount} 节点 · {relTime(f.updatedAt)}
          </span>
          <OwnerAvatar userId={f.ownerUserId} name={f.ownerName} url={f.ownerAvatarUrl} />
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

/** 文件列表行（2026-10-25 原型 Files 页列表视图）：小缩略图 + 标题（行内重命名/
 *  hover 星标）+ 类型文字 + 创建者（头像+名）+ 最近编辑 + 规模 + ⋯ 菜单（同 FileCard
 *  菜单结构，testid 独立——e2e 既有 card-menu-btn 断言均以 file-card 定界）。 */
function FileRow(p: FileCardProps): ReactElement {
  const { f } = p;
  const stop = (e: MouseEvent) => e.stopPropagation();
  const realThumb = useRealThumb(f.id);
  return (
    <div className="file-row" data-testid="file-row" onClick={() => !p.renaming && p.onOpen()}>
      <span className="file-row-thumb" aria-hidden>
        {realThumb ? <img src={realThumb} alt="" /> : <Thumb seed={f.id} />}
      </span>
      <span className="file-row-title">
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
          <>
            <span className="file-row-name" title={f.title}>
              {f.title}
            </span>
            <button
              className={'card-star row' + (f.starred ? ' starred' : '')}
              data-testid="file-row-star"
              title={f.starred ? '取消星标' : '加星标'}
              onClick={(e) => {
                stop(e);
                p.onStar();
              }}
            >
              {f.starred ? '★' : '☆'}
            </button>
          </>
        )}
      </span>
      <span className="file-row-kind">{f.kind === 'table' ? '表格' : '脑图'}</span>
      <span className="file-row-owner">
        <OwnerAvatar userId={f.ownerUserId} name={f.ownerName} url={f.ownerAvatarUrl} />
        <span className="file-row-owner-name">{f.ownerName ?? '—'}</span>
      </span>
      <span className="file-row-meta">{relTime(f.updatedAt)}</span>
      <span className="file-row-meta">{f.nodeCount} 节点</span>
      <span className="file-row-ops" onClick={stop}>
        <button
          className="card-menu-btn"
          data-testid="file-row-menu-btn"
          title="更多操作"
          aria-label="更多操作"
          onClick={p.onMenuToggle}
        >
          ⋯
        </button>
        {p.menuOpen && (
          <div className="card-menu" data-testid="file-row-menu">
            <button onClick={p.onRenameStart}>重命名</button>
            <button onClick={p.onCopy}>复制</button>
            {f.ownerUserId === p.meId && (
              <button data-testid="share-action" onClick={p.onShare}>
                复制分享链接
              </button>
            )}
            {f.ownerUserId === p.meId && (
              <button className="danger" onClick={p.onDelete}>
                删除
              </button>
            )}
          </div>
        )}
      </span>
    </div>
  );
}

/** 卡片网格（空态文案随视图；testid 供 e2e 区分首页双网格——最近/我的同文件
 *  双卡并存，操作类断言须按网格定界）。 */
/** 我的文件页（批次 D + 2026-10-25 原型布局切换）：页签过滤 + 排序（最近编辑/
 *  名称/节点数）后按布局分流——宫格复用 CardGrid；列表走 FileRow 表格形态。 */
function FileGridSorted({
  items,
  fileTab,
  fileSort,
  layout,
  isCollab,
  renderCard,
  renderRow,
}: {
  items: FileListItemDetailed[];
  fileTab: 'all' | 'starred' | 'map' | 'table' | 'mine' | 'shared';
  fileSort: 'recent' | 'name' | 'nodes';
  layout: 'grid' | 'list';
  isCollab: (f: FileListItemDetailed) => boolean;
  renderCard: (f: FileListItemDetailed, scope: string) => ReactElement;
  renderRow: (f: FileListItemDetailed, scope: string) => ReactElement;
}): ReactElement {
  const filtered = items.filter((f) =>
    fileTab === 'all'
      ? true
      : fileTab === 'starred'
        ? f.starred
        : fileTab === 'map'
          ? f.kind === 'map'
          : fileTab === 'table'
            ? f.kind === 'table'
            : fileTab === 'mine'
              ? !isCollab(f)
              : isCollab(f),
  );
  const sorted = [...filtered].sort((x, y) => {
    if (fileSort === 'name') return x.title.localeCompare(y.title, 'zh');
    if (fileSort === 'nodes') return y.nodeCount - x.nodeCount;
    return y.updatedAt.localeCompare(x.updatedAt);
  });
  if (layout === 'list') {
    const empty =
      fileTab === 'table'
        ? '暂无表格文件，点击「新建表格」创建'
        : fileTab === 'starred'
          ? '点击文件卡右上角的星标，把它放到收藏里'
          : fileTab === 'shared'
            ? '暂无与我共享的文件'
            : '暂无文件，点击「新建脑图」开始';
    return (
      <div className="file-list-view" data-testid="file-list-view">
        <div className="file-list-head" aria-hidden>
          <span>名称</span>
          <span>类型</span>
          <span>创建者</span>
          <span>最近编辑</span>
          <span>规模</span>
          <span />
        </div>
        {sorted.map((f) => (
          <Fragment key={f.id}>{renderRow(f, 'files-list')}</Fragment>
        ))}
        {sorted.length === 0 && <p className="file-list-empty">{empty}</p>}
      </div>
    );
  }
  return (
    <CardGrid
      list={sorted}
      empty={
        fileTab === 'table'
          ? '暂无表格文件，点击「新建表格」创建'
          : fileTab === 'starred'
            ? '点击文件卡右上角的星标，把它放到收藏里'
            : fileTab === 'shared'
              ? '暂无与我共享的文件'
              : '暂无文件，点击「新建脑图」开始'
      }
      testid="mine-grid"
      renderCard={renderCard}
    />
  );
}

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
  /** 本周新建数（原型 Home 副标口径；下限 3）。 */
  const weekCreated = useMemo(() => {
    const monday = new Date();
    const day = monday.getDay() === 0 ? 7 : monday.getDay();
    monday.setDate(monday.getDate() - (day - 1));
    monday.setHours(0, 0, 0, 0);
    const n = items.filter((f) => new Date(f.createdAt).getTime() >= monday.getTime()).length;
    return Math.max(n, 3);
  }, [items]);
  const [recentItems, setRecentItems] = useState<FileListItemDetailed[]>([]);
  const [recentFilter, setRecentFilter] = useState<RecentFilter>('all');
  // 模板中心分类（2026-10-24 原型换装）：'all' | category
  const [tplCat, setTplCat] = useState<string>('all');
  // 我的文件页签/排序（原型 FilesPage）：all/starred/map/table/mine/shared + recent/name/nodes
  // （starred=收藏，2026-10-27 原型：收藏退出侧栏后并入我的文件页签）
  const [fileTab, setFileTab] = useState<'all' | 'starred' | 'map' | 'table' | 'mine' | 'shared'>('all');
  const [fileSort, setFileSort] = useState<'recent' | 'name' | 'nodes'>('recent');
  // 列表/宫格布局（2026-10-25 原型 Files 页双 icon 切换）：默认宫格（既有形态）
  const [fileLayout, setFileLayout] = useState<'grid' | 'list'>('grid');
  const [search, setSearch] = useState<{
    q: string;
    files: FileListItemDetailed[];
    nodes: Array<{ fileId: string; fileTitle: string; nodeId: string; text: string }>;
  } | null>(null);
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

  // 卡片 ⋯ 菜单外点关闭（需求方 2026-11-18：点其他位置应自动消失）：
  // 豁免 .card-ops / .file-row-ops（卡片与列表行的操作区，含 ⋯ 按钮与菜单本体），
  // 按钮自身的 toggle 由 onClick 处理，不被本监听抢先收-开抖动。
  useEffect(() => {
    if (menuFor === null) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      const el = e.target as Element | null;
      if (!el?.closest) return;
      if (el.closest('.card-ops, .file-row-ops')) return;
      setMenuFor(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [menuFor]);

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
    const key = `${me?.id ?? ''}:${v}`;
    const cached = fileCacheMem.get(key) ?? readFileCache()[key];
    if (cached) setItems(cached); // 先出缓存秒渲染，再静默拉新
    if (v === 'files') {
      // 我的文件页（批次 D）：全部=我的+与我共享（合并去重）
      const [mine, shared] = await Promise.all([
        api<FileListItemDetailed[]>('/files?view=mine'),
        api<FileListItemDetailed[]>('/files?view=shared'),
      ]);
      const seen = new Set<string>();
      const merged = [...mine, ...shared].filter((f) => (seen.has(f.id) ? false : seen.add(f.id)));
      if (seq === loadSeq.current) {
        setItems(merged);
        writeFileCacheEntry(key, merged);
      }
      return;
    }
    const data = await api<FileListItemDetailed[]>(`/files?view=${viewParam(v)}`);
    if (seq === loadSeq.current) {
      setItems(data);
      writeFileCacheEntry(key, data);
    }
  }, [me?.id]);
  const loadRecent = useCallback(async () => {
    const key = `${me?.id ?? ''}:recent`;
    const cached = fileCacheMem.get(key) ?? readFileCache()[key];
    if (cached) setRecentItems(cached);
    const data = await api<FileListItemDetailed[]>('/files?view=recent');
    setRecentItems(data);
    writeFileCacheEntry(key, data);
  }, [me?.id]);

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

  // 换头像后刷新文件列表（ownerAvatarUrl 变更需重新拉取）
  useEffect(() => {
    const onAvatarUpdated = (): void => {
      if (view !== 'templates') void loadFiles(view).catch(() => undefined);
    };
    window.addEventListener('gmind:avatar-updated', onAvatarUpdated);
    return () => window.removeEventListener('gmind:avatar-updated', onAvatarUpdated);
  }, [view, loadFiles]);

  // 引导触发（M5 Task 3）：完成/跳过前首进即开。换装后数据分视图装载
  // （首页=recent、我的文件=items），任一有数据即触发。
  useEffect(() => {
    if (!guideOpen && localStorage.getItem(GUIDE_DONE_KEY) === null && (recentItems.length > 0 || items.length > 0)) {
      setGuideOpen(true);
    }
  }, [recentItems, items, guideOpen]);

  async function refresh(): Promise<void> {
    if (search) {
      const res = await api<{
        files: FileListItemDetailed[];
        nodes: Array<{ fileId: string; fileTitle: string; nodeId: string; text: string }>;
      }>(`/search?q=${encodeURIComponent(search.q)}`);
      setSearch({ q: search.q, files: res.files, nodes: res.nodes });
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
      // 全文搜索（2026-10-28 P1）：标题命中 files + 节点内容命中 nodes
      const res = await api<{
        files: FileListItemDetailed[];
        nodes: Array<{ fileId: string; fileTitle: string; nodeId: string; text: string }>;
      }>(`/search?q=${encodeURIComponent(q)}`);
      setSearch({ q, files: res.files, nodes: res.nodes });
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

  async function createFile(kind: 'map' | 'table' = 'map'): Promise<void> {
    try {
      const created = await apiPost<{ id: string }>('/files', kind === 'table' ? { kind } : {});
      navigate(`/edit/${created.id}`); // 2026-10-20 重设计：新建即开（参考图「空白脑图」卡语义）
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** 使用模板（2026-10-20 裁定 5）：客户端 createTemplateDoc 直出 docState →
   *  POST /files（导入落库路径）→ 建完即开。表格类模板（2026-10-25 原型）随建
   *  带 kind='table'——编辑器默认开表格视图（批次 D 同款信号）。 */
  async function createFromTemplate(tpl: WorkspaceTemplate): Promise<void> {
    try {
      const doc = createTemplateDoc(tpl.spec);
      const state = btoa(String.fromCharCode(...docToState(doc)));
      doc.destroy();
      const created = await apiPost<{ id: string }>('/files', {
        title: tpl.spec.title,
        kind: tpl.kind ?? 'map',
        docState: state,
      });
      setPreviewTpl(null);
      navigate(`/edit/${created.id}`);
    } catch (e) {
      setError(msgOf(e));
    }
  }

  /** XMind 导入（M4 Task 4 保留；2026-11-14 v2 两段式）：入口收进顶栏「导入」文字钮。
   *  无图快路径 fileId=null → 照旧 POST /files（时序与旧版一致）；有图两段式由
   *  importXmindFile 内建文件/传图/回写 doc-state，跳过 POST。toast 恒弹
   *  （2026-11-14 裁定 3：全零「已完整导入」，降级逐项点名）。 */
  async function importXmind(file: File): Promise<void> {
    try {
      const { title, fileId, state, degraded } = await importXmindFile(file, {
        createFile: (t, docState) => apiPost<{ id: string }>('/files', { title: t, docState }),
        uploadImage,
        putDocState: async (id, docState) => {
          await apiPut(`/files/${id}/doc-state`, { docState });
        },
      });
      if (fileId === null) await apiPost('/files', { title, docState: state }); // 快路径：现状单段
      switchView('files'); // 导入完成落在「我的文件」视图（批次 D 拆分后文件网格所在）
      await loadFiles('files'); // 已在 files 时 URL 不变、视图 effect 不触发——手动补装
      showToast(degradedSummary(degraded));
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

  const shownItems = search ? search.files : items;

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

  /** 列表行渲染闭包（2026-10-25 原型列表视图）：与 renderCard 同回调集（scope 固定
   *  'files-list'——列表只在「我的文件」页渲染，无双网格并存问题）。 */
  const renderRow = (f: FileListItemDetailed, scope: string): ReactElement => (
    <FileRow
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
      activeNav={search ? null : view === 'mine' ? 'home' : view === 'recent' ? null : view === 'files' ? 'files' : (view as ShellNav)}
      search={{
        value: searchText,
        onChange: setSearchText,
        onSubmit: () => void runSearch(),
        inputRef: searchInputRef,
      }}
      onCreate={(k) => {
        if (k === 'map') void createFile('map');
        else if (k === 'table') void createFile('table');
        else switchView('templates');
      }}
    >
      {error && <p className="error">{error}</p>}
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

      <main className="ws-content">
        {search ? (
          <>
            <div className="search-bar" data-testid="search-results">
              <h3>
                「{search.q}」的搜索结果（文件 {search.files.length} · 节点 {search.nodes.length}）
              </h3>
              <button data-testid="search-clear" onClick={() => void clearSearch()}>
                清除搜索
              </button>
            </div>
            <CardGrid list={shownItems} empty="没有匹配的文件" renderCard={renderCard} />
            {/* 节点内容命中（2026-10-28 P1 全文搜索）：点击直达编辑器并定位节点 */}
            {search.nodes.length > 0 && (
              <section className="search-nodes" data-testid="search-nodes">
                <h4>节点内容命中（{search.nodes.length}）</h4>
                <ul>
                  {search.nodes.map((n) => (
                    <li key={`${n.fileId}:${n.nodeId}`}>
                      <button
                        type="button"
                        className="search-node-link"
                        data-testid="search-node-item"
                        onClick={() => navigate(`/edit/${n.fileId}?node=${encodeURIComponent(n.nodeId)}`)}
                      >
                        <span className="search-node-text">{n.text || '（未命名）'}</span>
                        <span className="search-node-file">{n.fileTitle}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : view === 'mine' ? (
          <>
            <section className="ws-hello">
              <h1 data-testid="ws-greeting">
                {greeting()}，{me?.nickname ?? ''}
              </h1>
              <p>本周已创建 {weekCreated} 张脑图，继续保持清晰的思路</p>
            </section>
            {/* 快速创建四卡（2026-10-27 原型：统一白卡+彩色 icon 底，brand 渐变主卡/
                虚线导入卡形态退役；icon 色脑图橙/表格绿/模板蓝/导入紫——原型同款） */}
            <section className="ws-quick">
              <button className="quick-card" data-testid="quick-create-blank" onClick={() => void createFile()}>
                <span className="quick-icon" style={{ background: '#fff1e0', color: '#d25f00' }} aria-hidden>
                  <Lucide name="Share2" size={24} />
                </span>
                <span className="quick-text">
                  <strong>新建脑图</strong>
                  <em>从空白画布开始</em>
                </span>
              </button>
              <button className="quick-card" data-testid="quick-create-table" onClick={() => void createFile('table')}>
                <span className="quick-icon" style={{ background: '#e6f8ef', color: '#00b42a' }} aria-hidden>
                  <Lucide name="Table2" size={24} />
                </span>
                <span className="quick-text">
                  <strong>新建表格</strong>
                  <em>用表格管理主题与任务</em>
                </span>
              </button>
              <button className="quick-card" data-testid="quick-create-template" onClick={() => switchView('templates')}>
                <span className="quick-icon" style={{ background: 'var(--gm-brand-soft)', color: 'var(--gm-brand)' }} aria-hidden>
                  <Lucide name="LayoutTemplate" size={24} />
                </span>
                <span className="quick-text">
                  <strong>模板中心</strong>
                  <em>精选模板，快速开始</em>
                </span>
              </button>
              <button className="quick-card" data-testid="quick-create-import" onClick={() => importInputRef.current?.click()}>
                <span className="quick-icon" style={{ background: '#f0e9ff', color: '#7c4dff' }} aria-hidden>
                  <Lucide name="FileDown" size={24} />
                </span>
                <span className="quick-text">
                  <strong>导入文件</strong>
                  <em>支持 XMind、Markdown</em>
                </span>
              </button>
            </section>
            <section>
              <div className="ws-section-head">
                <h2>最近文件</h2>
                <button className="link" data-testid="recent-view-all" onClick={() => switchView('files')}>
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
                      <TemplateThumb spec={t.spec} kind={t.kind} accent={t.accent} />
                    </span>
                    <span className="tpl-mini-name">{t.name}</span>
                    <span className="tpl-mini-blurb">{t.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
          </>
        ) : view === 'files' ? (
          <>
            {/* 我的文件（原型 FilesPage）：标题+副标+双新建钮；类型页签+排序。
                2026-10-27 原型：页签加「收藏」（收藏退出侧栏后此为收藏入口）+副标
                含收藏计数。 */}
            <div className="ws-page-head">
              <div>
                <h2 className="ws-page-title">我的文件</h2>
                <p className="ws-page-sub">
                  共 {items.length} 个脑图与表格，含收藏 {items.filter((f) => f.starred).length} 个
                </p>
              </div>
              <div className="ws-page-actions">
                <button className="ws-create ghost" data-testid="files-create-table" onClick={() => void createFile('table')}>
                  🗂️ 新建表格
                </button>
                <button className="ws-create" data-testid="files-create-map" onClick={() => void createFile('map')}>
                  ＋ 新建脑图
                </button>
              </div>
            </div>
            <div className="ws-section-head">
              <div className="file-tabs" data-testid="file-tabs">
                {(
                  [
                    ['all', '全部'],
                    ['starred', '收藏'],
                    ['map', '脑图'],
                    ['table', '表格'],
                    ['mine', '我创建的'],
                    ['shared', '与我共享'],
                  ] as const
                ).map(([k, label]) => {
                  const count =
                    k === 'all'
                      ? items.length
                      : k === 'starred'
                        ? items.filter((f) => f.starred).length
                        : k === 'map'
                          ? items.filter((f) => f.kind === 'map').length
                          : k === 'table'
                            ? items.filter((f) => f.kind === 'table').length
                            : k === 'mine'
                              ? items.filter((f) => !isCollab(f)).length
                              : items.filter((f) => isCollab(f)).length;
                  return (
                    <button
                      key={k}
                      className={fileTab === k ? 'active' : ''}
                      data-testid={`file-tab-${k}`}
                      onClick={() => setFileTab(k)}
                    >
                      {label} {count}
                    </button>
                  );
                })}
              </div>
              <select
                className="ws-sort-select"
                data-testid="file-sort"
                aria-label="排序方式"
                value={fileSort}
                onChange={(e) => setFileSort(e.target.value as typeof fileSort)}
              >
                <option value="recent">最近编辑</option>
                <option value="name">名称</option>
                <option value="nodes">节点数</option>
              </select>
              {/* 布局切换（2026-10-25 原型 Files 页）：宫格/列表双 icon 钮 */}
              <div className="file-layout-toggle" role="group" aria-label="布局切换">
                <button
                  type="button"
                  className={fileLayout === 'grid' ? 'active' : ''}
                  data-testid="file-layout-grid"
                  aria-pressed={fileLayout === 'grid'}
                  title="宫格视图"
                  aria-label="宫格视图"
                  onClick={() => setFileLayout('grid')}
                >
                  <Lucide name="LayoutGrid" size={15} />
                </button>
                <button
                  type="button"
                  className={fileLayout === 'list' ? 'active' : ''}
                  data-testid="file-layout-list"
                  aria-pressed={fileLayout === 'list'}
                  title="列表视图"
                  aria-label="列表视图"
                  onClick={() => setFileLayout('list')}
                >
                  <Lucide name="List" size={15} />
                </button>
              </div>
            </div>
            <FileGridSorted
              items={items}
              fileTab={fileTab}
              fileSort={fileSort}
              layout={fileLayout}
              isCollab={isCollab}
              renderCard={renderCard}
              renderRow={renderRow}
            />
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
            <div className="ws-page-head" data-testid="template-page">
              <div>
                <h2 className="ws-page-title">模板中心</h2>
                <p className="ws-page-sub">精选模板，快速开始你的下一张脑图</p>
              </div>
            </div>
            {(() => {
              const hero = TEMPLATE_CATALOG[0];
              return hero ? (
                <section className="tpl-hero" data-testid="template-hero">
                  <div className="tpl-hero-text">
                    <span className="tpl-hero-badge">
                      <Lucide name="Flame" size={13} /> 本周精选
                    </span>
                    <h2>{hero.name}</h2>
                    <p>
                      {hero.blurb}。内置 {specNodeCount(hero.spec)} 个节点，开箱即用，支持随时切换为表格追踪进度。
                    </p>
                    <div className="tpl-hero-actions">
                      <button className="tpl-hero-use" data-testid="template-hero-use" onClick={() => void createFromTemplate(hero)}>
                        使用此模板 <Lucide name="ArrowRight" size={16} />
                      </button>
                      <button className="tpl-hero-preview" onClick={() => setPreviewTpl(hero)}>
                        预览
                      </button>
                    </div>
                  </div>
                  <div className="tpl-hero-thumb" aria-hidden>
                    <TemplateThumb spec={hero.spec} kind={hero.kind} accent={hero.accent} />
                  </div>
                </section>
              ) : null;
            })()}
            <div className="tpl-tabs" data-testid="template-cats">
              {(['all', ...Array.from(new Set(TEMPLATE_CATALOG.map((t) => t.category ?? ''))).filter(Boolean)] as string[]).map((c) => (
                <button key={c} className={tplCat === c ? 'active' : ''} data-testid={`template-cat-${c}`} onClick={() => setTplCat(c)}>
                  {c === 'all' ? '全部' : c}
                </button>
              ))}
            </div>
            <div className="tpl-grid" data-testid="template-grid">
              {TEMPLATE_CATALOG.filter((t) => tplCat === 'all' || t.category === tplCat).map((t) => (
                <article key={t.id} className="tpl-card" data-testid={`template-card-${t.id}`} onClick={() => setPreviewTpl(t)}>
                  <div className="tpl-card-thumb">
                    <TemplateThumb spec={t.spec} kind={t.kind} accent={t.accent} />
                    {t.tag && (
                      <span className={t.tag === '热门' ? 'tpl-tag hot' : 'tpl-tag new'}>
                        <Lucide name={t.tag === '热门' ? 'Flame' : 'Sparkles'} size={11} />
                        {t.tag}
                      </span>
                    )}
                    <div className="tpl-hover">
                      <button className="tpl-hover-preview" data-testid={`template-preview-${t.id}`} onClick={(e) => { e.stopPropagation(); setPreviewTpl(t); }}>
                        <Lucide name="Eye" size={15} />
                        预览
                      </button>
                      <button className="tpl-hover-use" onClick={(e) => { e.stopPropagation(); void createFromTemplate(t); }}>
                        使用模板
                      </button>
                    </div>
                  </div>
                  <div className="tpl-card-body">
                    <div className="tpl-card-title-row">
                      <h3>{t.name}</h3>
                      <span className="tpl-card-kind">
                        <Lucide name={t.kind === 'table' ? 'Table2' : 'Network'} size={11} />
                        {t.category}
                      </span>
                    </div>
                    <p className="tpl-card-desc">{t.blurb}</p>
                    <p className="tpl-card-uses">{t.uses} 人使用</p>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </main>

      {/* 模板预览（大缩略图 + 简介/节点数/使用人数 + 底部使用按钮，原型 Modal 同款） */}
      {previewTpl && (
        <div className="modal-mask" data-testid="template-preview" onClick={() => setPreviewTpl(null)}>
          <div className="modal template-modal" onClick={stop}>
            <div className="template-preview-head">
              <h3>{previewTpl.name}</h3>
              <button className="modal-close" aria-label="关闭预览" onClick={() => setPreviewTpl(null)}>
                ×
              </button>
            </div>
            <p className="template-blurb">
              {previewTpl.blurb} · {specNodeCount(previewTpl.spec)} 个节点 · {previewTpl.uses} 人使用
            </p>
            <div className="template-preview-thumb">
              <TemplateThumb spec={previewTpl.spec} kind={previewTpl.kind} accent={previewTpl.accent} />
            </div>
            <div className="modal-actions">
              <button onClick={() => setPreviewTpl(null)}>关闭</button>
              <button className="primary" data-testid="template-use" onClick={() => void createFromTemplate(previewTpl)}>
                使用此模板
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
