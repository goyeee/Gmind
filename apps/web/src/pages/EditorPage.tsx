import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type * as Y from 'yjs';
import {
  addChild,
  capUndoStack,
  childrenIds,
  countAliveReachable,
  countCollapsedWithChildren,
  deleteNodes,
  getMeta,
  getNode,
  ICON_GROUPS,
  MARKER_GROUP_MODE,
  markLastEditor,
  MAX_DESCRIPTION_LENGTH,
  moveNode,
  ORIGIN_USER,
  pathToRoot,
  redo as coreRedo,
  removeSummary,
  ROOT_NODE_ID,
  sanitizeCustomForDoc,
  setCustomField,
  setDocMeta,
  setDescription,
  setHref,
  setImage,
  setIcon,
  setNodeSide,
  setNote,
  setStyle,
  setSummary,
  setText,
  subtreeIds,
  listSummaries,
  validSummarySegment,
  toggleCollapse,
  undo as coreUndo,
  withTransaction,
  type IconGroup,
  type NodeSide,
} from '@gmind/core';
import {
  computeFit,
  contentBounds,
  copyNodes,
  createScene,
  createCursorLayer,
  cutNodes,
  EDITOR_BASE_FONT_SIZE,
  type CursorLayer,
  DragController,
  type DocReader,
  type Direction,
  type IDocHandle,
  layout,
  type LayoutResult,
  MARKER_CATALOG,
  MARKER_GROUP_LABELS,
  type MarkerGlyphDef,
  type NodeBox,
  navigate as navigateGeometry,
  type NodeVisual,
  pasteNodes,
  pasteText,
  readFromSystemClipboard,
  renderScene,
  type RemoteCursor,
  resolveNodeStyle,
  resolveThemeId,
  type SceneRoot,
  type SummaryBox,
  type TextStyle,
  siblingEnd,
  SelectionModel,
  THEMES,
  TextEditorOverlay,
  writeToSystemClipboard,
  Viewport,
} from '@gmind/engine';
import { todayStr } from '@gmind/shared';
import { attachKeyboardMap, isEditableTarget, resolveDirectEditKey } from '../editor/keyboardMap';
import { ActivityPanel } from '../editor/ActivityPanel';
import { ThemePanel } from '../editor/ThemePanel';
import {
  ActivityIcon,
  BackIcon,
  ExportIcon,
  FullscreenIcon,
  HistoryIcon,
  InsertIcon,
  KeyboardIcon,
  MembersIcon,
  PainterIcon,
  RedoIcon,
  SearchIcon,
  StructureIcon,
  TaskIcon,
  ThemeIcon,
  UndoIcon,
} from '../editor/icons';
import {
  clampImageSize,
  MAX_IMAGE_BYTES,
  readImageSize,
  uploadImage,
} from '../editor/imageUpload';
import { HelpPanel } from '../editor/HelpPanel';
import { MarkerPanel, MarkerChip, type MarkerTab } from '../editor/MarkerPanel';
import { MemberPanel } from '../editor/MemberPanel';
import { RichPanel } from '../editor/RichPanel';
import { StructurePanel, type StructureTypeValue } from '../editor/StructurePanel';
import { TaskTable } from '../editor/TaskTable';
import { TaskQuickCard } from '../editor/TaskQuickCard';
import { TaskPanel } from '../editor/TaskPanel';
import { CommentPanel, type CommentThreadView } from '../editor/CommentPanel';
import { FindReplace } from '../editor/FindReplace';
import { VersionPanel } from '../editor/VersionPanel';
import { startCollab, getCurrentUser, type CollabHandle, type CollabStatus, type PresenceMember } from '../editor/collab';
import {
  QUOTA_ADD_BLOCKED,
  QUOTA_STATUS,
  nextQuotaBlock,
  shouldPut,
  startSaveLoop,
} from '../editor/saveLoop';
import { useEditorDoc } from '../editor/useEditorDoc';
import { useIsMobileViewport } from '../editor/useIsMobileViewport';
import { exportXmind } from '../editor/xmind-export';
import { exportImage } from '../editor/image-export';
import { track } from '../api/events';
import { api, apiPost } from '../api/client';
import './editor.css';

/**
 * 编辑器页面装配（/edit/:fileId）— M1b Task 11。
 *
 * 只装配 @gmind/engine 交付面（layout/renderScene/Viewport/SelectionModel/
 * DragController/TextEditorOverlay/clipboard），不复刻引擎内部：
 * - DocReader/IDocHandle 用 @gmind/core 读/写 API 绑定 doc 适配；
 * - styleOf = resolveNodeStyle(theme, depth, node.style)（carry-in 裁决）；
 * - 主题切换重建场景（carry-in 裁决：渲染器部分主题色仅创建期写入）；
 * - 拖拽 onDrop 后浏览器合成的 click 用 justDragged 标记忽略（carry-in 裁决）；
 * - 键盘映射 document 冒泡 + 覆盖层/输入控件让路（carry-in 裁决）；
 * - 所有用户写后统一 capUndoStack（afterUserWrite 集中封装）。
 *
 * M1 验收修复轮（2026-09-22）新增：空格进编辑态（FR-EDT-005，M7b-W3 改绑 F2——
 * Space 曾让位给「空格+左拖平移」手势）、粘贴为选中节点
 * 子级（FR-EDT-009，推翻旧「同级」实现）、链接角标新标签页打开（FR-EDT-019）、
 * 画布粘贴截图直插（FR-EDT-020，imageUpload 共享助手）、剪贴板错误码映射。
 *
 * M7b-W3（2026-09-29，企微对标二批交互）：标记面板重做为企微式锚定竖层（挂
 * insert-wrap 下，弃 fixed 视口抽屉）+ 批量标记（多选全含则移除否则设置，单事务）；
 * 节点标记徽章点击换组（同组迷你选盘浮层）；空白无修饰左拖=框选（原 Shift+左拖，
 * 平移改道空格+左拖/中键，Viewport 自理）。
 *
 * 2026-09-30 编辑入口改进（需求方走查：「鼠标选中某主题后应该可以直接编辑，或
 * 敲击空格全选主题内容」）：① 选中即可编辑——恰单选存活节点时敲可打印字符直入
 * 编辑框（不 preventDefault，键入字符替换全选内容，与惰性新建同机制）；② 空格
 * 收回进编辑——选中节点按空格=进编辑并全选（捕获层 stopPropagation 断掉 Viewport
 * 挂 window 冒泡的空格跟踪，「空格按住+左拖平移」手势退役，画布平移只剩中键拖
 * 拽，中键不受影响）。编辑入口现为 F2 / 双击 / 空格 / 可打印字符四通道。
 *
 * M2 终审修复轮（2026-09-22）：WS 路径配额强制（FR-ACC-003 P0，M1b 终审裁定）——
 * quota-exceeded 广播置 quotaBlockedRef（nextQuotaBlock 事件机），新增入口
 * （Tab/Enter/Shift+Tab/右键插入/粘贴）toast 拦截；拦截期间 persisted ack 复查
 * countAliveReachable 并保持配额指示不被「已保存」覆盖；删除节点解除。
 */

// 单例测量适配器：Canvas measureText（引擎 MeasureAdapter 实现）。
const measureCtx = document.createElement('canvas').getContext('2d');
const measure = {
  measureTextLine(text: string, style: TextStyle): number {
    if (!measureCtx) return text.length * style.fontSize;
    measureCtx.font = `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
    return measureCtx.measureText(text).width;
  },
};

// 结构选项卡片（2026-09-30 任务 3）已随 structure-select 下拉移除迁入
// StructurePanel（结构选项/缩略图/高亮口径内聚在面板组件）。


/** 缩放快捷档位（Task 15 FR-EDT-027，PRD 50%~200%）。 */
const ZOOM_PRESETS = [50, 75, 100, 150, 200];

/** node_add/node_delete 埋点的操作方式（M5 Task 4，PRD 6.4「操作方式」）：键盘 /
 *  右键菜单 / 拖拽 / 粘贴。drag 当前无生产点（画布拖拽是 moveNode 移动，非增删），
 *  联合类型保留以对齐埋点契约；paste 一次粘贴动作记一行 node_add（多节点合并计数
 *  不拆行）。 */
type NodeVia = 'keyboard' | 'context' | 'drag' | 'paste';

/** 格式刷模式态（M6 Task 7，企微对标）：源节点 id + 格式快照（style 逐键 + icons
 *  逐组值数组（M7b-W1 多值），NodeSnapshot 读取侧纯数据）+ 是否粘滞（双击进入：
 *  连续应用到逐个点击的节点，Esc / 再点按钮退出；单击 = 单发：应用一次即退出）。 */
type PainterMode = {
  sourceId: string;
  style: Record<string, string>;
  sticky: boolean;
};

/** WS 断开（或全断网）时的保存指示（M2 Task 3，FR-EDT-034）。 */
const OFFLINE_STATUS = '离线编辑中，恢复联网后自动同步';

/** 顶栏头像栏展示上限（M6 Task 9，企微对标）：超出折叠为「+N」溢出位。 */
const MAX_AVATARS = 5;

/** CollabStatus → 保存指示文案（四值：已保存 HH:MM / 保存中 / 离线编辑中 / 配额非重试）。 */
function statusText(status: CollabStatus, detail?: string): string | null {
  switch (status) {
    case 'synced':
      return null; // 仅推进真值表状态（EditorPage 内联处理），不改指示
    case 'offline':
      return OFFLINE_STATUS;
    case 'saved': {
      const at = detail ? new Date(detail) : null;
      const time =
        at && !Number.isNaN(at.getTime())
          ? `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
          : clockNow();
      return `已保存 ${time}`;
    }
    case 'quota':
      return QUOTA_STATUS; // 复用 M1 非重试文案（FR-ACC-003）
    default:
      return null; // connecting：不覆盖既有指示
  }
}

function clockNow(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * 简洁模式偏好键（M7b 补课，mindgrid 账号级显示偏好「脑图简洁模式」的移植）：
 * localStorage 持久（浏览器本地、跨文件/刷新保持），**不入文档数据**——纯显示
 * 偏好，不进 Yjs、不参与协同与保存。值 '1' = 开、缺省/其他 = 关。
 */
const COMPACT_STORAGE_KEY = 'gmind.compact';

/**
 * 简洁模式图标（M7b 补课）：三行收拢线形（行长递减 = 内容收敛）。本地图标组件
 * ——与 ../editor/icons 同款约定（16×16、stroke=currentColor、strokeWidth 1.6），
 * 仅简洁模式一个消费者，不外溢图标集文件。
 */
function CompactIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.5 4h11" />
      <path d="M2.5 8h7" />
      <path d="M2.5 12h4" />
    </svg>
  );
}

export function EditorPage() {
  const { fileId = '' } = useParams();
  const navigate = useNavigate();
  // 移动端只读（M5 Task 5，OPEN-T-005）：≤768px 视口 = 客户端能力降级为只读——
  // 隐藏全部编辑控件、不装配写交互（键盘/拖拽/右键/双击/画布粘贴）；保留画布
  // 渲染、平移/缩放手势（Viewport 自有监听不动）、折叠徽标点击、评论（面板
  // 查看+发表+角标点击过滤）。**非安全边界**：服务端不区分移动端写请求（验收
  // 文档登记）。matchMedia change 监听驱动：断点跨越即时升降级（装配 effect 以
  // readOnly 为依赖，跨越即按文件切换同款路径重建场景/协同）。
  const readOnly = useIsMobileViewport();
  const { state, error, setTitle, baseUpdatedAtRef } = useEditorDoc(fileId);
  const doc = state?.doc ?? null;
  const um = state?.um ?? null;
  // 创建者标识依据（M2 Task 6，FR-COL-005）：GET /api/files/:id 扩展字段
  const ownerUserId = state?.ownerUserId ?? null;

  // dev-only 性能压测钩子（e2e/perf-editor.spec.ts 专用）：页面上下文经
  // window.__gmind.getDoc() 取活动 doc 实例（脚本另用 /@id/@gmind/core 动态导入
  // 复用页面同一模块实例）。import.meta.env.DEV 在生产构建为 false，本副作用被剔除。
  useEffect(() => {
    if (!import.meta.env.DEV || !doc) return;
    (window as unknown as { __gmind?: { getDoc: () => Y.Doc } }).__gmind = {
      getDoc: () => doc,
    };
    return () => {
      delete (window as unknown as { __gmind?: unknown }).__gmind;
    };
  }, [doc]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SceneRoot | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const selectionRef = useRef<SelectionModel | null>(null);
  const dragRef = useRef<DragController | null>(null);
  const overlayRef = useRef<TextEditorOverlay | null>(null);
  if (!overlayRef.current) overlayRef.current = new TextEditorOverlay();
  const overlay = overlayRef.current;
  const boxesRef = useRef<NodeBox[]>([]);
  const layoutRef = useRef<LayoutResult | null>(null);
  const justDraggedRef = useRef(false);
  const themeRef = useRef<string>('');
  const fitPendingRef = useRef(false);
  // Tab/Enter 惰性编辑（2026-09-28 需求方走查，企微语义）：pendingEdit = 刚创建
  // 待编辑的节点 id（敲首个可打印字符才开编辑框，见 openPendingEditor / keydown
  // effect）；pendingCancel = 该节点的回收闭包（Esc / 空提交复用，含 parent 关系
  // 还原）。ref 而非 state：keydown 监听同步读，不等 React 提交。
  const pendingEditRef = useRef<string | null>(null);
  const pendingCancelRef = useRef<(() => void) | null>(null);
  // 当前挂 gm-editing 类的节点 id（任务 4 编辑重影根治）：编辑覆盖层单例，换节点
  // 编辑时先摘旧再挂新（helper setEditingClass 统一收口）。
  const editingNodeIdRef = useRef<string | null>(null);
  // perf_metric 埋点的一次性闸（M5 Task 4）：装载完成恰一行——值 = 已上报的 fileId
  // （StrictMode dev 双跑与依赖重触发以此去重；切换文件后重新计一次）
  const perfTrackedRef = useRef<string | null>(null);
  // 远端光标层（M2 Task 5）与最新远端光标集：awareness 变化写 ref，rerender 时
  // （含主题切换重建场景后）随新布局盒子整集重画。
  const cursorLayerRef = useRef<CursorLayer | null>(null);
  const remoteCursorsRef = useRef<RemoteCursor[]>([]);
  // collab 句柄 ref：afterUserWrite / selection.onChange 需要在装配完成后回调
  // （markEditing / setSelection），时序晚于 startCollab 的调用点。
  const collabHandleRef = useRef<CollabHandle | null>(null);
  // 在线成员（FR-COL-005）：collab onPresence 推进；成员面板开合。
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  // 头像点击定位目标（M6 Task 9 评审修复轮）：随面板打开传给 MemberPanel——滚动
  // 目标成员行进视口并短时高亮。members-btn/溢出位打开置 null（无定位目标）；
  // 面板关闭时清空（下次普通打开不复用旧目标）。
  const [membersFocus, setMembersFocus] = useState<string | null>(null);
  // 顶栏头像栏的会话内已见成员（M6 Task 9，企微对标）：presence 只含在线者，
  // 「离线=灰」要求记住本会话曾出现过的成员——同一 onPresence 通道的派生缓存
  // （非第二获取通道），Map 按 userId 去重、插入序=首见序（稳定展示顺序，
  // 重复加入不换位）。文件切换随装配 effect cleanup 整体重置。
  const [avatarSeen, setAvatarSeen] = useState<Map<string, PresenceMember>>(() => new Map());
  // 版本历史面板开合（M4 Task 8，FR-VER-004 UI）：装配模式同成员面板 open/onClose
  const [versionsOpen, setVersionsOpen] = useState(false);
  // 文档动态面板开合（M6 Task 8，企微对标）：版本历史旁入口，open/onClose 同款装配
  const [activityOpen, setActivityOpen] = useState(false);
  // 快捷键帮助面板开合（M5 Task 2，FR-EDT-007）：Ctrl/Cmd+? 经 keyboardMap onHelp
  // 与工具栏「快捷键」按钮双入口，均为 toggle 语义
  const [helpOpen, setHelpOpen] = useState(false);
  // 查找替换条开合（M6 Task 3，企微对标）：Ctrl/Cmd+F / find-toggle 双入口打开，
  // Esc / find-close 关闭（组件内部不持开合态）
  const [findOpen, setFindOpen] = useState(false);
  // 主题缩略图选择面板开合（M6 Task 4，企微对标）：theme-panel-toggle 打开，
  // theme-panel-close / 套用任一主题后关闭；与 theme-select 并存（零回归裁决）
  const [themePanelOpen, setThemePanelOpen] = useState(false);
  // 结构切换面板开合（2026-09-30 任务 3，仿 ThemePanel）：structure-toggle 打开，
  // 关闭通道=套用即收 / × 钮 / Esc / 外点（统一外点监听豁免 .structure-panel）。
  const [structurePanelOpen, setStructurePanelOpen] = useState(false);
  // 结构/主题面板锚定 wrap（2026-09-30 需求方四条反馈任务 1）：两面板从 fixed 右上
  // 改为企微式「按钮正下方贴靠下拉」——按钮包一层 relative wrap，面板 absolute 挂
  // wrap 下（同 insert-wrap/export-wrap 贴按钮下拉先例）。ref 供渲染期实测 wrap
  // 屏幕坐标做右缘越界钳制（见 anchoredOffsetLeft）。
  const structureWrapRef = useRef<HTMLDivElement | null>(null);
  const themeWrapRef = useRef<HTMLDivElement | null>(null);
  // 格式刷（M6 Task 7，企微对标）：null = 未激活。state 驱动按钮 active / body
  // 光标 class 渲染；painterRef 供事件处理器同步读——双击序列里 click#2 退出与
  // dblclick 粘滞重进之间不等 React 提交，读 state 会拿到滞后一拍的旧值。
  const [painter, setPainter] = useState<PainterMode | null>(null);
  const painterRef = useRef<PainterMode | null>(null);
  // 当前用户身份（M4 Task 2 邀请区可见性）：与 awareness/last_editor 共用 users/me
  // 模块级缓存（不重发请求）；canInvite = 当前用户即创建者（WorkspacePage 行菜单
  // ownerUserId === me?.id 同口径），身份未装配（id 空串）一律不可见。
  const [meId, setMeId] = useState('');
  useEffect(() => {
    let alive = true;
    void getCurrentUser().then((me) => {
      if (alive) setMeId(me.id);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 框选橡皮筋（Task 15 FR-EDT-008）：svg 直挂的 <rect class="gm-marquee">（不进
  // wrapper——橡皮筋按 svg 相对 screen 坐标自绘，不受视口 transform），锚点同步记
  // screen 坐标供 move 阶段重绘。
  const marqueeRectRef = useRef<SVGRectElement | null>(null);
  const marqueeAnchorScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // 空白点击清空选择的位移判定（M6 Task 2）：pointerdown 记录按点坐标，click 期位移
  // >4px 即视为平移/框选拖拽的合成 click，不清空选择。
  const pointerPressRef = useRef<{ x: number; y: number } | null>(null);
  // 视图切换（M7a-T4，spec 2026-09-28 §四 T4）：脑图 | 表格。切换互斥、各自状态保留
  // ——画布引擎（场景/视口/选中）不动、仅 CSS 隐藏；表格组件常驻挂载、隐藏时保住
  // 筛选/排序态。viewRef 供事件处理器（键盘闸/Ctrl+F）同步读最新视图，不等 React 提交。
  const [view, setView] = useState<'mind' | 'table'>('mind');
  const viewRef = useRef<'mind' | 'table'>('mind');
  viewRef.current = view;
  // 移动端只读降级（M7a 范围注记）：只读工具栏不装配视图 Tab（维持现状），停留表格
  // 视图会失去切回入口——降级即回落画布视图。
  useEffect(() => {
    if (readOnly) setView('mind');
  }, [readOnly]);

  // 简洁模式（M7b 补课，mindgrid 账号级显示偏好）：隐藏描述与任务详情、节点收敛
  // 紧凑盒（引擎 LayoutOptions.compact / SceneInput.compact 双侧接线）。装载时读
  // localStorage 初始值；ref 供装配闭包（rerender/scheduleRerender）同步读最新值
  // ——切换即重渲染不等 React 提交（viewRef 同款裁定）。仅显示偏好，不入文档。
  const [compact, setCompact] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COMPACT_STORAGE_KEY) === '1';
    } catch {
      return false; // storage 不可读（隐私模式等）：按关兜底
    }
  });
  const compactRef = useRef<boolean>(compact);
  compactRef.current = compact;
  // 装配后画布重排入口 ref（同 commentsRefreshRef 桥接模式）：简洁模式切换是纯
  // 显示偏好、无文档写入，需要该入口主动触发 scheduleRerender。
  const scheduleRerenderRef = useRef<(() => void) | null>(null);

  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState('尚未编辑');
  // 星标态（M3b 清偿包，FR-FIL-004）：GET /:id 的 starred 为初始值，工具栏切换乐观更新
  const [starred, setStarred] = useState(false);
  // 协同通道真值表状态（M2 Task 3）：startCollab 回调推进，saveLoop 经桥接消费。
  // ref 而非 state：决策函数读的是最新值，不需要触发渲染。
  const collabRef = useRef({ wsConnected: false, wsEverConnected: false });
  // WS 路径配额拦截标志（M2 终审修复轮，FR-ACC-003 P0）：'quota' 广播置位，
  // nextQuotaBlock 按裁定事件收敛（删除解除 / persisted ack 复查）。shouldPut 在
  // WS 在线时停用 PUT，服务端广播本为 advisory——此标志把 ≤500 节点控制落到客户端。
  const quotaBlockedRef = useRef(false);
  const [toast, setToast] = useState('');
  const [zoomPct, setZoomPct] = useState(100);
  // 导出菜单（M4 Task 5，FR-IO-004）：工具栏「导出」按钮的下拉开合。
  const [exportOpen, setExportOpen] = useState(false);
  // PNG 透明背景勾选（M4 Task 9，FR-IO-003）：默认勾选；JPG 无 alpha 恒白底。
  const [exportTransparent, setExportTransparent] = useState(true);
  const exportWrapRef = useRef<HTMLDivElement | null>(null);
  // 格式面板开合（M7b-R2 需求方裁定）：样式右列默认不显示，收进工具栏「格式」按钮。
  const [formatOpen, setFormatOpen] = useState(false);
  // 右侧任务面板开合（M7c-C4）：与格式面板互斥（开任务收格式、开格式收任务）。
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  // 任务快速设置弹层（M7c-C3）：nodeId + 弹出锚点（viewport 客户端坐标，fixed 定位）。
  // 右键菜单「任务设置」/ 选中节点按 `,` 双入口；Esc/外点关（markerPicker 同机制）。
  const [quickCard, setQuickCard] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  // 插入菜单（2026-09-28 二次改版）+ 标记面板（M7b-W3 企微式竖层重做）：
  // 面板为**锚定弹出层**——挂在 .insert-wrap 下（absolute），状态 {open, tab, anchor}
  // 扩展 anchor = 插入按钮 getBoundingClientRect（面板顶贴按钮下沿、左缘对齐；
  // 右缘越界时按 anchor 换算 offsetLeft 收回视口）。tab 由「图标/表情」菜单项决定，
  // 面板内可切换；对齐企微「顶部按钮点开竖层」形态，不再是 fixed 视口抽屉。
  const [insertOpen, setInsertOpen] = useState(false);
  const [markerPanel, setMarkerPanel] = useState<{
    open: boolean;
    tab: MarkerTab;
    anchor: { left: number; top: number };
  }>({ open: false, tab: 'icon', anchor: { left: 0, top: 0 } });
  const insertWrapRef = useRef<HTMLDivElement | null>(null);
  // 节点标记点击换组（M7b-W3 #4）：徽章命中 → 该组迷你选盘浮层（HTML 层锚定点击点，
  // contextMenu 同款 fixed 定位；nodeId/group 为写入目标，x/y 为弹出锚点）。
  const [markerPicker, setMarkerPicker] = useState<{
    nodeId: string;
    group: IconGroup;
    x: number;
    y: number;
  } | null>(null);
  // 右键菜单（Task 12）：nodeId 为节点菜单锚点；summaryId 为概要菜单锚点（M6 T6，
  // 二者互斥——右键命中 bracket 时弹概要菜单，命中节点时弹节点菜单）
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; nodeId: string; summaryId?: undefined }
    | { x: number; y: number; nodeId?: undefined; summaryId: string }
    | null
  >(null);
  // 概要标签行内编辑（M6 Task 6，企微对标）：输入框锚定 bracket 标签位置（svg 相对
  // 坐标，绝对定位在 .editor-canvas 内）。summaryId null = 新建前预填段（创建流：
  // 先 setSummary 默认标签再打开，故实际总携带 id——预留字段供 Esc 回滚语义扩展）。
  const [summaryEdit, setSummaryEdit] = useState<{
    summaryId: string | null;
    nodeIds: string[];
    label: string;
    left: number;
    top: number;
  } | null>(null);
  // Esc 已取消的编辑不再被 onBlur 提交（Blur 提交与 Esc 取消互斥的一次性闸）
  const summaryEditCancelled = useRef(false);
  // 评论域（M3b Task 7，FR-CMT-002）：进入文档 GET /comments 全量拉取，之后仅由
  // comment-updated 无状态广播（含自身 POST 触发的广播）驱动再拉取——评论不进
  // Y.Doc，独立于协同文档通道。
  const [comments, setComments] = useState<{ threads: CommentThreadView[]; counts: Record<string, number> }>(
    { threads: [], counts: {} },
  );
  // 角标计数走 ref：rerender()（场景协调）读最新 counts，无需为此推进 React state
  const commentCountsRef = useRef<Record<string, number>>({});
  // 面板/角标点击的刷新入口（装配 effect 内定义；POST 成功后直接触发，广播路径
  // 由 in-flight 去重收敛，离线无广播时此入口兜底）
  const commentsRefreshRef = useRef<(() => void) | null>(null);
  // 单节点筛选视图（角标点击进入，「查看全部」退出）
  const [commentFilter, setCommentFilter] = useState<string | null>(null);
  // 移动端评论抽屉开合（M5 Task 5）：桌面常驻右列；移动端由工具栏「评论」开关
  // 控制底部抽屉（画布为主面，评论按需浮出）
  const [commentsOpen, setCommentsOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string): void => {
    setToast(message);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  // 导出菜单外点关闭（M7c-D2：监听改 pointerdown——onSvgPointerDown 的
  // preventDefault 会抑制兼容性 mousedown，画布空白点击此前收不起菜单；
  // 打开期间命中按钮/菜单之外即收起）
  useEffect(() => {
    if (!exportOpen) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (exportWrapRef.current && !exportWrapRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [exportOpen]);

  // —— 插入菜单 + 标记面板弹层（M7b-W3：面板同挂 insert-wrap，Esc/外点关闭沿用
  // insert-layer 机制）——菜单与面板互斥（开面板收菜单、开菜单收面板）；打开期间
  // document pointerdown 命中 insert-wrap 之外即收（M7c-D2：mousedown 会被画布
  // preventDefault 抑制）、Esc 即收；只读降级即收。
  const closeInsertLayer = (): void => {
    setInsertOpen(false);
    setMarkerPanel((p) => (p.open ? { ...p, open: false } : p));
  };
  /** 「图标/表情」菜单项入口：记录插入按钮 anchor（getBoundingClientRect）后开面板。 */
  const openMarkerPanel = (tab: MarkerTab): void => {
    const rect = insertWrapRef.current?.getBoundingClientRect();
    setInsertOpen(false);
    setMarkerPanel({
      open: true,
      tab,
      anchor: rect ? { left: rect.left, top: rect.bottom } : { left: 0, top: 0 },
    });
  };
  useEffect(() => {
    if (!(insertOpen || markerPanel.open)) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (insertWrapRef.current && !insertWrapRef.current.contains(e.target as Node)) {
        closeInsertLayer();
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeInsertLayer();
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [insertOpen, markerPanel.open]);
  useEffect(() => {
    if (readOnly && (insertOpen || markerPanel.open)) {
      closeInsertLayer();
    }
  }, [readOnly, insertOpen, markerPanel.open]);

  // —— 迷你选盘（节点标记点击换组）Esc/外点关闭（面板同机制；M7c-D2 改 pointerdown
  // —— mousedown 被画布 onSvgPointerDown 的 preventDefault 抑制，空白点击收不起）——
  // 徽章豁免（kimi 复验 P3）：徽章画在 SVG 里（engine markers 的 .gm-marker-badge），
  // 不在 .marker-picker 内——不豁免的话选盘开着点徽章时 pointerdown 先收盘、紧随的
  // 徽章 click 又无条件重开 → 闪关重弹永远关不掉；开合交给徽章 click 的 toggle。
  useEffect(() => {
    if (!markerPicker) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.marker-picker, .gm-marker-badge')) {
        setMarkerPicker(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMarkerPicker(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [markerPicker]);

  // —— 任务快速设置弹层（M7c-C3）——
  /**
   * 打开快速卡：锚点显式给（右键点击点）或按节点盒右缘换算（`,` 快捷键触发——
   * viewport 场景坐标 → svg 客户端坐标，fixed 定位）。节点不存在（空文档）按
   * root 盒兜底定位。
   */
  const openQuickCard = (nodeId: string, x?: number, y?: number): void => {
    let ax = x;
    let ay = y;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if ((ax === undefined || ay === undefined) && vp && svgEl) {
      const box = boxesRef.current.find((b) => b.id === nodeId) ?? boxesRef.current[0];
      if (box) {
        const rect = svgEl.getBoundingClientRect();
        const p = vp.toScreen(box.x + box.w, box.y);
        ax = rect.left + p.x;
        ay = rect.top + p.y;
      }
    }
    setQuickCard({ nodeId, x: ax ?? 120, y: ay ?? 120 });
  };

  // 快速卡 Esc/外点关闭（markerPicker 同款：document pointerdown 命中卡片之外即收；
  // M7c-D2 改 pointerdown——mousedown 被画布 preventDefault 抑制，空白点击收不起）
  useEffect(() => {
    if (!quickCard) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.task-quickcard')) setQuickCard(null);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setQuickCard(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [quickCard]);

  // 只读降级 / 切表格视图即收快速卡（写弹层不跨视图驻留）
  useEffect(() => {
    if (readOnly) setQuickCard(null);
    if (readOnly && taskPanelOpen) setTaskPanelOpen(false);
    // 结构面板随桌面工具栏装配：只读降级即收（按钮已不装配，面板不留存）
    if (readOnly && structurePanelOpen) setStructurePanelOpen(false);
  }, [readOnly, taskPanelOpen, structurePanelOpen]);
  useEffect(() => {
    if (view === 'table') setQuickCard(null);
  }, [view]);

  // —— 工具栏弹层统一外点关闭（2026-09-28 需求方走查：插入/主题/成员/版本/动态/
  // 快捷键/查找/格式/任务/评论点其他地方必须自动消失）——导出/插入/标记已有各自
  // wrapRef 外点监听（上方 4 处 effect，不动），此处收拢其余面板：任一开启即挂
  // document pointerdown，命中豁免区（面板容器 / 带 data-popover-toggle 的切换
  // 按钮——按钮豁免让 pointerdown 不抢先关闭、onClick toggle 正常收起）之外全部
  // 收起。容器口径：右列 .editor-right 整体豁免（评论 pane 关闭按钮与面板内部
  // 交互不受影响）；浮层面板按各自根类名（member-panel/version-panel/theme-panel/
  // activity-panel/help-panel/find-bar）。
  useEffect(() => {
    const anyOpen =
      membersOpen ||
      versionsOpen ||
      activityOpen ||
      helpOpen ||
      findOpen ||
      themePanelOpen ||
      structurePanelOpen ||
      formatOpen ||
      taskPanelOpen ||
      commentsOpen;
    if (!anyOpen) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      const el = e.target as Element | null;
      if (!el?.closest) return;
      // 插入/导出菜单内部（含「链接/图片」等右列联动菜单项）豁免：菜单项点击的
      // pointerdown 若在此收掉 formatOpen，紧随的 click 再开会出现一帧收-开抖动，
      // 且聚焦时序与互斥语义纠缠（E3 回归修复）——菜单自身的开合由各自监听管理。
      // 结构/主题面板 wrap（2026-09-30 任务 1）：面板已挂 .structure-wrap/.theme-wrap
      // 下，wrap 整体豁免（面板根类 .structure-panel/.theme-panel 亦在下方豁免清单，
      // 双保险防 wrap 与面板之间的 6px 间隙点击误收）。
      if (
        el.closest('[data-popover-toggle]') ||
        el.closest(
          '.editor-right, .editor-mobile-comments, .theme-panel, .structure-panel, .theme-wrap, .structure-wrap, .activity-panel, .help-panel, .find-bar, .member-panel, .version-panel',
        ) ||
        insertWrapRef.current?.contains(el) ||
        exportWrapRef.current?.contains(el)
      ) {
        return;
      }
      setMembersOpen(false);
      setVersionsOpen(false);
      setActivityOpen(false);
      setHelpOpen(false);
      setFindOpen(false);
      setThemePanelOpen(false);
      setStructurePanelOpen(false);
      setFormatOpen(false);
      setTaskPanelOpen(false);
      setCommentsOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [
    membersOpen,
    versionsOpen,
    activityOpen,
    helpOpen,
    findOpen,
    themePanelOpen,
    structurePanelOpen,
    formatOpen,
    taskPanelOpen,
    commentsOpen,
  ]);

  // —— 结构面板（2026-09-30 任务 3）：Esc 关闭（ThemePanel 无 Esc，本面板按需求
  // 方要求补齐；编辑覆盖层自身的 Esc 先行 stopPropagation 不受影响）。 ——
  useEffect(() => {
    if (!structurePanelOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setStructurePanelOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [structurePanelOpen]);

  // —— 右列面板开启的可见性兜底（M7c-D2 kimi P2 右列遮挡）——
  // editor-right 为 flex 占位列：开启瞬间画布收窄 280px，但视口变换不变 → 原贴
  // 右缘的选中节点被新列宽裁出可视区（感知上「被面板挡住、不可点」）。开面板即
  // 把当前单选节点平移进可视区（panNodeIntoView 对完整可见节点 no-op，不扰视口）。
  // 依赖仅开合态：panNodeIntoView 读 ref 每次渲染重建，不入依赖（同 locateNode
  // 通知深链 effect 的裁定）。
  useEffect(() => {
    if (readOnly || view === 'table') return;
    if (!(formatOpen || taskPanelOpen || commentsOpen)) return;
    const selection = selectionRef.current;
    if (!selection || selection.selected.size !== 1) return;
    panNodeIntoView([...selection.selected][0]);
  }, [formatOpen, taskPanelOpen, commentsOpen, view, readOnly]);

  // `,`（逗号）快捷键（M7c-C3）：选中节点弹出任务快速卡；再按 = toggle 关闭
  // （kimi 复验 P4：原实现无开合态判断，卡片开着再按重复 openQuickCard 重锚，永远
  // 关不掉——现已改为同节点收盘，换节点才重开重锚）。独立监听（不入 keyboardMap
  // ——帮助清单契约不动）；让路纪律与 Ctrl+F 同款：覆盖层/输入控件/表格视图不触发；
  // 恰单选才生效（多选无单一目标、空选无目标）。quickCard 入依赖：闭包读当帧开合态。
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== ',') return;
      if (overlay.isOpen || isEditableTarget(e.target)) return;
      if (viewRef.current === 'table') return;
      const selection = selectionRef.current;
      if (!selection || selection.selected.size !== 1) return;
      e.preventDefault();
      const nodeId = [...selection.selected][0];
      if (quickCard && quickCard.nodeId === nodeId) {
        setQuickCard(null); // 已开且锚的就是当前单选节点：toggle 收盘
        return;
      }
      openQuickCard(nodeId);
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [readOnly, quickCard]);


  /**
   * 标记写入（M7b-W3 #5 批量语义）：对**选中集全部节点**逐个 setIcon，单事务
   * 一次性提交（内层 withTransaction 嵌套复用外层事务，一次 Ctrl+Z 整体回滚）；
   * afterUserWrite 统一收口（origin/capUndoStack 纪律不变），错误 toast 两段式。
   *
   * 方向展开（需求方 #5 裁定「single 组全组已含该值→移除，否则设置」，multi 组
   * toggle 同义）：single 组全部选中已含 → 逐节点置 null 移除该组，否则给缺该值
   * 的节点设置（已含者零写入，不给撤销栈留空项）；multi 组全部已含 → toggle 移除，
   * 否则给缺该值节点 toggle 叠加（setIcon 的 toggle 语义天然收敛到目标态）。
   */
  const applyMarker = (group: IconGroup, value: string): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected].filter((id) => {
      const snap = getNode(doc, id);
      return !!snap && !snap.deleted;
    });
    if (ids.length === 0) return;
    const hasValue = (id: string): boolean =>
      getNode(doc, id)?.icons?.[group]?.includes(value) ?? false;
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        const allHave = ids.every(hasValue);
        if (MARKER_GROUP_MODE[group] === 'multi') {
          const desired = !allHave; // 全含 → 全移除；否则补齐到全含
          for (const id of ids) {
            if (hasValue(id) !== desired) setIcon(doc, id, group, value);
          }
        } else if (allHave) {
          for (const id of ids) setIcon(doc, id, group, null);
        } else {
          for (const id of ids) {
            if (!hasValue(id)) setIcon(doc, id, group, value);
          }
        }
      });
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '标记设置失败');
    }
  };

  /**
   * 迷你选盘写入（M7b-W3 #4，单节点）：同值 = 移除（single 置 null / multi toggle
   * 同值即移除），他值 = single 组内替换 / multi 叠加——core setIcon 组语义直写 +
   * afterUserWrite。目标节点已删（选盘开着被协同删除等）即收盘。
   */
  const applyPickerValue = (value: string): void => {
    const picker = markerPicker;
    if (!doc || !picker) return;
    const snap = getNode(doc, picker.nodeId);
    if (!snap || snap.deleted) {
      setMarkerPicker(null);
      return;
    }
    const has = snap.icons?.[picker.group]?.includes(value) ?? false;
    try {
      if (MARKER_GROUP_MODE[picker.group] === 'single') {
        setIcon(doc, picker.nodeId, picker.group, has ? null : value);
      } else {
        setIcon(doc, picker.nodeId, picker.group, value); // multi：core toggle（含则移除）
      }
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '标记设置失败');
    }
  };

  /**
   * 插入菜单的右面板聚焦入口：滚动 RichPanel 对应控件进视口并聚焦（备注
   * textarea / 链接 input）；控件不在（无选中节点 → RichPanel 空态）时给可行动
   * toast。图片走 image-input click（触发系统文件选择器）。
   */
  const focusRichControl = (selector: string, hint: string): void => {
    const root = document.querySelector('[data-testid="rich-panel"]');
    const el = root?.querySelector<HTMLElement>(selector) ?? null;
    if (!el) {
      showToast(hint);
      return;
    }
    el.scrollIntoView({ block: 'nearest' });
    el.focus();
  };

  /**
   * M7c-E3 回归修复：右列默认不渲染（M7b-R6）后，链接/图片项的控件只有
   * formatOpen 时才在 DOM——先开格式面板，下一帧（面板挂载后）再聚焦，控件
   * 仍缺（无选中节点）才落到可行动 toast。同帧直接查 DOM 会查空（React 尚未
   * 提交渲染）。
   */
  const openRichAndFocus = (selector: string, hint: string): void => {
    setFormatOpen(true);
    requestAnimationFrame(() => focusRichControl(selector, hint));
  };

  const triggerImageInput = (): void => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="rich-panel"] [data-testid="image-input"]',
    );
    if (!input) {
      showToast('选中节点后添加图片');
      return;
    }
    input.click();
  };

  // —— 查找替换键位（M6 Task 3，企微对标）——
  // Ctrl/Cmd+F 打开：非输入控件时 preventDefault 接管浏览器原生查找；焦点在
  // input/textarea/select（标题输入、查找输入自身等）时让路原生行为，不重复触发
  // 打开（isEditableTarget 与键盘映射/画布粘贴同一判定）。移动端只读不装配。
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'f' && e.key !== 'F') return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target)) return;
      if (viewRef.current === 'table') return; // 表格视图：查找需求由表格筛选条承接，不开画布查找条
      e.preventDefault();
      setFindOpen(true);
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [readOnly]);

  // Esc 关闭查找条（清空定位）：打开期间挂 document 冒泡监听——查找输入内的 Esc
  // 冒泡至此同样命中；节点编辑覆盖层的 Esc 先行 stopPropagation（不冲突）。
  useEffect(() => {
    if (!findOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setFindOpen(false);
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [findOpen]);

  // —— 格式刷模式态副作用（M6 Task 7，企微对标）——
  // Esc 退出（含粘滞）：输入控件让路（isEditableTarget 与查找条同一判定——节点
  // 编辑覆盖层自身 stopPropagation，概要标签输入内的 Esc 不连带退出格式刷）。
  // 移动端只读不装配（键盘映射同款 readOnly 依赖纪律）。
  useEffect(() => {
    if (!painter || readOnly) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || isEditableTarget(e.target)) return;
      e.preventDefault();
      painterRef.current = null;
      setPainter(null);
    };
    document.addEventListener('keydown', onKeyDown, false);
    return () => document.removeEventListener('keydown', onKeyDown, false);
  }, [painter, readOnly]);
  // 光标提示：模式激活期 body 挂 painter-active（editor.css 画布 cursor:copy；
  // 只挂画布区域，工具栏/面板光标不受影响）。卸载/退出即摘除。
  useEffect(() => {
    if (!painter) return;
    document.body.classList.add('painter-active');
    return () => document.body.classList.remove('painter-active');
  }, [painter]);
  // 移动端只读降级即退出（按钮随工具栏隐藏，模式态不留存；applyPainterTo 自身
  // 亦持 readOnly 闸，此处收干净光标 class 等激活期副作用）
  useEffect(() => {
    if (readOnly && painterRef.current) {
      painterRef.current = null;
      setPainter(null);
    }
  }, [readOnly]);

  /**
   * 配额拦截闸（M2 终审修复轮）：置位期间阻止**新增**节点（PRD FR-ACC-003 语义），
   * 删除/既有节点文本编辑/样式修改/拖拽移动不受限。命中给出可行动 toast 并返回 true。
   */
  const addBlockedByQuota = (): boolean => {
    if (!quotaBlockedRef.current) return false;
    showToast(QUOTA_ADD_BLOCKED);
    return true;
  };

  /**
   * 所有用户写后统一调用（carry-in 裁决：capUndoStack 集中封装）。
   * 最后修改人标记（M3a Task 4，FR-FIL-001）：写 doc meta.lastEditorUserId（core
   * markLastEditor，system origin 默认——不进撤销栈），随协同持久化或 PUT 兜底
   * 到达服务端回写 files.last_modifier_user_id。身份经 users/me 模块级缓存异步
   * 装配（与 awareness 共用），未装配（id 空串，离线首开/接口失败）跳过。
   */
  const afterUserWrite = (): void => {
    if (doc) {
      void getCurrentUser().then((me) => {
        if (me.id !== '') markLastEditor(doc, me.id);
      });
    }
    if (um) capUndoStack(um);
    // 「正在编辑」广播（FR-COL-005）：本地写置 true，60s 无写回落（裁定见 collab.ts）
    collabHandleRef.current?.markEditing();
    // 右列面板开启期间节点文本重排可能变宽（编辑提交/批量标记等写路径），贴右缘
    // 的选中节点会被面板列裁掉（M7c-D2 kimi P3 同源）——单选恰一节点时平移进
    // 可视区兜底（panNodeIntoView 对完整可见节点 no-op，不扰视口）。state 直接读
    // 闭包：afterUserWrite 每渲染重建，拿到的 formatOpen 等恒为当帧值。
    if (formatOpen || taskPanelOpen || commentsOpen) {
      const selection = selectionRef.current;
      if (selection && selection.selected.size === 1) {
        const nodeId = [...selection.selected][0];
        // 写后布局异步（update→scheduleRerender→rAF 重渲染→boxesRef 才更新）：同步
        // 读到的是变宽前的旧盒 → no-op → 下一帧卡片变宽冲出画布被面板裁切（kimi
        // 复验 P3，描述提交后卡片 309→873px、右缘 1700 vs 画布 1160）。延一帧等盒
        // 子重排后再平移；对完整可见节点仍 no-op，不扰视口。
        requestAnimationFrame(() => panNodeIntoView(nodeId));
      }
    }
  };

  const syncZoom = (): void => {
    const vp = viewportRef.current;
    if (vp) setZoomPct(Math.round(vp.scale * 100));
  };

  /** 加星切换（M3b 清偿包，FR-FIL-004）：乐观更新，请求失败回滚；PUT/DELETE 端点
   *  均幂等 200，并发重复加星由服务端唯一键兜底（no-op 不 500）。 */
  const toggleStar = (): void => {
    const next = !starred;
    setStarred(next);
    void api(`/files/${fileId}/star`, { method: next ? 'PUT' : 'DELETE' }).catch(() =>
      setStarred(!next),
    );
  };

  // —— 格式刷（M6 Task 7，企微对标，FR-EDT-016 提前）——

  /** ref + state 双轨写入（ref 同步可见，见 state 声明处注释）。 */
  const setPainterSync = (next: PainterMode | null): void => {
    painterRef.current = next;
    setPainter(next);
  };

  /** 从当前单选节点复制格式快照进模式态；无单选（空选区/多选/已删）toast 提示。 */
  const enterPainter = (sticky: boolean): void => {
    const selection = selectionRef.current;
    const single =
      selection && selection.selected.size === 1 ? [...selection.selected][0] : null;
    const snap = single && doc ? getNode(doc, single) : null;
    if (!single || !snap || snap.deleted) {
      showToast('请先选中要复制样式的节点');
      return;
    }
    setPainterSync({
      sourceId: single,
      style: { ...snap.style },
      sticky,
    }); // M7b-W2 #10：格式刷只刷样式，不复制标记/表情（需求方裁定）
  };

  /** 单击：未激活 = 复制快照进单发模式；已激活（单发/粘滞）= 退出（再点按钮退出）。 */
  const onPainterClick = (): void => {
    if (painterRef.current) {
      setPainterSync(null);
      return;
    }
    enterPainter(false);
  };

  /** 双击 = 粘滞（连续应用到逐个点击的节点）。双击序列里 click#1 进单发、click#2
   *  退出、dblclick 到达——统一以粘滞重进（快照同源同值，选择未变）。 */
  const onPainterDoubleClick = (): void => {
    const cur = painterRef.current;
    if (cur) {
      setPainterSync({ ...cur, sticky: true });
      return;
    }
    enterPainter(true);
  };

  /**
   * 应用格式到目标节点：单事务 ORIGIN_USER（setStyle 逐键 + setIcon 逐组——内层
   * withTransaction 嵌套复用外层事务，一次 Ctrl+Z 整体回滚）。格式整体复制语义：
   * 源有的键/组写入，目标有而源没有的键/组清除（writeStylePatch null 删键 /
   * setIcon null 删组）。自刷（源=目标）与未变更（快照与目标一致）均零写入——
   * 不给撤销栈留空项。单发模式应用后退出；粘滞保持。
   */
  const applyPainterTo = (targetId: string): void => {
    const mode = painterRef.current;
    if (!mode || readOnly) return;
    if (targetId !== mode.sourceId && doc) {
      const target = getNode(doc, targetId);
      if (target && !target.deleted) {
        const patch: Record<string, string | number | null> = {};
        for (const [attr, value] of Object.entries(mode.style)) patch[attr] = value;
        for (const attr of Object.keys(target.style)) {
          if (!(attr in mode.style)) patch[attr] = null;
        }
        if (Object.keys(patch).length > 0) {
          try {
            withTransaction(doc, ORIGIN_USER, () => {
              setStyle(doc, targetId, patch);
            });
            afterUserWrite();
          } catch (e) {
            showToast(e instanceof Error ? e.message : '格式应用失败');
            return;
          }
        }
      }
    }
    if (!mode.sticky) setPainterSync(null);
  };

  /** export_done 埋点（M4 Task 9 交付，M5 Task 4 收口到公共 track()：公共参数
   *  clientVersion/sessionId 随 payload 合并上报）。fire-and-forget：失败静默，
   *  遥测不干扰导出主流程。 */
  const postExportDone = (format: string, scale: number): void => {
    track('export_done', { format, scale }, fileId);
  };

  /** PNG/JPG 导出（M4 Task 9，FR-IO-003）：折叠处数 >0 先 confirm 提示自动展开
   *  （取消即中止），再走 image-export 链路（失败 toast，成功后上报埋点）。 */
  const runImageExport = (format: 'png' | 'jpg', scale: 1 | 2 | 3): void => {
    if (!doc || !meta) return;
    setExportOpen(false);
    const folded = countCollapsedWithChildren(doc);
    if (folded > 0 && !window.confirm(`检测到 ${folded} 处折叠，将自动展开后导出`)) return;
    void exportImage(doc, meta.title, { format, scale, transparent: exportTransparent })
      .then(() => postExportDone(format, scale))
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : '导出失败'));
  };

  /**
   * 适应画布。maxScale 可选（kimi 复验 P5）：传入即「只缩不放」——fit 算出的 scale
   * 超过 maxScale 就钳到 maxScale，平移仍按 computeFit 同式居中。背景：全新文档
   * 内容小，fit 一路放大到 MAX_SCALE=4 钳制上限（400%），root 巨大、子主题一步出
   * 屏；企微/XMind 新文档默认 100%。仅首帧装配传 1；工具栏「适应画布」不传，保持
   * 无钳制原行为。
   */
  const fitCanvas = (maxScale?: number): void => {
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const lay = layoutRef.current;
    if (!vp || !svgEl) return;
    const layout = lay ?? { nodes: [], width: 0, height: 0 };
    if (maxScale !== undefined) {
      const box = contentBounds(layout);
      const scale = Math.min(computeFit(box, svgEl.clientWidth, svgEl.clientHeight).scale, maxScale);
      // zoomTo 只设 scale 不动平移：按 computeFit 居中式在目标 scale 下补齐 tx/ty
      //（degenerate 空布局时同式退化为 scale=1、居中原点，与 vp.fit 一致）。
      vp.zoomTo(scale);
      vp.panBy(
        (svgEl.clientWidth - box.width * scale) / 2 - box.minX * scale - vp.tx,
        (svgEl.clientHeight - box.height * scale) / 2 - box.minY * scale - vp.ty,
      );
      syncZoom();
      return;
    }
    vp.fit(layout, { w: svgEl.clientWidth, h: svgEl.clientHeight });
    syncZoom();
  };

  const zoomBy = (factor: number): void => {
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!vp || !svgEl) return;
    vp.zoomAt(factor, svgEl.clientWidth / 2, svgEl.clientHeight / 2);
    syncZoom();
  };

  /** 快捷档位缩放（FR-EDT-027）：直接设 scale（zoomTo 内钳制到 10%~400%）。 */
  const zoomToPreset = (pct: number): void => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.zoomTo(pct / 100);
    syncZoom();
  };

  /** 页面级全屏切换（FR-EDT-028）：Esc 退出由浏览器原生处理。headless 下可能被拒，吞错。 */
  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
    } else {
      void document.documentElement.requestFullscreen().catch(() => undefined);
    }
  };

  /** 主选中节点：恰好单选返回该节点，否则以 root 为操作锚点。 */
  const primaryId = (): string => {
    const selection = selectionRef.current;
    if (selection && selection.selected.size === 1) {
      const [id] = selection.selected;
      return id;
    }
    return ROOT_NODE_ID;
  };

  /**
   * 节点平移进可视区（M7c-D2 需求方反馈2）：开编辑瞬间若节点未完整可见（高缩放
   * 越界/被右列收窄裁掉），按企微「节点就地变编辑态」语义先把节点 panBy 进视口
   * 再锚定编辑框——视口变换直写场景根（同滚轮平移通道），无需重排。完整可见时
   * no-op；单轴比视口还宽/高时直接居中该轴。
   */
  const panNodeIntoView = (nodeId: string): void => {
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!vp || !svgEl) return;
    const box = boxesRef.current.find((b) => b.id === nodeId);
    if (!box) return;
    const rect = svgEl.getBoundingClientRect();
    const p1 = vp.toScreen(box.x, box.y);
    const p2 = vp.toScreen(box.x + box.w, box.y + box.h);
    const MARGIN = 24; // 视口内边距：贴边也留呼吸空间
    const oversizeDelta = (a: number, b: number, size: number): number =>
      b - a >= size - 2 * MARGIN ? size / 2 - (a + b) / 2 : 0;
    const edgeDelta = (a: number, b: number, size: number): number => {
      if (a < MARGIN) return MARGIN - a;
      if (b > size - MARGIN) return size - MARGIN - b;
      return 0;
    };
    const dx = oversizeDelta(p1.x, p2.x, rect.width) || edgeDelta(p1.x, p2.x, rect.width);
    const dy = oversizeDelta(p1.y, p2.y, rect.height) || edgeDelta(p1.y, p2.y, rect.height);
    if (dx || dy) vp.panBy(dx, dy);
  };

  /**
   * 简洁模式切换（M7b 补课，mindgrid 账号级显示偏好「脑图简洁模式」）：写
   * localStorage（账号级显示偏好、不入文档数据——刷新/文件切换保持）+ ref/state
   * 同步 + 经装配桥接触发画布重排。视口不跳变：重排落定后把当前单选节点平移进
   * 可视区（panNodeIntoView 对完整可见节点 no-op，复用既有兜底）；rAF 注册序在
   * scheduleRerender 之后，同一帧先重渲染（boxesRef 更新）后平移。
   */
  const toggleCompact = (): void => {
    const next = !compactRef.current;
    compactRef.current = next;
    setCompact(next);
    try {
      localStorage.setItem(COMPACT_STORAGE_KEY, next ? '1' : '0');
    } catch {
      // storage 不可写（隐私模式等）：偏好降级为仅本次会话生效，不阻断切换
    }
    scheduleRerenderRef.current?.();
    requestAnimationFrame(() => {
      const selection = selectionRef.current;
      if (!selection) return;
      const id = [...selection.selected][0];
      if (id) panNodeIntoView(id);
    });
  };

  /**
   * anchorRect 视口钳制（M7c-D2 需求方反馈2 / kimi 400% 右缘裁切复核）：engine
   * texteditor 以 anchorRect-PAD 落 textarea（宽高取 max(anchor, 下限/行高)），高
   * 缩放下节点盒可宽过视口，编辑框右缘/下缘随节点整体越界被裁。此处按 engine 同
   * 一尺寸公式预估编辑框大小，把原点（还原 4px 补偿后）钳进可视区。60/20 为
   * engine texteditor 私有常量 MIN_WIDTH_PX/MIN_HEIGHT_PX 同值（未导出，注释锚定）。
   */
  const clampAnchorRect = (
    rect: { x: number; y: number; w: number; h: number },
    scale: number,
  ): { x: number; y: number; w: number; h: number } => {
    const fontSize = Math.max(1, Math.round(EDITOR_BASE_FONT_SIZE * scale));
    const w = Math.max(rect.w, 60);
    const h = Math.max(rect.h, 20, Math.ceil(fontSize * 1.4));
    const EDGE = 8; // 可视区内边距
    const minX = window.scrollX + EDGE;
    const maxX = Math.max(minX, window.scrollX + window.innerWidth - EDGE - w);
    const minY = window.scrollY + EDGE;
    const maxY = Math.max(minY, window.scrollY + window.innerHeight - EDGE - h);
    return {
      x: Math.min(Math.max(rect.x - 4, minX), maxX) + 4, // 4 = engine PAD_PX（锚点补偿）
      y: Math.min(Math.max(rect.y - 4, minY), maxY) + 4,
      w,
      h,
    };
  };

  /**
   * 编辑态视觉标记（2026-09-28 走查，编辑重影根治）：编辑覆盖层打开期间给节点 g
   * 挂 'gm-editing'（editor.css 据此隐掉节点底层文字，只留编辑框一层——「甲甲
   * 双影」），关闭即摘。覆盖层单例、场上至多一个编辑位：换节点编辑时（overlay
   * .open 对旧编辑器按 blur 语义先 commit）先摘旧 id 再挂新。两个入口（openNode
   * Editor / openPendingEditor）统一走本 helper，卸载兜底 overlay.close(false) 的
   * onCancel 亦经此摘除。
   */
  const setEditingClass = (nodeId: string | null): void => {
    const svgEl = svgRef.current;
    const prev = editingNodeIdRef.current;
    editingNodeIdRef.current = nodeId;
    if (!svgEl) return;
    if (prev && prev !== nodeId) {
      svgEl.querySelector(`g[data-node-id="${CSS.escape(prev)}"]`)?.classList.remove('gm-editing');
    }
    if (nodeId) {
      svgEl.querySelector(`g[data-node-id="${CSS.escape(nodeId)}"]`)?.classList.add('gm-editing');
    } else if (prev) {
      svgEl.querySelector(`g[data-node-id="${CSS.escape(prev)}"]`)?.classList.remove('gm-editing');
    }
  };

  /**
   * 打开既有节点编辑覆盖层（双击/后续交互入口）。2026-10-01 双框改版（需求方
   * 反馈「描述没有单独输入框」）：非简洁模式下编辑浮层带描述框（预填现有描述、
   * 空时占位「填写描述…」），标题 Enter/Tab 切描述框、描述框 Enter 提交两者。
   */
  const openNodeEditor = (id: string): void => {
    if (!doc) return;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const box = boxesRef.current.find((b) => b.id === id);
    if (!vp || !svgEl || !box) return;
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    // 显式编辑入口（F2/双击）消费掉惰性待编辑：否则 F2 编辑提交后，pending 校验
    // （单选恰为该节点）仍通过，下一个可打印字符会意外重开编辑框。
    pendingEditRef.current = null;
    pendingCancelRef.current = null;
    panNodeIntoView(id); // 节点未完整可见先平移进视口（M7c-D2），随后锚定随新视口
    const rect = svgEl.getBoundingClientRect();
    const p = vp.toScreen(box.x, box.y);
    overlay.open({
      anchorRect: clampAnchorRect(
        {
          x: rect.left + window.scrollX + p.x,
          y: rect.top + window.scrollY + p.y,
          w: box.w * vp.scale,
          h: box.h * vp.scale,
        },
        vp.scale,
      ),
      scale: vp.scale,
      value: snap.text,
      // 双框形态（非简洁模式）：描述预填 + 上限走 core 同值常量（引擎截断兜底）
      description: compactRef.current
        ? undefined
        : {
            value: snap.description ?? '',
            maxLength: MAX_DESCRIPTION_LENGTH,
            placeholder: '填写描述…',
            onTruncated: () =>
              showToast(`描述长度已达上限（最多 ${MAX_DESCRIPTION_LENGTH} 字），请精简后再保存`),
          },
      onCommit: (text, desc) => {
        setEditingClass(null);
        try {
          // 一次事务 setText+setDescription（组合原子操作包外层事务，撤销一笔）；
          // 两写各有同值守卫——描述未改/同值时零写入（core setDescription 内部消化）
          withTransaction(doc, ORIGIN_USER, () => {
            setText(doc, id, text, ORIGIN_USER);
            setDescription(doc, id, desc.trim(), ORIGIN_USER); // 空文本=清空（幂等）
          });
          afterUserWrite();
        } catch (e) {
          showToast(e instanceof Error ? e.message : '保存失败');
        }
      },
      onCancel: () => setEditingClass(null),
      onTruncated: () => showToast('节点文本长度已达上限'),
    });
    selectionRef.current?.selectOnly(id);
    setEditingClass(id);
  };

  /**
   * 新建节点（Tab/Enter/Shift+Tab/右键插入）：**惰性编辑**（2026-09-28 需求方
   * 走查，企微语义对齐）——按键立刻创建节点并选中，**不开编辑框**；默认文本
   * 「新主题」同事务写入，节点落位即可见有语义。等用户敲下第一个可打印字符时
   * 才由 keydown effect 补开编辑框（openPendingEditor），该字符/IME 组字直接落
   * 进编辑框。取消语义：Esc 直接回收（pendingCancelRef → removeIfAlive）；「新
   * 建后敲字又全删」的空提交同走回收（openPendingEditor onCommit）。撤销语义：
   * 建节点（含默认文本）一笔事务、敲字提交再一笔——一次 Ctrl+Z 撤回「新主题」、
   * 两次删节点（编辑器惯例；用例 4 断言「新节点文本消失」仍成立）。
   * via（M5 Task 4）：node_add 埋点的操作方式——创建即上报（节点确实加进了
   * 文档；取消路径回收节点但不回滚事件，注释口径）。
   */
  const openNewNodeEditor = (
    parentId: string,
    index: number | undefined,
    relation: 'child' | 'sibling' | 'parent',
    via: NodeVia = 'keyboard',
    nodeToOutdent?: string, // relation='parent' 时必填：被插入新父级的当前节点
    forceSide?: NodeSide, // Enter 同级（root 级 mindmap）同侧保持目标侧；缺省不覆写
  ): void => {
    if (addBlockedByQuota()) return; // 配额拦截（Tab 插子级/Enter 插同级/右键菜单共用本入口）
    if (!doc) return;
    // 立即建节点（ORIGIN_USER 可撤销；measure 的 minNodeWidth 下限保证可见），
    // 默认文本同事务写入——不落「空壳」，未敲字也有语义可读。
    // relation='parent'（M7b-K2）：Shift+Tab 语义——新节点插在 parent 的 index
    // 处后，立即把 nodeToOutdent（当前选中）换父到新节点下（P→N→C）。
    // forceSide（Enter 方向矩阵，2026-09-30 需求方）：root 级 mindmap 同级落点的
    // 同侧保持——addChild 自动定侧按「右列计数」给侧（≥3 右即 left），会与参照
    // 节点相反，故建后同事务内显式 setNodeSide 覆写（同值守卫幂等、嵌套事务复用
    // 外层，一次 Ctrl+Z 与建节点同撤）。仅 mindmap 消费侧别（logic/org 布局不读，
    // 不落 side 键）；参照节点无持久侧（旧文档）时 forceSide 缺省，自动定侧接管。
    let createdId = '';
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        createdId = addChild(doc, parentId, index === undefined ? {} : { index });
        setText(doc, createdId, '新主题', ORIGIN_USER);
        if (forceSide && parentId === ROOT_NODE_ID && getMeta(doc).structureType === 'mindmap') {
          setNodeSide(doc, createdId, forceSide);
        }
        if (relation === 'parent' && nodeToOutdent) moveNode(doc, nodeToOutdent, createdId);
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '新建失败');
      return;
    }
    afterUserWrite();
    track('node_add', { via, nodeCount: countAliveReachable(doc) }, fileId);
    selectionRef.current?.selectOnly(createdId);
    // 新建节点视口跟随（kimi 复验 P2）：惰性创建只 selectOnly 不平移，高缩放下新
    // 节点可整个落在视口外（实测 1440×900、400% 初始缩放连续 Tab 第 2/3 个节点
    // 可见 0%）。新建当帧盒子还没进 boxesRef（布局要等 update→scheduleRerender 的
    // rAF 重渲染），rAF 一帧后布局已落再平移；panNodeIntoView 对完整可见节点
    // no-op。不开编辑框，惰性语义不动。
    requestAnimationFrame(() => panNodeIntoView(createdId));
    // 回收闭包（自原 openOnNode 原样上提）：Esc/空提交时删掉新建节点；
    // relation='parent' 先把换父的原节点放回原位再删空新节点（同事务，见内注）。
    const removeIfAlive = (): void => {
      const snap = getNode(doc, createdId);
      if (snap && !snap.deleted) {
        try {
          // M7b-K2-blocker（kimi 复核发现）：relation='parent' 时原节点已换父到新节点下，
          // deleteNodes 级联墓碑会连原节点一起删（数据丢失）——取消路径先把原节点
          // 换回原父原位，再删空新节点（同事务）。
          withTransaction(doc, ORIGIN_USER, () => {
            if (relation === 'parent' && nodeToOutdent) {
              // 原位=新节点 N 在其父（=原父）children 中的 index 处；原节点还原到
              // N 的父下 N 原本的位置（不能取原节点的现父——那是 N 自身，会还原进 N）
              const np = getNode(doc, createdId);
              const restoreParent = np && !np.deleted ? np.parentId : parentId;
              const restoreIndex =
                restoreParent && restoreParent !== createdId
                  ? (getNode(doc, restoreParent)?.childIds.indexOf(createdId) ?? -1)
                  : -1;
              if (restoreParent && restoreIndex >= 0) {
                moveNode(doc, nodeToOutdent, restoreParent, restoreIndex);
              }
            }
            deleteNodes(doc, [createdId]);
          });
          afterUserWrite();
        } catch {
          // 尽力而为：删除失败仅残留一个空节点，可手动删除
        }
      }
      // 取消后选中态若仍停在已删节点，后续 Tab/Enter 会静默 no-op——恢复到父节点
      // （parent 关系恢复选中到原节点本身：它已被放回原位）
      selectionRef.current?.selectOnly(relation === 'parent' && nodeToOutdent ? nodeToOutdent : parentId);
    };
    // 惰性：不开编辑框，登记待编辑节点即返回。连续 Enter/Tab 基于 primaryId()
    // （=本节点）继续新建，pending 被新节点覆盖、旧节点保留「新主题」文本（企
    // 微同款）；Backspace/Delete 走 onDelete→handleDelete 删掉本节点（handle
    // Delete 成功后顺手清 pending，防悬空）。
    pendingEditRef.current = createdId;
    pendingCancelRef.current = removeIfAlive;
  };

  /**
   * 补开惰性待编辑节点（keydown effect 命中可打印字符时）：锚定装配仿 openNode
   * Editor（panNodeIntoView + 真实盒 + clampAnchorRect），差异在提交语义——
   * onCommit 空标题 → pendingCancelRef 回收（「新建后敲字又全删」→ 删节点，与
   * 旧「空提交=取消」语义一致；已键入的描述随节点一并废弃）；非空 → setText +
   * setDescription 同一笔事务（描述框留空= setDescription('') 同值守卫零写入）。
   * onCancel 不回收：取消时文本未变（有改动走 blur=commit 到不了 onCancel），保留
   * 「新主题」现状；回收闭包在关闭路径一律作废（提交后节点已是常驻节点，不可再
   * 被回收）。双框形态（非简洁模式）：描述框随编辑浮层一并打开，空时占位
   * 「填写描述…」（2026-10-01 需求方「描述单独输入框」）。
   *
   * **时序契约**：由 document keydown **同步**调用且不 preventDefault——overlay
   * .open 内部同步 appendChild+focus+selectAll，随后的浏览器默认文本插入/IME 组
   * 字才会落进 textarea（异步打开或拦截默认行为都会吞掉首字符）。
   * 返回是否真正打开：创建同帧内极速按键时布局盒子可能还没进 boxesRef——此时
   * 返回 false，keydown 侧保留 pending 待下一键重试（对齐旧实现的 rAF 重试语义）。
   */
  const openPendingEditor = (nodeId: string): boolean => {
    if (!doc) return false;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const box = boxesRef.current.find((b) => b.id === nodeId);
    if (!vp || !svgEl || !box) return false;
    const snap = getNode(doc, nodeId);
    if (!snap || snap.deleted) return false;
    panNodeIntoView(nodeId); // 新节点可能落在视口外/贴边，先平移进视口再锚定
    const rect = svgEl.getBoundingClientRect();
    const p = vp.toScreen(box.x, box.y);
    overlay.open({
      anchorRect: clampAnchorRect(
        {
          x: rect.left + window.scrollX + p.x,
          y: rect.top + window.scrollY + p.y,
          w: box.w * vp.scale,
          h: box.h * vp.scale,
        },
        vp.scale,
      ),
      scale: vp.scale,
      value: snap.text,
      // 双框形态（非简洁模式）：新建节点描述默认空串，占位「填写描述…」引导填写
      description: compactRef.current
        ? undefined
        : {
            value: snap.description ?? '',
            maxLength: MAX_DESCRIPTION_LENGTH,
            placeholder: '填写描述…',
            onTruncated: () =>
              showToast(`描述长度已达上限（最多 ${MAX_DESCRIPTION_LENGTH} 字），请精简后再保存`),
          },
      onCommit: (text, desc) => {
        setEditingClass(null);
        const cancel = pendingCancelRef.current; // 回收闭包一次性：无论提交为何都作废
        pendingCancelRef.current = null;
        if (!doc) return;
        if (text.trim() === '') {
          cancel?.(); // 空标题提交 = 回收新建节点（敲了字又全删；描述随节点废弃）
          return;
        }
        try {
          // 一次事务 setText+setDescription（撤销一笔）；描述同值/空值零写入由
          // core setDescription 同值守卫消化
          withTransaction(doc, ORIGIN_USER, () => {
            setText(doc, nodeId, text, ORIGIN_USER);
            setDescription(doc, nodeId, desc.trim(), ORIGIN_USER);
          });
          afterUserWrite();
        } catch (e) {
          showToast(e instanceof Error ? e.message : '保存失败');
        }
      },
      onCancel: () => {
        // 取消不回收：文本没变（保留「新主题」），仅作废回收闭包
        pendingCancelRef.current = null;
        setEditingClass(null);
      },
      onTruncated: () => showToast('节点文本长度已达上限'),
    });
    selectionRef.current?.selectOnly(nodeId);
    setEditingClass(nodeId);
    return true;
  };

  // —— 键盘直入编辑监听（惰性编辑补开 + 选中即可编辑，共用一组让路纪律）——
  //
  // 惰性编辑补开（Tab/Enter 新建后的首个可打印字符进入编辑，企微语义）：编辑
  // 覆盖层已开、焦点在输入控件、表格视图不触发；且当前单选必须恰为 pending 节点。
  //
  // 选中即可编辑（2026-09-30 需求方走查：「鼠标选中某主题后应该可以直接编辑，或
  // 敲击空格全选主题内容」）：恰单选一个存活节点、未在编辑、焦点不在输入控件、
  // 非表格视图时——可打印字符直入编辑（不 preventDefault，键入字符替换全选内容，
  // 与惰性新建同机制）；空格进编辑并全选（preventDefault，不落空格）。pending
  // 优先：新建待编辑态先消费（见冒泡层/捕获层各自分支）。
  //
  // 空格同时**全量接管**（捕获层 stopPropagation）：Viewport 的空格平移跟踪挂
  // window 冒泡（engine viewport.ts attach 期 keydown/keyup），document 捕获层断
  // 传播后 spacePressed 不再置位——「空格按住+左拖平移」手势退役，画布平移只剩
  // 中键拖拽（中键平移不受影响）；输入控件/编辑框内的空格只断传播、不 prevent
  // Default，照常落字。捕获层不做可打印字符处理：`,` 快速卡等同层冒泡处理器先
  // 注册先行、其 preventDefault 的按键直入编辑须让路，而捕获层拿不到 default
  // Prevented 终态（冒泡尚未走完）。
  //
  // 依赖含 doc：文件切换即重挂，并把旧 doc 的 pending（含回收闭包）作废。只读
  // （移动端）不装配。
  useEffect(() => {
    if (readOnly || !doc) return;
    const d = doc; // 门内已收窄非空：监听闭包统一用局部别名
    pendingEditRef.current = null;
    pendingCancelRef.current = null;

    // 捕获层——空格通道（含空格平移手势退役）。
    const onSpaceKeyDownCapture = (e: KeyboardEvent): void => {
      if (resolveDirectEditKey(e) !== 'space') return;
      // 先断传播再论动作：Viewport 挂 window 冒泡的空格跟踪收不到本事件（手势
      // 退役）；不在此 preventDefault——输入控件/编辑框内的空格照常落字。
      e.stopPropagation();
      if (e.defaultPrevented) return; // 他处已消费的空格不再进编辑
      if (overlay.isOpen || isEditableTarget(e.target)) return;
      if (viewRef.current === 'table') return;
      const selection = selectionRef.current;
      if (!selection || selection.selected.size !== 1) return;
      const nodeId = [...selection.selected][0];
      const pending = pendingEditRef.current;
      if (pending && pending === nodeId) {
        // pending 优先：待编辑新建节点的空格等同其首个可打印字符——同步补开待
        // 编辑框且**不 preventDefault**（空格替换全选的「新主题」，原语义不变）。
        // 捕获层已断传播，冒泡层收不到空格，故须在此处理；盒子未就绪（创建同帧
        // 极速按键）保留待编辑下一键重试，空格此时被吞（与旧冒泡路径同）。
        if (openPendingEditor(pending)) {
          pendingEditRef.current = null;
        }
        return;
      }
      if (pending) {
        // 选中已不是 pending 节点（Tab 后点了别处）：待编辑作废（与冒泡层校验同
        // 口径，不回收节点），落入下方既有节点直入编辑——空格对新选中节点仍生效。
        pendingEditRef.current = null;
        pendingCancelRef.current = null;
      }
      const snap = getNode(d, nodeId);
      if (!snap || snap.deleted) return;
      e.preventDefault(); // 不插空格：编辑框打开即全选（overlay 自带），覆盖式输入
      openNodeEditor(nodeId);
    };

    // 冒泡层——选中即可编辑（可打印字符直入，空格归捕获层通道）。
    const onDirectEditPrintable = (e: KeyboardEvent): void => {
      if (resolveDirectEditKey(e) !== 'printable') return;
      if (e.defaultPrevented) return; // `,` 快速卡等同层处理器已消费的按键让路
      if (overlay.isOpen || isEditableTarget(e.target)) return;
      if (viewRef.current === 'table') return;
      const selection = selectionRef.current;
      if (!selection || selection.selected.size !== 1) return;
      const nodeId = [...selection.selected][0];
      const snap = getNode(d, nodeId);
      if (!snap || snap.deleted) return;
      openNodeEditor(nodeId); // 不 preventDefault：键入字符替换全选内容（时序契约同 openPendingEditor）
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      const pending = pendingEditRef.current;
      if (!pending) {
        onDirectEditPrintable(e);
        return;
      }
      const selection = selectionRef.current;
      // 校验失败（选中已不是 pending 节点：被删/被切换/多选）→ 待编辑作废
      if (!selection || selection.selected.size !== 1 || !selection.selected.has(pending)) {
        pendingEditRef.current = null;
        pendingCancelRef.current = null;
        return;
      }
      if (e.key === 'Escape') {
        // Esc 取消创建：回收空节点（parent 关系连带还原 nodeToOutdent）
        e.preventDefault();
        const cancel = pendingCancelRef.current;
        pendingEditRef.current = null;
        pendingCancelRef.current = null;
        cancel?.();
        return;
      }
      // 可打印字符 → 同步补开编辑框且**不 preventDefault**（overlay.open 同步
      // focus+selectAll 后，浏览器默认插入/IME 组字落进 textarea——见 openPending
      // Editor 时序契约）。方向键/功能键等其余按键不动 pending（保持待编辑态）；
      // 空格由捕获层通道处理（含 pending 分支），到不了本层。
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !overlay.isOpen &&
        !isEditableTarget(e.target) &&
        viewRef.current !== 'table'
      ) {
        // 打开成功才消费 pending（回收闭包留待提交路径用）；盒子未就绪（创建同
        // 帧极速按键）保留待编辑，下一键重试
        if (openPendingEditor(pending)) {
          pendingEditRef.current = null;
        }
      }
    };
    document.addEventListener('keydown', onSpaceKeyDownCapture, true);
    document.addEventListener('keydown', onKeyDown, false);
    return () => {
      document.removeEventListener('keydown', onSpaceKeyDownCapture, true);
      document.removeEventListener('keydown', onKeyDown, false);
    };
    // openPendingEditor / openNodeEditor 每渲染重建但只读 ref/closure（同 locateNode
    // 通知深链裁定），不入依赖。
  }, [readOnly, doc]);

  /**
   * Enter/Shift+Enter 新建同级。顺时针落位（需求方 2026-10-09，替代 2026-09-30 方向
   * 矩阵的左列分支）：
   * - root 上 Enter/Tab 降级新建子级（现状不变）：addChild 按右列配额自动定侧——右列
   *   未满 3 append 落右列底部，满后 append 落左列顶部（布局左列视觉反序：文档序末位
   *   = 视觉最高位，往左上角生长，围绕中心顺时针）。
   * - root 上 Shift+Enter（逆时针镜像）：左列未满 3 落左列、否则右列；插到该列首个
   *   同侧子级文档位之前（左列=视觉列底自上往下长、右列=视觉列顶自下往上长——与
   *   Enter 完全反向）。logic/org（单侧/无侧结构）维持降级现状。
   * - 二级主题（parent===root，mindmap）：索引全层级统一——Enter=文档序后插、
   *   Shift+Enter=前插；布局左列视觉反序下天然涌现「右列 Enter 向下/左列 Enter 向上」
   *   （顺时针），Shift+Enter 全部反向。同侧保持：参照节点持久 side 经 forceSide 下沉
   *   给 openNewNodeEditor（addChild 按计数自动定侧可能给相反侧）。
   * - logic（全右单侧）与 org、更深层级维持现状（Enter 下方）。
   */
  const handleEnter = (reverse = false): void => {
    if (!doc) return;
    const current = primaryId();
    const snap = getNode(doc, current);
    if (!snap || snap.deleted) return;
    if (current === ROOT_NODE_ID) {
      if (reverse && getMeta(doc).structureType === 'mindmap') {
        // 逆时针：左列未满配额落左列、否则右列；插到该列首个同侧子级文档位之前。
        const rootSnap = getNode(doc, ROOT_NODE_ID);
        const kids = rootSnap?.childIds ?? [];
        // 有效侧 = 持久 side ?? 文档序计数兜底（index<3 右 / ≥3 左）——与 engine
        // assignMindmapSides / core countRightSideRootChildren 的兜底同式（配额常量
        // 同值 3，此处为其镜像用法，改动需同步）。
        const sideOfKid = (cid: string, i: number): NodeSide => {
          const s = getNode(doc, cid)?.side;
          if (s === 'left' || s === 'right') return s;
          return i < 3 ? 'right' : 'left';
        };
        const leftCount = kids.filter((cid, i) => sideOfKid(cid, i) === 'left').length;
        const side: NodeSide = leftCount < 3 ? 'left' : 'right';
        const firstSameSide = kids.findIndex((cid, i) => sideOfKid(cid, i) === side);
        openNewNodeEditor(
          ROOT_NODE_ID,
          firstSameSide === -1 ? kids.length : firstSameSide,
          'child',
          'keyboard',
          undefined,
          side,
        );
      } else {
        // root 无同级：降级为新建子级（顺时针/单侧结构——addChild 自动定侧）
        openNewNodeEditor(ROOT_NODE_ID, undefined, 'child');
      }
      return;
    }
    const parent = getNode(doc, snap.parentId);
    if (!parent || parent.deleted) return;
    const currentIdx = parent.childIds.indexOf(current);
    // 二级主题（root 级 mindmap）同侧保持：参照节点持久 side（NodeSnapshot 读侧已
    // 防御非法值）下沉 forceSide；无持久侧不覆写——新节点由 addChild 自动定侧接管。
    const forceSide: NodeSide | undefined =
      parent.id === ROOT_NODE_ID &&
      getMeta(doc).structureType === 'mindmap' &&
      (snap.side === 'left' || snap.side === 'right')
        ? snap.side
        : undefined;
    // 索引公式全层级统一：Enter=文档序后插（视觉下方）、Shift+Enter=前插（视觉上方）；
    // root 级左列因布局视觉反序自然涌现「Enter 向上」（顺时针）——旧按侧分支的
    // upward 矩阵随共享单带退役。
    const index = reverse ? currentIdx : currentIdx + 1;
    openNewNodeEditor(parent.id, index, 'sibling', 'keyboard', undefined, forceSide);
  };

  const handleTab = (shift: boolean): void => {
    if (!doc) return;
    const current = primaryId();
    const snap = getNode(doc, current);
    if (!snap || snap.deleted) return;
    if (!shift) {
      openNewNodeEditor(current, undefined, 'child');
      return;
    }
    if (current === ROOT_NODE_ID) {
      showToast('中心主题不支持添加父主题');
      return;
    }
    const parent = getNode(doc, snap.parentId);
    if (!parent || parent.deleted) return;
    // 父为 root（一级主题）与其余层级同一公式：新节点插在 parent children 中
    // 当前节点原 index 处（root 受保护只体现在「root 不可换父」，此处合法）。
    // M7b-K2：与 子主题/同级主题 对齐——建节点即选中（惰性编辑：敲字才进编辑，
    // Esc/空提交回收），不再走无反馈的 createOutdent（kimi K2 走查遗留裁定）。
    openNewNodeEditor(
      parent.id,
      parent.childIds.indexOf(current),
      'parent',
      'keyboard',
      current,
    );
  };

  /** 删除选中（键盘 Delete/Backspace 与右键菜单共用；via 为 node_delete 埋点的
   *  操作方式——M5 Task 4）。 */
  const handleDelete = (via: NodeVia = 'keyboard'): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected];
    if (ids.length === 0) return;
    try {
      deleteNodes(doc, ids, ORIGIN_USER); // root 含其中时降级为清空子级
      afterUserWrite();
      // 惰性待编辑节点可能就在删除集里：回收闭包随之作废（keydown 侧的「选中恰
      // 为 pending 节点」校验兜底，此处显式清更干净、不留悬空闭包）
      pendingEditRef.current = null;
      pendingCancelRef.current = null;
      track('node_delete', { via, nodeCount: countAliveReachable(doc) }, fileId);
      // 配额拦截的解除通道（M1b 终审裁定）：删除节点即解除新增拦截。若删除后仍
      // 超限，服务端边缘触发器在回落限内前不会重复广播（advisory 残余窗口，登记
      // docs/m2-entry-checklist.md §7.6）。
      quotaBlockedRef.current = nextQuotaBlock(quotaBlockedRef.current, { type: 'deleted' });
      selection.selectOnly(ROOT_NODE_ID);
      fitPendingRef.current = true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleSelectAll = (): void => {
    if (!doc) return;
    selectionRef.current?.set(subtreeIds(doc, ROOT_NODE_ID));
  };

  const handleToggleCollapse = (): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection || selection.selected.size === 0) return;
    try {
      for (const id of selection.selected) toggleCollapse(doc, id); // system origin，不进撤销栈
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleNavigate = (direction: Direction): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const structure = getMeta(doc).structureType;
    const next = navigateGeometry(primaryId(), direction, boxesRef.current, structure);
    if (next) selection.selectOnly(next);
  };

  const handleSiblingEnd = (which: 'first' | 'last'): void => {
    const selection = selectionRef.current;
    if (!selection) return;
    const next = siblingEnd(primaryId(), boxesRef.current, which);
    if (next) selection.selectOnly(next);
  };

  // —— 概要（M6 Task 6，企微对标）：同父连续兄弟片段的 bracket 归纳 ——

  /** 选区可概要化判定（≥2 选中、同父、按父 childIds 连续，core 同一套校验）。 */
  const summarySegmentFromSelection = (d: Y.Doc): string[] | null => {
    const selection = selectionRef.current;
    if (!selection || selection.selected.size < 2) return null;
    const ids = [...selection.selected].filter((id) => id !== ROOT_NODE_ID);
    return validSummarySegment(d, ids);
  };

  /**
   * 打开概要标签行内编辑器：输入框锚定标签/chip 位置（svg 相对坐标 → .editor-canvas
   * 内绝对定位）。锚点优先取布局产出的概要盒（既有概要）：竖向花括号形态（企微式，
   * 2026-10-01 反馈任务 1）锚在 chip 中心、旧横括线形态锚在横线下 label 基线处；
   * 创建流尚无盒时按 engine 同式几何预置（括号形态 = 外缘+6 脊线 +10 尖端 +6 chip
   * 缘 + chip 半宽；括线形态 = 片段盒下方 12px + label 基线 14px、每侧外扩 8px）。
   */
  const openSummaryEditor = (
    summaryId: string | null,
    nodeIds: string[],
    label: string,
    anchor?: SummaryBox,
  ): void => {
    const vp = viewportRef.current;
    if (!vp) return;
    const box = anchor ?? (layoutRef.current?.summaries ?? []).find((s) => s.id === summaryId);
    let sceneX: number;
    let sceneY: number;
    const members = nodeIds
      .map((id) => boxesRef.current.find((b) => b.id === id))
      .filter((b): b is NodeBox => b !== undefined);
    if (box) {
      if (box.brace !== undefined) {
        // 竖括号形态：chip 中心（文本锚 labelX ± labelW/2，垂直居中于成员带 h）。
        // chip 内边距对中心无贡献，不参与计算。
        const half = (box.labelW ?? 0) / 2;
        sceneX = box.x + (box.labelX ?? 0) + (box.labelAnchor === 'end' ? -half : half);
        sceneY = box.y + (box.h ?? 0) / 2;
      } else {
        sceneX = box.x + box.w / 2;
        sceneY = box.y + 14;
      }
    } else {
      if (members.length === 0) return;
      const sides = new Set(members.map((b) => b.side));
      if (sides.size === 1 && (sides.has('right') || sides.has('left'))) {
        // 创建流预置（竖括号形态，与 engine 常量同式：V_EXTEND=6 / BRACE_GAP=6 /
        // BRACE_DEPTH=10 / LABEL_GAP_OUT=6；文本宽按 label 逐字符 12px 近似——仅
        // 影响初始锚点，布局盒出现后再编辑即取盒锚点）。
        const side = sides.values().next().value as 'left' | 'right';
        const top = Math.min(...members.map((b) => b.y)) - 6;
        const bottom = Math.max(...members.map((b) => b.y + b.h)) + 6;
        const chipHalf = (label.length * 12 + 16) / 2; // chip 全宽 = labelW + 2×8
        const outer =
          side === 'right'
            ? Math.max(...members.map((b) => b.x + b.w))
            : Math.min(...members.map((b) => b.x));
        const tip = outer + (side === 'right' ? 6 + 10 : -6 - 10);
        sceneX = tip + (side === 'right' ? 6 + chipHalf : -6 - chipHalf);
        sceneY = (top + bottom) / 2;
      } else {
        // 跨侧/org（旧横括线形态）：与 engine SUMMARY_OUT_X=8、SUMMARY_GAP_Y=12
        // + label 基线 14 同式。
        const minX = Math.min(...members.map((b) => b.x));
        const maxR = Math.max(...members.map((b) => b.x + b.w));
        const maxB = Math.max(...members.map((b) => b.y + b.h));
        sceneX = minX - 8 + (maxR - minX + 16) / 2;
        sceneY = maxB + 12 + 14;
      }
    }
    const p = vp.toScreen(sceneX, sceneY);
    summaryEditCancelled.current = false;
    setSummaryEdit({ summaryId, nodeIds, label, left: p.x, top: p.y });
  };

  /** 提交（commit=true）/取消概要标签编辑：未变更零写入（不给撤销栈留空项）。 */
  const commitSummaryEdit = (commit: boolean): void => {
    if (summaryEditCancelled.current && !commit) {
      summaryEditCancelled.current = false;
      return; // Esc 已取消：随后的 blur 不再提交
    }
    const ed = summaryEdit;
    if (!ed) return;
    setSummaryEdit(null);
    if (!commit || !doc) return;
    if (ed.summaryId) {
      const cur = listSummaries(doc).find((s) => s.id === ed.summaryId);
      if (cur && cur.label === ed.label && cur.nodeIds.length === ed.nodeIds.length) return;
    }
    try {
      setSummary(doc, ed.nodeIds, ed.label, ORIGIN_USER);
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '概要保存失败');
    }
  };

  /** 右键菜单「添加概要」：选区校验失败给原因+下一步（NFR-USE-005）；成功建默认
   *  标签「概要」并立即进入行内编辑（企微同款创建流）。 */
  const addSummaryFromSelection = (): void => {
    if (!doc) return;
    const seg = summarySegmentFromSelection(doc);
    if (seg === null || seg.length < 2) {
      showToast('概要需选择同一父节点下的连续节点，请调整选区后重试');
      return;
    }
    try {
      const sid = setSummary(doc, seg, '概要', ORIGIN_USER);
      afterUserWrite();
      openSummaryEditor(sid, seg, '概要');
    } catch (e) {
      showToast(e instanceof Error ? e.message : '概要创建失败');
    }
  };

  // —— 剪贴板（T10 交付面装配；Task 15 起图片随粘贴 remap，FR-EDT-010 收尾） ——

  /**
   * 图片 key 重映射（FR-EDT-010「图片随迁重传」）：跨文件粘贴时把旧 key 复制为
   * 当前文件存储下的新对象（POST /api/files/:fileId/images/copy）。同文件粘贴
   * （key 已属当前文件前缀）直接沿用原 key——裁决：前缀短路，避免同文件粘贴
   * 令存储翻倍；跨文件才产生新副本，符合 PRD「重新上传至目标文档存储」语义。
   */
  const remapImageKey = (oldKey: string): Promise<string> => {
    if (oldKey.startsWith(`files/${fileId}/`)) return Promise.resolve(oldKey);
    return api<{ key: string }>(`/files/${fileId}/images/copy`, {
      method: 'POST',
      body: { sourceKey: oldKey },
    }).then((r) => r.key);
  };

  const handleCopy = async (): Promise<void> => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected].filter((id) => id !== ROOT_NODE_ID);
    if (ids.length === 0) return;
    try {
      await writeToSystemClipboard(copyNodes(readerOf(doc), ids));
    } catch (e) {
      showToast(clipboardErrorMessage(e));
    }
  };

  /** 剪切 = 复制 + 删除（cutNodes 复合）；删除侧此前绕过 handleDelete——评审修复轮
   *  Important #2：补记 node_delete（via 区分键盘 Ctrl+X / 右键菜单），保证删除事件流
   *  与粘贴回来时的 node_add(via=paste) 对称。 */
  const handleCut = async (via: NodeVia = 'keyboard'): Promise<void> => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected].filter((id) => id !== ROOT_NODE_ID);
    if (ids.length === 0) return;
    try {
      writeToSystemClipboard(
        cutNodes(handleOf(doc), ids, (deleteIds) => {
          if (deleteIds.length === 0) return; // 空删集不上报（防御：上游已滤空）
          deleteNodes(doc, deleteIds, ORIGIN_USER);
          track('node_delete', { via, nodeCount: countAliveReachable(doc) }, fileId);
          afterUserWrite();
        }),
      );
      selection.selectOnly(ROOT_NODE_ID);
    } catch (e) {
      showToast(clipboardErrorMessage(e));
    }
  };

  const handlePaste = async (): Promise<void> => {
    if (!doc) return;
    if (addBlockedByQuota()) return; // 粘贴会新增节点，同受配额拦截
    const selection = selectionRef.current;
    if (!selection) return;
    // FR-EDT-009（PRD 原文「粘贴目标为当前选中节点的子级」）：单选 → 粘贴为该节点
    // 子级（追加其 children 末尾）；无选中/多选 → root 末尾。
    let parentId = ROOT_NODE_ID;
    const sel = [...selection.selected];
    if (sel.length === 1) {
      const snap = getNode(doc, sel[0]);
      if (snap && !snap.deleted) parentId = snap.id;
    }
    try {
      const clip = await readFromSystemClipboard();
      const idx = getNode(doc, parentId)?.childIds.length ?? 0;
      if (clip.internal) {
        await pasteNodes(handleOf(doc), parentId, idx, clip.internal, undefined, remapImageKey);
        fitPendingRef.current = true;
      } else if (clip.text !== null && clip.text.trim() !== '') {
        pasteText(handleOf(doc), parentId, idx, clip.text);
        fitPendingRef.current = true;
      } else {
        return; // 无可粘贴内容：无操作
      }
      afterUserWrite();
      // node_add 埋点（M5 Task 4）：一次粘贴动作记一行（via=paste；多节点不逐个拆行）
      track('node_add', { via: 'paste', nodeCount: countAliveReachable(doc) }, fileId);
    } catch (e) {
      showToast(clipboardErrorMessage(e));
    }
  };

  // —— 编辑态画布粘贴截图（FR-EDT-020）：图片文件直接上传并插入选中节点 ——

  const insertPastedImage = async (file: File): Promise<void> => {
    if (!doc) return;
    if (file.size > MAX_IMAGE_BYTES) {
      showToast('图片大小超出 10MB 限制，请压缩后重试');
      return;
    }
    try {
      const { w: naturalW, h: naturalH, url } = await readImageSize(file);
      try {
        const { key } = await uploadImage(fileId, file);
        const { w, h } = clampImageSize(naturalW, naturalH);
        // 插入目标：主选中节点（无选中/多选时 primaryId 降级为 root）
        setImage(doc, primaryId(), { key, w, h }, ORIGIN_USER);
        afterUserWrite();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '图片插入失败');
    }
  };

  // —— 画布指针交互（点击选择 / 框选 / 徽标折叠 / 双击编辑） ——

  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (justDraggedRef.current) return; // 拖拽释放后浏览器合成的 click：忽略（carry-in 裁决）
    const selection = selectionRef.current;
    if (!doc || !selection) return;
    const target = e.target as Element;
    // FR-EDT-019：点击链接角标 → 新标签页打开（先于折叠徽标/节点选择处理，
    // 打开后直接 return，不触发选中切换）。href 服务端已白名单校验，此处
    // 仍防御性复查 http/https；noopener 隔离 opener。
    if (target.closest('.gm-link-badge')) {
      const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
      const href = nodeId ? getNode(doc, nodeId)?.href : '';
      if (href && /^https?:\/\//i.test(href)) {
        window.open(href, '_blank', 'noopener');
      }
      return;
    }
    // 评论角标（FR-CMT-002）：点击 → 评论面板过滤到该节点线程；先于节点选择
    // 处理并直接 return——不触发选中/反选（与链接角标同一「让位」纪律）。
    if (target.closest('.gm-comment-badge')) {
      const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
      if (nodeId) setCommentFilter(nodeId);
      return;
    }
    // 标记徽章（M7b-W3 #4 点击换组）：点击 → 该组迷你选盘浮层；先于折叠徽标/
    // 节点选择处理并直接 return——不触发选中/反选/折叠（角标家族同一让位纪律；
    // 节点拖拽侧已由 engine drag 排除 data-marker-group 候选）。只读不弹（写路径）。
    const markerBadge = target.closest('.gm-marker-badge[data-marker-group]');
    if (markerBadge && !readOnly) {
      const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
      const group = markerBadge.getAttribute('data-marker-group');
      if (nodeId && group && ICON_GROUPS.includes(group as IconGroup)) {
        setContextMenu(null);
        // 再点同组徽章 = toggle 收盘（kimi 复验 P3）：外点关闭已豁免徽章（见选盘
        // effect），此处仍无条件重开就会闪关重弹关不掉；换组/换节点才重开重锚。
        if (markerPicker && markerPicker.nodeId === nodeId && markerPicker.group === group) {
          setMarkerPicker(null);
          return;
        }
        setMarkerPicker({ nodeId, group: group as IconGroup, x: e.clientX, y: e.clientY });
        return;
      }
    }
    const badge = target.closest('[data-for-id]');
    if (badge) {
      const id = badge.getAttribute('data-for-id');
      if (id) {
        try {
          toggleCollapse(doc, id);
        } catch (err) {
          showToast(err instanceof Error ? err.message : '操作失败');
        }
      }
      return;
    }
    // 概要 bracket（M6 Task 6）：点标签/括弧 → 行内编辑该概要标签（先于节点选择与
    // 空白清空——bracket 命中不改变既有选区）
    const sumG = target.closest('[data-summary-id]');
    if (sumG) {
      const sid = sumG.getAttribute('data-summary-id');
      const s = sid ? listSummaries(doc).find((v) => v.id === sid) : undefined;
      if (s) openSummaryEditor(s.id, s.nodeIds, s.label);
      return;
    }
    const g = target.closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (!id) {
      // 空白点击清空选择（M6 Task 2 企微对标，格式面板随选中联动配套）：修饰键
      // （Shift/Ctrl/Cmd）空白点击不清空（加/减选语义占位）；框选/中键平移拖拽
      // 释放后的合成 click 以位移 >4px 排除（与节点拖拽 justDraggedRef
      // 同一「拖拽不算点击」纪律）。
      const press = pointerPressRef.current;
      const moved = press ? Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4 : false;
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !moved) selection.clear();
      return;
    }
    // 格式刷（M6 Task 7）：模式激活时节点点击 = 应用格式并拦截（不让位给选中/
    // 加减选——粘滞保持激活，单发应用后退出）。角标/折叠徽标/概要等先行分支不受
    // 影响（各自 return 早于此处）。
    if (painterRef.current) {
      applyPainterTo(id);
      return;
    }
    // FR-EDT-008：Ctrl/Cmd+点击 = 加/减选；Shift+点击无操作（加选占位；M7b-W3 起
    // 框选 = 无修饰左键拖拽，不再依赖 Shift）
    if (e.shiftKey) return;
    if (e.ctrlKey || e.metaKey) {
      selection.toggle(id);
      return;
    }
    selection.selectOnly(id);
  };

  /**
   * 空白左键按下 → 引擎 beginMarquee（scene 坐标）+ 起画橡皮筋（M7b-W3 #5 改道：
   * 需求方裁定「鼠标按住滑动直接框选」——原 Shift+左拖改为**无修饰左拖**；平移
   * 曾改道空格+左拖 / 鼠标中键，2026-09-30 空格收回进编辑后平移只剩中键拖拽）。
   */
  const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    // 画布左键按下（空白/节点）即提交编辑器（2026-09-28 走查：空白路径下方的
    // preventDefault 会抑制 textarea 的 blur，编辑框此前关不掉）。close(true) 走
    // onCommit→setText，无变化提交由 core setText 同值守卫消化（空转零写入）。
    if (overlay.isOpen) overlay.close(true);
    pointerPressRef.current = { x: e.clientX, y: e.clientY }; // 空白点击位移判定（M6 Task 2）
    // 修饰键组合不进框选（Ctrl/Cmd=加减选、Shift=加选占位）；spacePressed 让位
    // 判定保留为防御：空格已收回进编辑（键盘直入编辑监听捕获层断掉 Viewport 的
    // 空格跟踪），spaceDown 仅在焦点处于输入控件等未拦路径残留——残留态下仍让位
    // 给 Viewport 平移，避免框选与平移叠加。
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (viewportRef.current?.spacePressed) return;
    const selection = selectionRef.current;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!selection || !vp || !svgEl) return;
    const target = e.target as Element;
    if (
      target.closest('[data-node-id]') ||
      target.closest('[data-for-id]') ||
      target.closest('[data-summary-id]')
    ) {
      return; // 概要 bracket 上起拖不进框选（M6 T6）
    }
    e.preventDefault(); // 抑制拖拽选中文本等浏览器默认行为
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    selection.beginMarquee(scene.x, scene.y);
    const svgBox = svgEl.getBoundingClientRect();
    marqueeAnchorScreenRef.current = { x: e.clientX - svgBox.left, y: e.clientY - svgBox.top };
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'gm-marquee');
    svgEl.appendChild(rect);
    marqueeRectRef.current = rect;
    if (typeof svgEl.setPointerCapture === 'function') {
      try {
        svgEl.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 */
      }
    }
  };

  const onSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const selection = selectionRef.current;
    const vp = viewportRef.current;
    if (!selection || !selection.isMarquee || !vp) return;
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    selection.updateMarquee(scene.x, scene.y);
    const rect = marqueeRectRef.current;
    const svgEl = svgRef.current;
    if (rect && svgEl) {
      const svgBox = svgEl.getBoundingClientRect();
      const cx = e.clientX - svgBox.left;
      const cy = e.clientY - svgBox.top;
      const a = marqueeAnchorScreenRef.current;
      rect.setAttribute('x', String(Math.min(a.x, cx)));
      rect.setAttribute('y', String(Math.min(a.y, cy)));
      rect.setAttribute('width', String(Math.abs(cx - a.x)));
      rect.setAttribute('height', String(Math.abs(cy - a.y)));
    }
  };

  /** 结束框选：相交入选、空结果清空（PRD 框选语义），橡皮筋随手移除。 */
  const onSvgPointerUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const selection = selectionRef.current;
    if (!selection || !selection.isMarquee) return;
    selection.endMarquee(boxesRef.current);
    marqueeRectRef.current?.remove();
    marqueeRectRef.current = null;
    const svgEl = svgRef.current;
    if (svgEl && typeof svgEl.releasePointerCapture === 'function') {
      try {
        svgEl.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放可忽略 */
      }
    }
  };

  const onSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (justDraggedRef.current) return;
    if (readOnly) return; // 移动端只读：双击（双触）不进编辑（OPEN-T-005）
    const g = (e.target as Element).closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (id) openNodeEditor(id);
  };

  // —— 右键菜单（Task 12）：动作复用与键盘相同的 core/engine 处理器 ——

  const onSvgContextMenu = (e: React.MouseEvent<SVGSVGElement>): void => {
    e.preventDefault();
    if (justDraggedRef.current) return;
    if (readOnly) return; // 移动端只读：不弹右键菜单（长按 contextmenu 同拦）
    const target = e.target as Element;
    // 概要 bracket（M6 Task 6）：右键 → 概要菜单（删除概要），与节点菜单互斥
    const sumG = target.closest('[data-summary-id]');
    if (sumG) {
      const sid = sumG.getAttribute('data-summary-id');
      if (sid) setContextMenu({ x: e.clientX, y: e.clientY, summaryId: sid });
      return;
    }
    const g = target.closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (!id || !doc) {
      setContextMenu(null);
      return;
    }
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    // 多选保持（M6 T6）：右键命中成员之一时不折叠选区——「添加概要」依赖多选片段
    const sel = selectionRef.current;
    if (!(sel && sel.selected.size > 1 && sel.selected.has(id))) {
      selectionRef.current?.selectOnly(id);
    }
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: id });
  };

  const runMenuAction = (action: string): void => {
    const menu = contextMenu;
    setContextMenu(null);
    if (!menu || !doc) return;
    if (menu.summaryId !== undefined) {
      // 概要菜单（M6 T6）：唯一动作「删除概要」
      if (action === 'remove-summary') {
        try {
          removeSummary(doc, menu.summaryId, ORIGIN_USER);
          afterUserWrite();
        } catch (e) {
          showToast(e instanceof Error ? e.message : '概要删除失败');
        }
      }
      return;
    }
    const nodeId = menu.nodeId as string;
    switch (action) {
      case 'task-quick':
        // 任务设置（M7c-C3）：快速卡锚定右键点击点（menu.x/y），置顶项
        openQuickCard(nodeId, menu.x, menu.y);
        break;
      case 'insert-child':
        openNewNodeEditor(nodeId, undefined, 'child', 'context');
        break;
      case 'insert-sibling': {
        if (nodeId === ROOT_NODE_ID) {
          openNewNodeEditor(ROOT_NODE_ID, undefined, 'child', 'context');
          break;
        }
        const snap = getNode(doc, nodeId);
        const parent = snap ? getNode(doc, snap.parentId) : null;
        if (!snap || !parent || parent.deleted) break;
        openNewNodeEditor(parent.id, parent.childIds.indexOf(nodeId) + 1, 'sibling', 'context');
        break;
      }
      case 'delete':
        handleDelete('context');
        break;
      case 'copy':
        void handleCopy();
        break;
      case 'cut':
        void handleCut('context');
        break;
      case 'paste':
        void handlePaste();
        break;
      case 'add-summary':
        addSummaryFromSelection();
        break;
      case 'toggle-collapse':
        handleToggleCollapse();
        break;
      default:
        break;
    }
  };

  // —— React 渲染所需的文档派生值（tick 由 rerender 推进） ——
  const meta = doc ? getMeta(doc) : null;
  const themeId = meta ? resolveThemeId(meta.themeId) : 'gmind-blue';
  // 脚标口径与服务端配额统一（FR-ACC-003）：自 root 可达的存活节点数（不含 root；
  // 墓碑/孤儿不计——与 countAlive 的差异见 @gmind/core countAliveReachable）
  const nodeCount = doc ? countAliveReachable(doc) : 0;
  const selectionNow = selectionRef.current;
  const selectedNodeId =
    selectionNow && selectionNow.selected.size === 1
      ? ([...selectionNow.selected][0] ?? null)
      : null;
  // 有任意选中（单选/多选）即可用工具栏增删按钮（多选时操作主选中节点）
  const hasSelection = (selectionNow?.selected.size ?? 0) > 0;
  // 选中节点快照（M6 Task 2 企微对标）：RichPanel 样式区回显数据源；无选中（空选
  // 区/多选/已删）为 null → 样式区置灰 + 提示。tick 驱动重渲染，切换节点即时刷新。
  const selectedSnapshot = doc && selectedNodeId ? getNode(doc, selectedNodeId) : null;

  // —— 标记面板批量口径（M7b-W3 #5）——
  // 选中集存活节点（root 亦可携标记，随选区一并计入）；标记回显 = **交集口径**
  // （组值仅当全部选中节点都含才亮，与批量「全含则移除否则设置」同一语义）。
  const selectedIds =
    selectionNow && doc
      ? [...selectionNow.selected].filter((id) => {
          const snap = getNode(doc, id);
          return !!snap && !snap.deleted;
        })
      : [];
  const selectedIcons: Partial<Record<IconGroup, string[]>> = {};
  if (doc && selectedIds.length > 0) {
    for (const group of ICON_GROUPS) {
      let acc: string[] | null = null;
      for (const id of selectedIds) {
        const vals = getNode(doc, id)?.icons?.[group] ?? [];
        acc = acc === null ? [...vals] : acc.filter((v) => vals.includes(v));
        if (acc.length === 0) break;
      }
      if (acc && acc.length > 0) selectedIcons[group] = acc;
    }
  }
  // 面板右缘越界钳制（企微弹层贴插入按钮左缘展开；越界时整体左移收回视口）。
  const MARKER_PANEL_WIDTH = 340;
  const markerOffsetLeft =
    markerPanel.anchor.left + MARKER_PANEL_WIDTH > window.innerWidth - 8
      ? window.innerWidth - 8 - MARKER_PANEL_WIDTH - markerPanel.anchor.left
      : 0;

  // —— 结构/主题面板锚定坐标（2026-09-30 需求方四条反馈任务 1）——
  // 两面板改企微式贴按钮下拉（absolute 挂各自 wrap 下、left 对齐按钮左缘）。
  // wrap 位于工具栏中部偏右，窄视口（≤1280 或右列挤压）下面板可能越过视口右缘：
  // 渲染期实测 wrap 屏幕左缘做右缘钳制（负 left 左移收回视口），宽视口为 0 直落
  // 左对齐。同 markerOffsetLeft 的渲染期一次性量测模式（仅开启时读，零常开销）。
  const STRUCT_PANEL_WIDTH = 320;
  const anchoredOffsetLeft = (wrapEl: HTMLElement | null, open: boolean): number => {
    if (!open || !wrapEl) return 0;
    const anchorLeft = wrapEl.getBoundingClientRect().left;
    return anchorLeft + STRUCT_PANEL_WIDTH > window.innerWidth - 8
      ? window.innerWidth - 8 - STRUCT_PANEL_WIDTH - anchorLeft
      : 0;
  };
  const structureOffsetLeft = anchoredOffsetLeft(structureWrapRef.current, structurePanelOpen);
  const themeOffsetLeft = anchoredOffsetLeft(themeWrapRef.current, themePanelOpen);

  // —— 迷你选盘派生（M7b-W3 #4）：目标节点快照 + 视口内钳制的弹出坐标 ——
  const pickerSnapshot = markerPicker && doc ? getNode(doc, markerPicker.nodeId) : null;
  const pickerLeft = markerPicker ? Math.min(markerPicker.x + 6, window.innerWidth - 262) : 0;
  const pickerTop = markerPicker ? Math.min(markerPicker.y + 6, window.innerHeight - 260) : 0;

  // —— 顶栏头像栏派生（M6 Task 9，企微对标）——
  // 在线判定 = 当前 presence 集；展示集 = 会话内已见成员首见序前 MAX_AVATARS 枚，
  // 其余折叠为「+N」溢出位。离线成员（已见不在 presence）仍展示、灰态。
  const avatarOnlineIds = new Set(members.map((m) => m.userId));
  const avatarShown = [...avatarSeen.values()].slice(0, MAX_AVATARS);
  const avatarOverflow = avatarSeen.size - avatarShown.length;

  // —— 评论动作（M3b Task 7，FR-CMT-002）——

  /**
   * 面板条目 → 画布定位：selectOnly + 沿 pathToRoot 展开折叠祖先（pathToRoot 自身
   * 起步至 root；祖先 collapsed=true 才 toggleCollapse——system origin 不进撤销栈）。
   * 定位裁决：选区 + 展开即满足「定位」，不做视口居中（过扰）；选中高亮由
   * .gm-selected 样式承担（rerender 每帧回填类，新展开的节点同样命中）。
   */
  const locateNode = (nodeId: string): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const snap = getNode(doc, nodeId);
    if (!snap || snap.deleted) return; // 已删节点无线索可定位（面板标记原节点已删除）
    try {
      for (const ancestorId of pathToRoot(doc, nodeId)) {
        if (ancestorId === nodeId) continue;
        const anc = getNode(doc, ancestorId);
        if (anc && !anc.deleted && anc.collapsed) toggleCollapse(doc, ancestorId);
      }
      selection.selectOnly(nodeId);
    } catch (e) {
      showToast(e instanceof Error ? e.message : '定位失败');
    }
  };

  /** 选中节点添加评论（面板顶部输入）：POST 成功后直接触发再拉取（离线无广播的
   *  兜底；在线时服务端广播也会触发同一路径，由 in-flight 去重收敛）。 */
  const submitComment = async (content: string): Promise<void> => {
    if (!selectedNodeId) return;
    try {
      await apiPost(`/files/${fileId}/comments`, { nodeId: selectedNodeId, content });
      commentsRefreshRef.current?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '评论发送失败');
    }
  };

  /** 楼中楼回复：一律挂线程楼主（服务端拍平语义），成功后再拉取。 */
  const submitReply = async (threadId: string, content: string): Promise<void> => {
    try {
      await apiPost(`/files/${fileId}/comments/${threadId}/replies`, { content });
      commentsRefreshRef.current?.();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '回复发送失败');
    }
  };

  // 星标初始态随文件装载/切换同步（useEditorDoc 对每次 fileId 装载产出新 state）
  useEffect(() => {
    if (state) setStarred(state.starred);
  }, [state]);

  /** presence → 会话内已见成员合并（M6 Task 9）：新成员或快照变更才产出新 Map，
   *  无变化返回原引用（React bail out，不为 editing 抖动等高频回调付重渲染）。 */
  const mergeAvatarSeen = (next: PresenceMember[]): void => {
    setAvatarSeen((prev) => {
      let merged: Map<string, PresenceMember> | null = null;
      for (const m of next) {
        const old = prev.get(m.userId);
        if (old === m) continue;
        if (old !== undefined && old.joinedAt === m.joinedAt && old.nickname === m.nickname) {
          continue; // 同一会话快照未变（editing 翻转不重排头像栏）
        }
        merged ??= new Map(prev);
        merged.set(m.userId, m);
      }
      return merged ?? prev;
    });
  };

  // —— 引擎装配主 effect ——
  useEffect(() => {
    if (!state) return;
    const { doc: d, um: manager } = state;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const selection = new SelectionModel();
    selectionRef.current = selection;
    selection.onChange = () => {
      applySelectionClasses();
      // 选区广播（FR-COL-002）：远端据此渲染我的彩色选区框/昵称标签
      collabHandleRef.current?.setSelection([...selection.selected]);
      setTick((t) => t + 1);
    };

    const reader = readerOf(d);
    const depthById = new Map<string, number>();
    let rafId = 0;
    let scheduled = false;

    const applySelectionClasses = (): void => {
      const scene = sceneRef.current;
      if (!scene) return;
      for (const [id, entry] of scene.nodeEntries) {
        entry.g.classList.toggle('gm-selected', selection.selected.has(id));
      }
    };

    /** 重建场景 + 视口 + 拖拽（主题切换/首次装配；carry-in 裁决 3）。 */
    const rebuildScene = (): void => {
      const prev = viewportRef.current;
      dragRef.current?.destroy();
      prev?.destroy();
      const scene = createScene(svgEl);
      sceneRef.current = scene;
      // 远端光标层（M2 Task 5）：挂 nodesLayer 末尾最上层；主题切换重建场景时随
      // 场景整体重建（createCursorLayer 幂等移除旧层），ref 换新句柄。
      cursorLayerRef.current = createCursorLayer(scene);
      // 视口包装层（fix round 1）：createScene 的边/概要/节点三层是 svg 直接子元素，
      // Viewport 只 transform 单个 g——必须包一层同时携带三层，否则平移/缩放时边脱节点。
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrapper.setAttribute('class', 'gm-viewport');
      wrapper.appendChild(scene.edgesLayer);
      wrapper.appendChild(scene.summariesLayer); // 概要层随视口（M6 T6，边与节点之间）
      wrapper.appendChild(scene.nodesLayer);
      // 拖拽悬浮层（M7c-D1）：nodesLayer 之上、场景坐标——插入指示线宿主
      // （DragController 只增删其内部临时 line，层本身随场景重建）。
      const dragOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      dragOverlay.setAttribute('class', 'gm-drag-overlay');
      wrapper.appendChild(dragOverlay);
      svgEl.appendChild(wrapper);
      const vp = new Viewport(svgEl, wrapper);
      if (prev) {
        vp.scale = prev.scale;
        vp.tx = prev.tx;
        vp.ty = prev.ty;
      }
      vp.apply(); // fix round 1：构造只写恒等 transform，字段拷贝后必须显式回写
      vp.attach();
      viewportRef.current = vp;
      // 拖拽移动为写交互：移动端只读不装配（OPEN-T-005）。空白拖拽平移归
      // Viewport 自有 pointer 监听（上文 vp.attach()），不受影响。
      if (readOnly) {
        dragRef.current = null;
        return;
      }
      const drag = new DragController();
      drag.attach({
        svg: svgEl,
        viewport: vp,
        getBoxes: () => boxesRef.current,
        isDescendant: (id, candidateId) => subtreeIds(d, id).includes(candidateId),
        // 文档子级序（M7c-D1）：sibling 落点 index 结算输入（engine 纯计算在事务外）。
        childrenIdsOf: (id) => childrenIds(d, id),
        // 组拾起（2026-09-30 需求方批量拖动）：按下节点命中当前多选（size>1 且含该
        // 节点）→ 返回整组 id，按布局序（box.y 再 box.x 升序）排序——释放端按
        // index+i 递增插入即还原组内序；排除 root（root 不可移动，组不含 root）。
        // size≤1 或按下的不在多选中 → 单节点（现状路径）。
        getDragGroup: (grabbedId) => {
          const selection = selectionRef.current;
          if (!selection || selection.selected.size <= 1 || !selection.selected.has(grabbedId)) {
            return [grabbedId];
          }
          const boxById = new Map(boxesRef.current.map((b) => [b.id, b]));
          return [...selection.selected]
            .filter((id) => id !== ROOT_NODE_ID && boxById.has(id))
            .sort((idA, idB) => {
              const ba = boxById.get(idA)!;
              const bb = boxById.get(idB)!;
              return ba.y - bb.y || ba.x - bb.x;
            });
        },
        overlayLayer: dragOverlay,
        onDrop: (ids, target) => {
          justDraggedRef.current = true;
          setTimeout(() => {
            justDraggedRef.current = false;
          }, 0);
          try {
            // M7c-D1 落点三分 + 组拖动（2026-09-30）：整组**单事务**原子移动——
            // 内层 moveNode 自带事务，嵌套复用外层，一次 Ctrl+Z 整组回滚。sibling
            // 按引擎结算的文档序 index+i 递增插入（引擎 index 已按「移除全组后」的
            // 子级堆结算），组内序 = 拾起时布局序；child=追加目标子级末尾（现状
            // 语义，引擎已不产出、保留兜底）；null 仅作兜底（root 盒缺失等窗口期；
            // svg 外兜底释放为取消，不回调至此），逐个挂 root 末尾。
            withTransaction(d, ORIGIN_USER, () => {
              if (target === null) {
                for (const id of ids) moveNode(d, id, ROOT_NODE_ID);
              } else if (target.kind === 'child') {
                for (const id of ids) moveNode(d, id, target.nodeId);
              } else {
                ids.forEach((id, i) => moveNode(d, id, target.parentId, target.index + i));
                // M7c-H 逆时针定侧：根级落点按引擎解析的目标侧持久化（拖到哪侧就换到
                // 哪侧；setNodeSide 同值零事务幂等）。target.side 仅 root 级落点携带；
                // 仅 mindmap 消费（logic/org 布局不读）。
                if (target.side !== undefined && target.parentId === ROOT_NODE_ID
                    && getMeta(d).structureType === 'mindmap') {
                  for (const id of ids) setNodeSide(d, id, target.side);
                }
              }
            });
            afterUserWrite();
            // 移动后保持整组选中（selection 批量 set——onChange 统一重画/广播；
            // 单节点不动旧选中行为，路径回归零差异）。
            if (ids.length > 1) selectionRef.current?.set([...ids]);
            // M7c-F 复验问题2：拖动释放不再置 fitPending（rerender 全量 fit 会把
            // 100% 视口拉到 300%/400%，用户视口丢失）。改为 rAF 一帧等 moveNode 触发
            // 的重排落定后，仅把被拖节点平移进可视区（完整可见时 no-op，只平移不缩
            // 放）；其余 fitPending 来源（删空/粘贴）不动。组拖动取组内首个节点。
            const panId = ids[0];
            if (panId !== undefined) requestAnimationFrame(() => panNodeIntoView(panId));
          } catch (e) {
            showToast(e instanceof Error ? e.message : '移动失败');
          }
        },
      });
      dragRef.current = drag;
    };

    const rerender = (): void => {
      const m = getMeta(d);
      const resolvedThemeId = resolveThemeId(m.themeId);
      const theme = THEMES[resolvedThemeId];
      if (sceneRef.current === null || themeRef.current !== resolvedThemeId) {
        rebuildScene();
        themeRef.current = resolvedThemeId;
      }
      const scene = sceneRef.current;
      if (!scene) return; // 不可达（rebuildScene 必建场景）：类型收窄
      svgEl.style.background = theme.canvasBackground;
      // M7c-D2：主题节点圆角暴露为 CSS 变量，行内编辑浮层（.gm-text-editor）圆角
      // 随主题与节点卡片一致（12 套主题 nodeBorderRadius 4~12 不等）。浮层挂 body
      // （非 svg 后代），变量须落 :root 才能被继承。
      document.documentElement.style.setProperty('--gm-node-radius', `${theme.nodeBorderRadius}px`);

      const result = layout(reader, {
        structure: m.structureType,
        theme,
        measure,
        // carry-in 裁决 2：样式闭合 doc 读取
        styleOf: (id, depth) =>
          resolveNodeStyle(theme, depth, getNode(d, id)?.style ?? {}).textStyle,
        // 简洁模式（M7b 补课）：紧凑盒测量（描述/任务行不占几何，进度内联）。
        // ref 直读最新值——切换当帧生效，不等 React 提交（viewRef 同款裁定）。
        compact: compactRef.current,
      });
      layoutRef.current = result;
      boxesRef.current = result.nodes;
      depthById.clear();
      for (const b of result.nodes) depthById.set(b.id, b.depth);

      const nodeData = new Map<string, NodeVisual>();
      for (const id of subtreeIds(d, ROOT_NODE_ID)) {
        const snap = getNode(d, id);
        if (!snap || snap.deleted) continue;
        nodeData.set(id, {
          text: snap.text,
          icons: snap.icons,
          note: snap.note,
          href: snap.href,
          image: snap.image,
          // 评论角标计数（FR-CMT-002）：仅存活节点携带（服务端 counts 已排除
          // 已删节点线程与 resolved）；无评论的节点不设键 → 引擎按 0 处理不渲染
          commentCount: commentCountsRef.current[id],
          // 任务字段（M7c-C2 接线）：状态条/任务行/徽标数据源。description 行不经
          // nodeData——布局经 DocReader.getNode 直读（engine NodeSnapshotLike 通道）。
          task: snap.task,
        });
      }
      renderScene(scene, {
        layout: result,
        theme,
        styleOf: (id) => resolveNodeStyle(theme, depthById.get(id) ?? 0, getNode(d, id)?.style ?? {}),
        nodeData,
        // 逾期判定「今天」（M7c-C2 接线）：宿主显式传当日，与表格视图口径一致
        today: todayStr(),
        // 简洁模式（M7b 补课）：状态条/任务行条带隐藏、进度内联标题行右缘——
        // 与 layout 侧同帧同值（compactRef 直读）。
        compact: compactRef.current,
      });
      applySelectionClasses();
      // 远端光标重画（FR-COL-002）：awareness 变化与 rerender（布局/主题变化）双
      // 触发点都会走到这里，boxes 取本帧最新布局（选区框随节点移动）。
      cursorLayerRef.current?.setCursors(remoteCursorsRef.current, boxesRef.current);
      if (fitPendingRef.current) {
        fitPendingRef.current = false;
        vpFit(result);
      }
      setTick((t) => t + 1);
    };

    const vpFit = (result: LayoutResult): void => {
      const vp = viewportRef.current;
      if (!vp) return;
      vp.fit(result, { w: svgEl.clientWidth, h: svgEl.clientHeight });
      setZoomPct(Math.round(vp.scale * 100));
    };

    const scheduleRerender = (): void => {
      if (scheduled) return;
      scheduled = true;
      rafId = requestAnimationFrame(() => {
        scheduled = false;
        rerender();
      });
    };
    // 桥接出装配闭包（M7b 补课）：简洁模式切换（纯显示偏好、无文档写入）经此
    // 入口触发画布重排；卸载置空防悬挂调用。
    scheduleRerenderRef.current = scheduleRerender;

    // —— 评论拉取（FR-CMT-002）：进入文档全量 GET；此后仅 comment-updated 广播
    // （服务端在创建/回复成功后广播，含本端自己的 POST——广播经 WS 回来同样触发
    // 本回调）与「本端 POST 成功后的直接触发」两条路径会重入。以 in-flight +
    // queued 尾随去重收敛：进行中则记一次尾随，完成后补拉一轮，循环自然收敛。 ——
    let refreshInFlight = false;
    let refreshQueued = false;
    const refreshComments = async (): Promise<void> => {
      if (refreshInFlight) {
        refreshQueued = true;
        return;
      }
      refreshInFlight = true;
      try {
        const data = await api<{ threads: CommentThreadView[]; counts: Record<string, number> }>(
          `/files/${fileId}/comments`,
        );
        commentCountsRef.current = data.counts;
        setComments(data);
        scheduleRerender(); // 角标计数走场景协调，需推进一次重渲染
      } catch {
        // 拉取失败（离线/权限抖动）：保持既有数据，等下一次广播或重新装载
      } finally {
        refreshInFlight = false;
        if (refreshQueued) {
          refreshQueued = false;
          await refreshComments();
        }
      }
    };
    commentsRefreshRef.current = () => void refreshComments();

    rebuildScene();
    themeRef.current = resolveThemeId(getMeta(d).themeId);
    const stopSave = startSaveLoop(d, fileId, setStatus, {
      collab: {
        // 持久化真值表（binding）：WS 已连接（且曾同步）→ PUT 停用；否则 PUT 兜底
        shouldPutNow: () =>
          shouldPut({
            wsConnected: collabRef.current.wsConnected,
            wsEverConnected: collabRef.current.wsEverConnected,
          }),
        // WS 不可达 → PUT 失败按离线文案呈现（恢复联网后自动同步），维持 M1 重试文案
        // 仅在「provider 自认在线但 REST 失败」的错位窗口出现
        offlineHint: () => (collabRef.current.wsConnected ? null : OFFLINE_STATUS),
        // M7b-K1 看门狗：provider 未同步变更查询（collab 稍后装配，经 ref 延迟取）
        hasUnsyncedChanges: () => collabHandleRef.current?.provider.hasUnsyncedChanges ?? false,
      },
      // 写序 base（M3a 准入 7.1）：PUT 携带 baseUpdatedAt，服务端据此拒绝陈旧整快照
      getBaseUpdatedAt: () => baseUpdatedAtRef.current,
    });
    // 协同接入（FR-EDT-034）：provider 挂到 useEditorDoc 装配的同一 doc 上，
    // GET 装配路径不变；状态事件 → 四值保存指示 + 真值表状态推进。
    const collab = startCollab(fileId, d, {
      onStatus: (collabStatus, detail) => {
        if (collabStatus === 'synced') {
          collabRef.current.wsConnected = true;
          collabRef.current.wsEverConnected = true;
          // 增量通道恢复即取消已 armed 的兜底 PUT 计时：继续发射会与 WS 持久化
          // 竞速出 409 误报（断网重连窗口，e2e collab 压测 ~40% 复现）——本地未
          // 同步变更由 WS 通道自身同步。
          stopSave.clearRetry();
          // 重连无待同步变更时不会有 persisted ack，主动清掉离线指示；
          // 有待同步变更则等 ack 收尾（先落到「保存中」）
          if (collab.provider.hasUnsyncedChanges) {
            setStatus('保存中…');
            stopSave.armSavingWatch(); // M7b-K1：无 ack 场景（无变更不广播）由看门狗回落
          }
          else
            setStatus((prev) =>
              prev.startsWith('离线') || prev.startsWith('保存失败') ? `已保存 ${clockNow()}` : prev,
            );
          return;
        }
        if (collabStatus === 'offline' || collabStatus === 'connecting') {
          collabRef.current.wsConnected = false;
        }
        if (collabStatus === 'quota') {
          // M2 终审修复轮（Global Constraint / M1b 终审裁定原文）：超限广播 → 置
          // 只读新增拦截标志 + toast。此前仅改状态文字，~2s 后即被 persisted ack
          // 的「已保存」覆盖，WS 主路径的 ≤500 节点控制（FR-ACC-003 P0）形同虚设。
          quotaBlockedRef.current = nextQuotaBlock(quotaBlockedRef.current, { type: 'quota' });
          showToast(QUOTA_ADD_BLOCKED);
        }
        if (collabStatus === 'saved' && quotaBlockedRef.current) {
          // 拦截中的每次 persisted ack 复查本地可达活跃数（客户端无法逐键计数，
          // 借服务端回执收敛）：≤ 上限才解除，仍超限则保持拦截。
          quotaBlockedRef.current = nextQuotaBlock(true, {
            type: 'saved',
            aliveCount: d ? countAliveReachable(d) : 0,
          });
          if (quotaBlockedRef.current) {
            // 仍超限：ack 不得把配额指示覆盖回「已保存」（裁定：拦截期间指示常驻）
            setStatus(QUOTA_STATUS);
            return;
          }
          // 解除：不 return，落入常规「已保存 HH:MM」
        }
        const next = statusText(collabStatus, detail);
        if (next !== null) setStatus(next);
      },
      // Awareness → 页面（M2 Task 5/6，FR-COL-002/005）：远端光标经光标层渲染；
      // 在线成员进 React state 驱动成员面板与角标。
      onRemoteCursors: (cursors) => {
        remoteCursorsRef.current = cursors;
        cursorLayerRef.current?.setCursors(cursors, boxesRef.current);
      },
      onPresence: (next) => {
        setMembers(next);
        mergeAvatarSeen(next); // 头像栏会话缓存（M6 Task 9）：同一通道派生，见 state 声明处注释
      },
      // persisted ack 携带的行 updated_at（M3a 准入 7.1）→ 刷新写序 base；此后断开
      // 走 PUT 兜底时，携带的是最后一次服务端持久化确认的行值
      onPersisted: (updatedAt) => {
        baseUpdatedAtRef.current = updatedAt;
      },
      // 评论更新广播（FR-CMT-003，Task 7）：无状态消息 → 再拉取评论
      onCommentUpdated: () => {
        void refreshComments();
      },
    });
    collabHandleRef.current = collab;
    // 键盘写路径：移动端只读不装配（OPEN-T-005 裁定「以不挂载实现」——Enter/
    // Tab/Delete/粘贴等全部写键位随监听缺席一并失效；readOnly 入 effect 依赖，
    // 断点跨越时按本 effect 重建路径重新装配/卸下）。
    const detachKeys = readOnly ? null : attachKeyboardMap({
      // 覆盖层打开即让路（其 Enter/Esc 已 stopPropagation，此为其余按键的兜底）
      isEditorOpen: () => overlay.isOpen,
      // 表格视图：画布写/导航键位让路（M7a-T4；撤销/重做不受此闸，见 keyboardMap 注释）
      isInactive: () => viewRef.current === 'table',
      undo: () => coreUndo(manager),
      redo: () => coreRedo(manager),
      onEnter: handleEnter,
      onEditSelected: () => openNodeEditor(primaryId()),
      onTab: handleTab,
      onDelete: handleDelete,
      onSelectAll: handleSelectAll,
      onToggleCollapse: handleToggleCollapse,
      // Ctrl/Cmd+? 打开快捷键帮助面板（M5 Task 2，FR-EDT-007）；绑定经 keyboardMap
      // （与 SHORTCUT_LIST 同源：面板「文件」组列出的就是这条绑定）
      onHelp: () => setHelpOpen((v) => !v),
      onNavigate: handleNavigate,
      onSiblingEnd: handleSiblingEnd,
      onCopy: () => void handleCopy(),
      onCut: () => void handleCut(),
      onPaste: () => void handlePaste(),
    });

    const onDocUpdate = (): void => scheduleRerender();
    d.on('update', onDocUpdate);
    // 编辑态画布粘贴截图（FR-EDT-020）：document 冒泡监听；焦点在输入控件/
    // 覆盖层时让路（与键盘映射同一 isEditableTarget 判定）；剪贴板含图片文件时
    // preventDefault 截停默认行为并走上传链路，否则不干预（文本粘贴走键盘映射
    // Ctrl+V 通道与原生 paste 共存，二者对图片文件互斥）。
    const onDocPaste = (ev: ClipboardEvent): void => {
      if (readOnly) return; // 移动端只读：画布粘贴截图（写路径）一并禁用
      if (overlay.isOpen || isEditableTarget(ev.target)) return;
      const file = Array.from(ev.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith('image/'),
      );
      if (!file) return;
      ev.preventDefault();
      void insertPastedImage(file);
    };
    document.addEventListener('paste', onDocPaste);
    const onWheelSync = (): void => {
      requestAnimationFrame(syncZoom);
    };
    svgEl.addEventListener('wheel', onWheelSync);

    rerender();
    selection.selectOnly(ROOT_NODE_ID); // 默认选中中心主题（「选中 root 按 Tab」起点）
    // 首帧 fit 只缩不放（fitCanvas(1)，kimi 复验 P5）：新文档不被放大到 400%，默认
    // 100% 居中；平移仍居中，工具栏「适应画布」路径不传 maxScale 不受影响。
    requestAnimationFrame(() => fitCanvas(1));
    // perf_metric 埋点（M5 Task 4，PRD 6.4 首屏时间）：装配完成（首帧渲染 + 默认选中 +
    // 视口适应排队）即编辑器可交互；performance.now() 自导航起点计毫秒，无需另记起点。
    // 一次装载恰一行（perfTrackedRef 按 fileId 去重，防 StrictMode dev 双跑重复上报）。
    if (perfTrackedRef.current !== fileId) {
      perfTrackedRef.current = fileId;
      track('perf_metric', { firstInteractionMs: performance.now() }, fileId);
    }
    void refreshComments(); // 进入文档全量拉取评论（此后靠 comment-updated 广播）

    return () => {
      cancelAnimationFrame(rafId);
      scheduled = false;
      svgEl.removeEventListener('wheel', onWheelSync);
      document.removeEventListener('paste', onDocPaste);
      d.off('update', onDocUpdate);
      stopSave.stop();
      collabHandleRef.current = null;
      quotaBlockedRef.current = false; // 文件切换不继承上一文件的配额拦截
      collab.destroy(); // provider + IndexedDB 本地副本一并收尾（顺序：先冲刷 saveLoop 决策再断链）
      commentsRefreshRef.current = null; // 文件切换不继承上一文件的评论刷新入口
      scheduleRerenderRef.current = null; // 文件切换不继承上一文件的画布重排入口
      commentCountsRef.current = {};
      setComments({ threads: [], counts: {} });
      setCommentFilter(null);
      cursorLayerRef.current = null;
      remoteCursorsRef.current = [];
      setMembers([]);
      setAvatarSeen(new Map()); // 头像栏会话缓存随文件切换重置（M6 Task 9）
      detachKeys?.();
      setEditingClass(null); // 编辑重影类兜底摘除（不依赖 close(false)→onCancel 顺带清理）
      overlay.close(false);
      dragRef.current?.destroy();
      dragRef.current = null;
      viewportRef.current?.destroy();
      viewportRef.current = null;
      sceneRef.current = null;
      selectionRef.current = null;
      boxesRef.current = [];
      layoutRef.current = null;
      themeRef.current = '';
      void manager.destroy();
    };
  }, [state, fileId, readOnly]);

  // —— 通知深链（M4 清偿包）——
  // 装载完成后读 ?node=<ulid>：有效则 locateNode 定位（同评论面板「选中 + 展开折叠祖先」
  // 语义），随即 history.replaceState 清参——刷新不重复定位。effect 声明在装配 effect
  // 之后：同一 commit 内后执行，selectionRef/场景必已就绪；node 缺失/已删时 locateNode
  // 自身 no-op，参数仍清除。依赖仅 [doc]：locateNode 每次渲染重建、清参后不会二次命中，
  // 无需入依赖。
  useEffect(() => {
    if (!doc) return;
    const nodeId = new URLSearchParams(window.location.search).get('node');
    if (!nodeId) return;
    locateNode(nodeId);
    // 保留 history.state（react-router 的 usr/key/idx 内部态）：只清查询串，不动路由栈
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }, [doc]);

  if (error) {
    return (
      <div className="editor-page">
        <div className="editor-error">
          <p>{error}</p>
          <button onClick={() => navigate('/workspace')}>返回工作台</button>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-page">
      <header className="editor-toolbar">
        {/* 工具栏图标化分组改版（M6 Task 1，企微对标）：单行分组 + 1px 竖线分隔。
            组序：[返回] | [标题·星标·保存状态] | [撤销·重做·格式刷] | [结构·主题] |
            [插入] | [导出] | [成员·版本历史·动态·快捷键·查找] | [全屏]；全部按钮
            内联 SVG 图标 + title 提示，既有 data-testid 一概保留（members-btn 实名
            与既有用例一致）。插入组为标记面板任务新增（标记/备注/链接/图片）。 */}
        <div className="toolbar-group">
          <button
            data-testid="back-btn"
            className="toolbar-btn"
            title="返回工作台"
            onClick={() => navigate('/workspace')}
          >
            <BackIcon />
          </button>
        </div>
        {readOnly ? (
          /* 移动端工具栏精简版（OPEN-T-005）：仅返回 + 标题只读展示 + 保存状态 +
             评论开关——其余编辑项（结构/主题/撤销/重做/全屏/导出/标题输入/星标/
             版本/快捷键/成员）一概不装配。 */
          <>
            <span className="title-display" data-testid="title-display">
              {meta?.title ?? ''}
            </span>
            <span className="save-status" data-testid="save-status">
              {status}
            </span>
            <button
              data-testid="comment-toggle"
              data-popover-toggle="comment-toggle"
              title="评论"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              评论
            </button>
          </>
        ) : (
          <>
        <span className="toolbar-sep" />
        {/* 标题组：标题输入 + 星标 + 保存状态（位置语义不变：返回之后的最左区）。
            star-toggle 保留 ★/☆ 字形（editor.e2e 断言按钮文本，零回归约束）。 */}
        <div className="toolbar-group toolbar-group-title">
          <input
            data-testid="title-input"
            className="title-input"
            value={meta?.title ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              if (value.trim() === '') {
                // 空标题（fix round 1 minor b）：不落库不 PATCH，重渲染让受控值回灌恢复
                setTick((t) => t + 1);
                return;
              }
              setTitle(value);
              afterUserWrite(); // fix round 1 minor a：标题写也走统一 capUndoStack 通道
            }}
            placeholder="文档标题"
          />
          <button
            data-testid="star-toggle"
            className={'star-toggle' + (starred ? ' starred' : '')}
            title={starred ? '取消星标' : '加星标'}
            onClick={toggleStar}
          >
            {starred ? '★' : '☆'}
          </button>
          <span className="save-status" data-testid="save-status">
            {status}
          </span>
        </div>
        <span className="toolbar-sep" />
        {/* 视图切换（M7a-T4）：脑图 | 表格 分段控件。切换互斥、各自状态保留
            （画布引擎不卸载仅隐藏；表格常驻挂载保筛选态）。移动端只读分支不装配。 */}
        <div className="toolbar-group">
          <div className="view-tabs" role="tablist" aria-label="视图切换">
            <button
              type="button"
              role="tab"
              data-testid="view-tab-mind"
              aria-selected={view === 'mind'}
              className={view === 'mind' ? 'active' : ''}
              onClick={() => setView('mind')}
            >
              脑图
            </button>
            <button
              type="button"
              role="tab"
              data-testid="view-tab-table"
              aria-selected={view === 'table'}
              className={view === 'table' ? 'active' : ''}
              onClick={() => setView('table')}
            >
              表格
            </button>
          </div>
        </div>
        <span className="toolbar-sep" />
        {/* 历史组：撤销 / 重做 */}
        <div className="toolbar-group">
          <button
            data-testid="undo-btn"
            className="toolbar-btn"
            title="撤销 (Ctrl+Z)"
            onClick={() => um && coreUndo(um)}
          >
            <UndoIcon />
          </button>
          <button
            data-testid="redo-btn"
            className="toolbar-btn"
            title="重做 (Ctrl+Y)"
            onClick={() => um && coreRedo(um)}
          >
            <RedoIcon />
          </button>
          {/* 格式刷（M6 Task 7，企微对标）：单击复制选中节点样式/图标 → 点目标应用
              （单发）；双击粘滞连续刷；Esc / 再点按钮退出 */}
          <button
            data-testid="format-painter"
            className={painter ? 'toolbar-btn toolbar-btn-text active' : 'toolbar-btn toolbar-btn-text'}
            title="格式刷（双击连续刷）"
            aria-label="格式刷"
            aria-pressed={painter !== null}
            onClick={onPainterClick}
            onDoubleClick={onPainterDoubleClick}
          >
            <PainterIcon />
            <span className="toolbar-btn-label">格式刷</span>
          </button>
        </div>
        <span className="toolbar-sep" />
        {/* 插入组（2026-09-28 二次改版；M7b-W3 面板重做）：下拉两并列项「图标」「表情」
            打开**锚定弹出层** MarkerPanel（企微式竖层：挂 .insert-wrap 下、顶贴按钮
            下沿向下展开，面板内可切换图标/表情页签）；备注/链接/图片聚焦 RichPanel
            对应控件。不再使用 fixed 视口抽屉（需求方 #1 裁定）。 */}
        <div className="toolbar-group">
          <div className="insert-wrap" ref={insertWrapRef}>
            <button
              data-testid="insert-menu"
              className="toolbar-btn toolbar-btn-text"
              title="插入"
              aria-label="插入"
              aria-haspopup="menu"
              aria-expanded={insertOpen}
              onClick={() => {
                if (insertOpen) {
                  closeInsertLayer();
                  return;
                }
                // 开菜单收面板（二者同挂 insert-wrap，互斥——注释契约见 closeInsertLayer）
                setMarkerPanel((p) => (p.open ? { ...p, open: false } : p));
                setInsertOpen(true);
              }}
            >
              <InsertIcon />
              <span className="toolbar-btn-label">插入</span>
            </button>
            {insertOpen && (
              <div className="insert-dropdown" role="menu" aria-label="插入">
                {/* 任务 3（2026-09-30 需求方四条反馈）：插入菜单去 × ——外点/Esc
                    关闭不变已兜底，头部只留「插入」标题文字；导出菜单/结构/主题
                    面板的 × 不动（对齐企微下拉浮层无关闭钮形态）。 */}
                <div className="popover-head">
                  <span className="popover-head-title">插入</span>
                </div>
                <button
                  data-testid="insert-icons"
                  role="menuitem"
                  onClick={() => openMarkerPanel('icon')}
                >
                  图标
                </button>
                <button
                  data-testid="insert-emoji"
                  role="menuitem"
                  onClick={() => openMarkerPanel('emoji')}
                >
                  表情
                </button>
                <button
                  data-testid="insert-link"
                  role="menuitem"
                  onClick={() => {
                    closeInsertLayer();
                    openRichAndFocus('input[aria-label="节点链接"]', '选中节点后编辑链接');
                  }}
                >
                  链接
                </button>
                <button
                  data-testid="insert-comment"
                  role="menuitem"
                  onClick={() => {
                    closeInsertLayer();
                    setCommentsOpen(true);
                  }}
                >
                  评论
                </button>
                <button
                  data-testid="insert-image"
                  role="menuitem"
                  onClick={() => {
                    closeInsertLayer();
                    setFormatOpen(true);
                    // 面板挂载后一帧再触发系统文件选择器（同 openRichAndFocus 时序）
                    requestAnimationFrame(() => triggerImageInput());
                  }}
                >
                  图片
                </button>
                {/* 「简介」项已回退（2026-10-01 需求方反馈任务 2，恢复 M7b #3 裁定的
                    note 隐藏态）：M7c-I 的 insert-note 菜单项与 RichPanel 备注区块
                    一并撤下，note 数据模型与画布 'N' 角标渲染不动（见 RichPanel 头注）。 */}
              </div>
            )}
            {/* 标记面板（M7b-W3 企微式竖层）：锚定弹出层，absolute 于 .insert-wrap
                （顶贴按钮下沿、左缘对齐，offsetLeft 右缘越界钳制）；批量口径见
                applyMarker（多选可批量应用），无选中禁用+提示。 */}
            {markerPanel.open && (
              <MarkerPanel
                icons={selectedIcons}
                selectedCount={selectedIds.length}
                onSetIcon={applyMarker}
                tab={markerPanel.tab}
                onTabChange={(tab) => setMarkerPanel((p) => ({ ...p, tab }))}
                onClose={() => setMarkerPanel((p) => ({ ...p, open: false }))}
                offsetLeft={markerOffsetLeft}
              />
            )}
          </div>
        </div>
        <span className="toolbar-sep" />
        {/* 主题三按钮（M7b-R4 需求方裁定，企微工具栏对标）：添加上级主题/添加子主题/
            添加同级主题——复用 Shift+Tab/Tab/Enter 键位的同一处理路径（handleTab/
            handleEnter），语义与快捷键一一对应；无选中节点置灰。 */}
        <div className="toolbar-group">
          <button
            data-testid="toolbar-add-parent"
            className="toolbar-btn toolbar-btn-text toolbar-add-node"
            title="添加上级主题（Shift+Tab）"
            aria-label="添加上级主题"
            disabled={!hasSelection}
            onClick={() => handleTab(true)}
          >
            <span className="toolbar-btn-label">上级主题</span>
          </button>
          <button
            data-testid="toolbar-add-child"
            className="toolbar-btn toolbar-btn-text toolbar-add-node"
            title="添加子主题（Tab）"
            aria-label="添加子主题"
            disabled={!hasSelection}
            onClick={() => handleTab(false)}
          >
            <span className="toolbar-btn-label">子主题</span>
          </button>
          <button
            data-testid="toolbar-add-sibling"
            className="toolbar-btn toolbar-btn-text toolbar-add-node"
            title="添加同级主题（Enter）"
            aria-label="添加同级主题"
            disabled={!hasSelection}
            onClick={() => handleEnter()}
          >
            <span className="toolbar-btn-label">同级主题</span>
          </button>
        </div>
        <span className="toolbar-sep" />
        {/* 格式按钮（M7b-R2 需求方裁定）：样式右列默认隐藏，点此开/关（右列弹出）。
            任务按钮（M7c-C4）：右侧任务面板开关，与格式互斥（开任务收格式、开格式
            收任务——企微式图标+文字，同族装配）。 */}
        <div className="toolbar-group">
          <button
            data-testid="format-toggle"
            data-popover-toggle="format-toggle"
            className={formatOpen ? 'toolbar-btn toolbar-btn-text active' : 'toolbar-btn toolbar-btn-text'}
            title="格式"
            aria-label="格式"
            aria-pressed={formatOpen}
            onClick={() => {
              setFormatOpen((v) => !v);
              setTaskPanelOpen(false);
            }}
          >
            <PainterIcon />
            <span className="toolbar-btn-label">格式</span>
          </button>
          <button
            data-testid="task-toggle"
            data-popover-toggle="task-toggle"
            className={taskPanelOpen ? 'toolbar-btn toolbar-btn-text active' : 'toolbar-btn toolbar-btn-text'}
            title="任务"
            aria-label="任务"
            aria-pressed={taskPanelOpen}
            onClick={() => {
              setTaskPanelOpen((v) => !v);
              setFormatOpen(false);
            }}
          >
            <TaskIcon />
            <span className="toolbar-btn-label">任务</span>
          </button>
          {/* 简洁模式切换（M7b 补课，mindgrid 账号级显示偏好）：隐藏描述与任务详情、
              节点收敛紧凑盒（表格视图不受影响，有自己的密度）。与「任务」钮同族装配
              （图标+文字）；激活态蓝描边（compact-active，同 view-tabs active 蓝描边
              家族）；偏好走 localStorage，不入文档数据。 */}
          <button
            type="button"
            data-testid="compact-toggle"
            className={
              compact ? 'toolbar-btn toolbar-btn-text active compact-active' : 'toolbar-btn toolbar-btn-text'
            }
            title="简洁模式：隐藏描述与任务详情，缩小节点"
            aria-label="简洁模式"
            aria-pressed={compact}
            onClick={toggleCompact}
          >
            <CompactIcon />
            <span className="toolbar-btn-label">简洁</span>
          </button>
        </div>
        <span className="toolbar-sep" />
        {/* 视图组：结构（2026-09-30 任务 3：下拉改图形化面板 toggle，图标+文字标签，
            仿主题面板按钮）/ 主题。原 structure-select <select> 移除（e2e 已同步
            适配为 structure-toggle + structure-panel）。
            「格式」样式面板现为右列常驻面板（M3b 裁决），不设工具栏按钮、此位留空。 */}
        <div className="toolbar-group">
          {/* 结构面板锚定 wrap（2026-09-30 需求方反馈任务 1 企微式改版）：relative
              容器包按钮，面板 absolute 挂其下——按钮正下方贴靠下拉（top=按钮底+6px、
              左缘对齐），不再是 fixed 右上浮层；右缘越界由 offsetLeft 钳制。 */}
          <div className="structure-wrap" ref={structureWrapRef}>
            <button
              data-testid="structure-toggle"
              data-popover-toggle="structure-toggle"
              className={structurePanelOpen ? 'toolbar-btn toolbar-btn-text active' : 'toolbar-btn toolbar-btn-text'}
              title="结构"
              aria-label="结构"
              aria-haspopup="true"
              aria-expanded={structurePanelOpen}
              onClick={() => {
                setStructurePanelOpen((v) => !v);
                setThemePanelOpen(false); // 相邻两面板互斥（同 format/task 组惯例）
              }}
            >
              <StructureIcon />
              <span className="toolbar-btn-label">结构</span>
            </button>
            {/* 结构切换面板（2026-09-30 任务 3，仿 ThemePanel）：应用 = setDocMeta
                structureType（原 select 同一写链路，可撤销）+ afterUserWrite，应用后收起 */}
            <StructurePanel
              open={structurePanelOpen}
              current={(meta?.structureType ?? 'mindmap') as StructureTypeValue}
              offsetLeft={structureOffsetLeft}
              onClose={() => setStructurePanelOpen(false)}
              onApply={(value) => {
                setStructurePanelOpen(false);
                if (!doc || value === meta?.structureType) return;
                setDocMeta(doc, { structureType: value }, ORIGIN_USER);
                afterUserWrite();
              }}
            />
          </div>
          {/* 主题面板锚定 wrap（2026-09-30 任务 1，同结构 wrap）：企微式贴按钮下拉。
              主题入口（M7b-W2 #6 需求方裁定）：只留面板按钮，原 theme-select 下拉
              移除——双入口重复。 */}
          <div className="theme-wrap" ref={themeWrapRef}>
            <button
              data-testid="theme-panel-toggle"
              data-popover-toggle="theme-panel-toggle"
              className="toolbar-btn toolbar-btn-text"
              title="主题"
              aria-label="主题"
              aria-expanded={themePanelOpen}
              onClick={() => {
                setThemePanelOpen((v) => !v);
                setStructurePanelOpen(false); // 相邻两面板互斥（同 format/task 组惯例）
              }}
            >
              <ThemeIcon />
              <span className="toolbar-btn-label">主题</span>
            </button>
            {/* 主题缩略图选择面板（M6 Task 4）：套用 = setDocMeta themeId（与 select
                同一写链路，可撤销）+ afterUserWrite，套用后关闭抽屉 */}
            <ThemePanel
              open={themePanelOpen}
              currentId={themeId}
              offsetLeft={themeOffsetLeft}
              onClose={() => setThemePanelOpen(false)}
              onApply={(id) => {
                setThemePanelOpen(false);
                if (!doc || id === themeId) return;
                setDocMeta(doc, { themeId: id }, ORIGIN_USER);
                afterUserWrite();
              }}
            />
          </div>
        </div>
        {/* 导出组（M4 Task 5，FR-IO-004）：XMind + PNG/JPG（Task 9 就地追加，
            不改动既有 XMind 项）。文件名与 header 标题同源 getMeta(doc).title。 */}
        <div className="toolbar-group">
          <div className="export-wrap" ref={exportWrapRef}>
            <button
              data-testid="export-menu"
              className="toolbar-btn"
              title="导出"
              onClick={() => setExportOpen((v) => !v)}
            >
              <ExportIcon />
            </button>
            {exportOpen && (
              <div className="export-menu" role="menu">
                <div className="popover-head">
                  <span className="popover-head-title">导出</span>
                  <button
                    type="button"
                    data-testid="export-close"
                    className="popover-close"
                    title="关闭"
                    aria-label="关闭导出菜单"
                    onClick={() => setExportOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <button
                  data-testid="export-xmind"
                  role="menuitem"
                  onClick={() => {
                    setExportOpen(false);
                    if (!doc || !meta) return;
                    try {
                      exportXmind(doc, meta.title);
                    } catch (e) {
                      showToast(e instanceof Error ? e.message : '导出失败');
                    }
                  }}
                >
                  导出 XMind
                </button>
                {/* PNG/JPG（M4 Task 9，FR-IO-003）：透明背景仅 PNG 生效（JPG 恒白底，
                    JPG 项标注白底），默认勾选。1x/2x/3x = 布局包围盒整倍放大。 */}
                <label className="export-option">
                  <input
                    type="checkbox"
                    data-testid="export-transparent"
                    checked={exportTransparent}
                    onChange={(e) => setExportTransparent(e.target.checked)}
                  />
                  透明背景（PNG）
                </label>
                {[1, 2, 3].map((n) => (
                  <button
                    key={`png-${n}`}
                    data-testid={`export-png-${n}x`}
                    role="menuitem"
                    onClick={() => runImageExport('png', n as 1 | 2 | 3)}
                  >
                    PNG {n}x
                  </button>
                ))}
                {[1, 2, 3].map((n) => (
                  <button
                    key={`jpg-${n}`}
                    data-testid={`export-jpg-${n}x`}
                    role="menuitem"
                    onClick={() => runImageExport('jpg', n as 1 | 2 | 3)}
                  >
                    JPG {n}x（白底）
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <span className="toolbar-sep" />
        {/* 协作/视图组：成员 / 版本历史 / 快捷键 / 查找（T3 查找替换已接线） */}
        <div className="toolbar-group">
          <button
            data-testid="members-btn"
            data-popover-toggle="members-btn"
            className="toolbar-btn"
            title="在线成员"
            aria-label="在线成员"
            onClick={() => {
              setMembersFocus(null); // 常规开关：无定位目标（M6 T9 评审修复轮）
              setMembersOpen((v) => !v);
            }}
          >
            <MembersIcon />
            <span className="members-badge" data-testid="members-count">
              {members.length}
            </span>
          </button>
          {/* 版本历史（M4 Task 8，FR-VER-004 UI）：时间轴/只读预览/一键恢复入口 */}
          <button
            data-testid="versions-toggle"
            data-popover-toggle="versions-toggle"
            className="toolbar-btn"
            title="版本历史"
            onClick={() => setVersionsOpen((v) => !v)}
          >
            <HistoryIcon />
          </button>
          {/* 文档动态（M6 Task 8，企微对标）：events 只读流（评论/导出/版本恢复等） */}
          <button
            data-testid="activity-toggle"
            data-popover-toggle="activity-toggle"
            className="toolbar-btn"
            title="动态"
            aria-label="文档动态"
            onClick={() => setActivityOpen((v) => !v)}
          >
            <ActivityIcon />
          </button>
          {/* 快捷键帮助（M5 Task 2，FR-EDT-007）：工具栏入口，Ctrl/Cmd+? 同一开关 */}
          <button
            data-testid="help-toggle"
            data-popover-toggle="help-toggle"
            className="toolbar-btn"
            title="快捷键帮助 (Ctrl+?)"
            onClick={() => setHelpOpen((v) => !v)}
          >
            <KeyboardIcon />
          </button>
          <button
            data-testid="find-toggle"
            data-popover-toggle="find-toggle"
            className="toolbar-btn"
            title="查找 (Ctrl+F)"
            aria-label="查找"
            onClick={() => setFindOpen(true)}
          >
            <SearchIcon />
          </button>
        </div>
        <span className="toolbar-sep" />
        {/* 全屏组（视图动作收尾） */}
        <div className="toolbar-group">
          <button
            data-testid="fullscreen-btn"
            className="toolbar-btn"
            title="全屏（Esc 退出）"
            onClick={toggleFullscreen}
          >
            <FullscreenIcon />
          </button>
        </div>
        {/* 顶栏协作者头像栏（M6 Task 9，企微对标）：工具栏最右 ≤5 枚 24px 圆头像
            （昵称首字符回退，底色=成员色），在线=全彩+成员色描边、离线=灰；溢出
            「+N」；点击任意头像/溢出位 = 打开既有成员面板（members-btn 同一面板）。
            数据源与 MemberPanel 同一 presence 通道（members/会话缓存 avatarSeen）；
            移动端只读分支不装配（随桌面工具栏整体隐藏）。样式独立于 .toolbar-group
            （无竖线分隔、右缘贴合，T1「7 组」布局契约不动——零回归裁决）。 */}
        <div className="avatar-bar" data-testid="avatar-bar" aria-label="协作者">
          {avatarShown.map((m) => {
            const online = avatarOnlineIds.has(m.userId);
            return (
              <button
                key={m.userId}
                type="button"
                data-testid={`avatar-${m.userId}`}
                className={`avatar-chip${online ? ' online' : ' offline'}`}
                style={
                  online
                    ? { background: m.color, boxShadow: `0 0 0 2px #fff, 0 0 0 3px ${m.color}` }
                    : undefined
                }
                title={`${m.nickname}（${online ? '在线' : '离线'}）`}
                aria-label={`${m.nickname}（${online ? '在线' : '离线'}）`}
                onClick={() => {
                  // 点击头像 = 打开成员面板并定位该成员行（M6 T9 评审修复轮：
                  // 携带目标 userId；离线成员不在 presence 时定位 no-op）
                  setMembersFocus(m.userId);
                  setMembersOpen(true);
                }}
              >
                {m.nickname.charAt(0) || '？'}
              </button>
            );
          })}
          {avatarOverflow > 0 && (
            <button
              type="button"
              data-testid="avatar-overflow"
              className="avatar-overflow"
              title={`还有 ${avatarOverflow} 位协作者`}
              onClick={() => {
                setMembersFocus(null); // 溢出位无特定目标：仅打开面板不定位（裁定）
                setMembersOpen(true);
              }}
            >
              +{avatarOverflow}
            </button>
          )}
        </div>
      </>
        )}
      </header>

      <div className="editor-main">
        {/* 表格视图（M7a-T4）：画布仅 CSS 隐藏（引擎场景/视口/选中不卸载，切回即恢复），
            概要行内编辑随画布容器一并隐藏。 */}
        <div className={view === 'table' ? 'editor-canvas canvas-hidden' : 'editor-canvas'}>
          <svg
            ref={svgRef}
            onClick={(e) => {
              setContextMenu(null);
              onSvgClick(e);
            }}
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            onPointerCancel={onSvgPointerUp}
            onDoubleClick={onSvgDoubleClick}
            onContextMenu={onSvgContextMenu}
            role="application"
            aria-label="脑图画布"
          />
          {/* 概要标签行内编辑（M6 Task 6）：锚定 bracket 标签位置（svg 相对坐标）；
              Enter/失焦提交（未变更零写入），Esc 取消。键盘映射经 isEditableTarget 让路。 */}
          {summaryEdit && !readOnly && (
            <input
              data-testid="summary-label-input"
              className="summary-label-editor"
              style={{ left: summaryEdit.left, top: summaryEdit.top }}
              value={summaryEdit.label}
              autoFocus
              aria-label="概要标签"
              placeholder="概要标签"
              ref={(el) => {
                if (el) {
                  el.focus();
                  el.select();
                }
              }}
              onChange={(e) =>
                setSummaryEdit((prev) => (prev ? { ...prev, label: e.target.value } : prev))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitSummaryEdit(true);
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  summaryEditCancelled.current = true;
                  setSummaryEdit(null);
                }
              }}
              onBlur={() => commitSummaryEdit(false)}
            />
          )}
        </div>

        {/* 任务表格视图（M7a-T4）：常驻挂载（切回脑图仅隐藏，筛选/排序态保留）。
            docVersion = tick：本地/远端任何 doc 更新都驱动表格快照重建。
            点击标题联动画布选中（SelectionModel → 选区广播 + RichPanel 联动）。 */}
        {doc && (
          <div className={view === 'table' ? 'task-table-wrap' : 'task-table-wrap hidden'}>
            <TaskTable
              doc={doc}
              fileId={fileId}
              docVersion={tick}
              readOnly={readOnly}
              presence={members}
              afterUserWrite={afterUserWrite}
              showToast={showToast}
              checkQuota={addBlockedByQuota}
              onSelectNode={(id) => selectionRef.current?.selectOnly(id)}
            />
          </div>
        )}

        {/*
          右列（M3b Task 7 装配裁决）：RichPanel + CommentPanel 同列纵排——
          评论面板常驻下方（data-testid="comment-panel"），选中节点后富内容面板在上。
          移动端只读（M5 Task 5）：右列整列不装配——RichPanel（样式/富内容编辑）
          隐藏；CommentPanel 改由工具栏「评论」开关控制的底部抽屉承载（查看+发表），
          面板组件与 testid 复用同一份。
        */}
        {readOnly ? (
          commentsOpen && (
            <div className="editor-mobile-comments">
              <CommentPanel
                threads={comments.threads}
                filterNodeId={commentFilter}
                selectedNodeId={selectedNodeId}
                onClearFilter={() => setCommentFilter(null)}
                onLocate={locateNode}
                onAddComment={(content) => void submitComment(content)}
                onReply={(threadId, content) => void submitReply(threadId, content)}
              />
            </div>
          )
        ) : (
          <>
          {(formatOpen || taskPanelOpen || commentsOpen) && (
          <div className="editor-right">
            {/* M7b-R6：右列默认不渲染（需求方裁定「默认右侧不要有弹出」）——格式按钮开样式面板、
                插入菜单「评论」项开评论面板；评论面板头部带 × 关闭。M6 Task 2 的常驻裁决就此改道。 */}
            {formatOpen && doc && um && (
              <RichPanel
                doc={doc}
                fileId={fileId}
                nodeId={selectedNodeId ?? ''}
                selected={selectedSnapshot}
                afterUserWrite={afterUserWrite}
                showToast={showToast}
                onClose={() => setFormatOpen(false)}
              />
            )}
            {/* 任务面板（M7c-C4）：与格式同列互斥（开任务收格式），评论面板可共存（纵排） */}
            {taskPanelOpen && doc && (
              <TaskPanel
                doc={doc}
                fileId={fileId}
                nodeId={selectedNodeId ?? ''}
                selected={selectedSnapshot}
                docVersion={tick}
                presence={members}
                afterUserWrite={afterUserWrite}
                showToast={showToast}
                onOpenMarkers={() => openMarkerPanel('icon')}
                onDelete={() => handleDelete('context')}
                onClose={() => setTaskPanelOpen(false)}
              />
            )}
            {commentsOpen && (
              <div className="editor-comments-pane" data-testid="comment-pane">
                <div className="editor-comments-head">
                  <span className="editor-comments-title">评论</span>
                  <button
                    data-testid="comment-pane-close"
                    className="editor-comments-close"
                    title="关闭评论"
                    aria-label="关闭评论"
                    onClick={() => setCommentsOpen(false)}
                  >
                    ×
                  </button>
                </div>
                <CommentPanel
                  threads={comments.threads}
                  filterNodeId={commentFilter}
                  selectedNodeId={selectedNodeId}
                  onClearFilter={() => setCommentFilter(null)}
                  onLocate={locateNode}
                  onAddComment={(content) => void submitComment(content)}
                  onReply={(threadId, content) => void submitReply(threadId, content)}
                />
              </div>
            )}
          </div>
          )}
          </>
        )}
      </div>

      {/* 画布右键菜单：表格视图不渲染（M7a-T4，画布专属浮层随视图隐藏） */}
      {!readOnly && contextMenu && view === 'mind' && (
        <div
          className="context-menu"
          data-testid="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {contextMenu.summaryId ? (
            /* 概要菜单（M6 T6）：右键 bracket 弹出，与节点菜单互斥 */
            <button data-testid="menu-remove-summary" onClick={() => runMenuAction('remove-summary')}>
              删除概要
            </button>
          ) : (
            ([
              // 任务设置（M7c-C3）：置顶项（需求方裁定），弹出任务快速卡
              ['task-quick', '任务设置'],
              ['insert-child', '插入子级'],
              ['insert-sibling', '插入同级'],
              ['add-summary', '添加概要'],
              ['toggle-collapse', '折叠/展开'],
              ['copy', '复制'],
              ['cut', '剪切'],
              ['paste', '粘贴'],
              ['delete', '删除'],
            ] as const).map(([action, label]) => (
              <button
                key={action}
                data-testid={`menu-${action}`}
                onClick={() => runMenuAction(action)}
              >
                {label}
              </button>
            ))
          )}
        </div>
      )}

      {/* 节点标记迷你选盘（M7b-W3 #4 点击换组）：徽章点击弹出该组值网格（HTML 层
          锚定点击点，视口内钳制），当前值高亮；同值=移除、他值=single 替换/multi
          叠加；Esc/外点关。目标节点已删不渲染；表格视图不渲染（画布专属浮层）。 */}
      {!readOnly && markerPicker && view === 'mind' && pickerSnapshot && (
        <div
          className="marker-picker"
          data-testid="marker-picker"
          style={{ left: pickerLeft, top: pickerTop }}
          role="menu"
          aria-label={`${MARKER_GROUP_LABELS[markerPicker.group]}选择`}
        >
          <div className="marker-picker-head">
            <em className="marker-picker-label">{MARKER_GROUP_LABELS[markerPicker.group]}</em>
            <button
              type="button"
              data-testid="marker-picker-close"
              className="marker-picker-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => setMarkerPicker(null)}
            >
              ×
            </button>
          </div>
          <div className="marker-grid">
            {(MARKER_CATALOG[markerPicker.group] as readonly MarkerGlyphDef[]).map((def) => {
              const current = pickerSnapshot.icons?.[markerPicker.group] ?? [];
              const active = current.includes(def.value);
              return (
                <button
                  key={def.value}
                  type="button"
                  data-testid={`marker-picker-value-${def.value}`}
                  title={def.label}
                  aria-label={def.label}
                  aria-pressed={active}
                  className={active ? 'marker-btn active' : 'marker-btn'}
                  onClick={() => applyPickerValue(def.value)}
                >
                  <MarkerChip def={def} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 任务快速设置弹层（M7c-C3）：右键菜单「任务设置」/`, 快捷键双入口；fixed 锚定
          点击点/节点右缘、视口钳制（组件内），Esc/外点关（页面侧监听）；目标节点已删
          不渲染；表格视图不渲染（画布专属浮层）。 */}
      {!readOnly && quickCard && view === 'mind' && doc && (
        <TaskQuickCard
          doc={doc}
          fileId={fileId}
          nodeId={quickCard.nodeId}
          docVersion={tick}
          anchor={{ x: quickCard.x, y: quickCard.y }}
          presence={members}
          afterUserWrite={afterUserWrite}
          showToast={showToast}
          onMoreMarkers={() => {
            setQuickCard(null);
            openMarkerPanel('icon');
          }}
          onClose={() => setQuickCard(null)}
        />
      )}

      {/* 底栏（画布专属：适应画布/缩放）：表格视图隐藏（M7a-T4） */}
      {view === 'mind' && (
        <footer className="editor-bottombar">
        {/* 显式无参调用：onClick 直传会把 click 事件当 maxScale（number 形参） */}
        <button data-testid="fit-btn" onClick={() => fitCanvas()}>
          适应画布
        </button>
        <select
          data-testid="zoom-select"
          aria-label="缩放档位"
          value={ZOOM_PRESETS.includes(zoomPct) ? String(zoomPct) : ''}
          onChange={(e) => {
            const pct = Number(e.target.value);
            if (pct > 0) zoomToPreset(pct);
          }}
        >
          <option value="">档位</option>
          {ZOOM_PRESETS.map((p) => (
            <option key={p} value={String(p)}>
              {p}%
            </option>
          ))}
        </select>
        <button data-testid="zoom-out" onClick={() => zoomBy(1 / 1.2)}>
          -
        </button>
        <span className="zoom-pct" data-testid="zoom-pct">
          {zoomPct}%
        </span>
        <button data-testid="zoom-in" onClick={() => zoomBy(1.2)}>
          +
        </button>
        <span className="node-count" data-testid="node-count">
          {nodeCount} 节点
        </span>
      </footer>
      )}

      {toast && (
        <div className="editor-toast" data-testid="toast" role="alert">
          {toast}
        </div>
      )}

      <VersionPanel
        fileId={fileId}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        showToast={showToast}
      />
      {/* 文档动态面板（M6 Task 8）：events 只读流抽屉，开面板时拉取（ThemePanel 模式） */}
      <ActivityPanel
        fileId={fileId}
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
      />
      <MemberPanel
        members={members}
        ownerUserId={ownerUserId}
        open={membersOpen}
        onClose={() => {
          setMembersOpen(false);
          setMembersFocus(null); // 关闭清空定位目标（下次打开不复用，M6 T9 修复轮）
        }}
        fileId={fileId}
        canInvite={meId !== '' && meId === ownerUserId}
        showToast={showToast}
        focusUserId={membersFocus}
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* 主题/结构面板已迁入工具栏各自锚定 wrap（2026-09-30 需求方反馈任务 1：
          企微式按钮正下方贴靠下拉），此处的 fixed 右上挂载点随之移除。 */}
      {/* 查找替换条（M6 Task 3）：画布顶部浮层，开关/键位在页面侧；定位复用 locateNode
          （selectOnly + 展开折叠祖先，与评论面板同一语义）；移动端只读不装配；
          表格视图隐藏（查找需求由表格筛选条承接，M7a-T4） */}
      {!readOnly && view === 'mind' && (
        <FindReplace
          doc={doc}
          open={findOpen}
          onClose={() => setFindOpen(false)}
          onLocate={locateNode}
          afterUserWrite={afterUserWrite}
          showToast={showToast}
        />
      )}
      <span hidden>{tick}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// core → engine 适配器（模块级纯函数，绑定 doc）
// ---------------------------------------------------------------------------

/** 剪贴板错误 → 用户文案（M1a 准入欠账，M1 验收修复轮补齐）：
 * engine clipboard 抛 Error('TEXT_TOO_LONG')/'PARENT_INVALID' 与 children 形状
 * TypeError，直出 e.message 对用户不可读，按错误码映射；其余维持原文案。 */
function clipboardErrorMessage(e: unknown): string {
  if (e instanceof TypeError) return '剪贴板内容格式无效';
  const msg = e instanceof Error ? e.message : '';
  if (msg === 'TEXT_TOO_LONG') return '节点文本长度已达上限';
  if (msg === 'PARENT_INVALID') return '粘贴目标无效';
  return e instanceof Error ? e.message : '操作失败';
}

/** @gmind/core 读 API → engine DocReader（summaries 供概要 bracket 布局，M6 T6）。 */
function readerOf(d: Y.Doc): DocReader {
  return {
    getMeta: () => getMeta(d),
    getNode: (id) => getNode(d, id),
    childrenIds: (id) => childrenIds(d, id),
    summaries: () => listSummaries(d),
  };
}

/** @gmind/core 写 API → engine IDocHandle（origin 缺省 ORIGIN_USER）。 */
function handleOf(d: Y.Doc): IDocHandle {
  return {
    ...readerOf(d),
    addChild: (parentId, opts, origin) => addChild(d, parentId, opts, origin ?? ORIGIN_USER),
    setText: (id, text, origin) => setText(d, id, text, origin ?? ORIGIN_USER),
    setNote: (id, note, origin) => setNote(d, id, note, origin ?? ORIGIN_USER),
    setDescription: (id, text, origin) => setDescription(d, id, text, origin ?? ORIGIN_USER),
    setHref: (id, href, origin) => setHref(d, id, href, origin ?? ORIGIN_USER),
    setImage: (id, image, origin) => setImage(d, id, image, origin ?? ORIGIN_USER),
    setIcon: (id, group, value, origin) =>
      setIcon(d, id, group as IconGroup, value, origin ?? ORIGIN_USER),
    setStyle: (id, patch, origin) => setStyle(d, id, patch, origin ?? ORIGIN_USER),
    // custom 透传（engine 剪贴板粘贴路径）：先按目标文档 schema 过滤（未知列/类型
    // 不符静默丢弃——core sanitizeCustomForDoc 单源，页面不做目录判断），再逐键经
    // setCustomField 落写（过滤后必合法不抛，粘贴不因跨文档未知列半途失败）。
    setCustomFields: (id, custom, origin) => {
      const sanitized = sanitizeCustomForDoc(d, custom);
      if (sanitized === null) return;
      for (const [colId, value] of Object.entries(sanitized)) {
        setCustomField(d, id, colId, value, origin ?? ORIGIN_USER);
      }
    },
  };
}
