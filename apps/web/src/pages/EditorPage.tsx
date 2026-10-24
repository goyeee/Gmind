import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type * as Y from 'yjs';
import {
  addChild,
  assigneeEntriesOf,
  capUndoStack,
  canvasIdOfNode,
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
  PROGRESS_STAGE_PCT,
  progressStageOf,
  redo as coreRedo,
  removeSummary,
  resolveCanvasId,
  ROOT_NODE_ID,
  rootIdOf,
  setCustomField,
  setDocMeta,
  setDescription,
  setImage,
  setIcon,
  moveImage,
  setNodeSide,
  setNodeTask,
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
  type Direction,
  layout,
  type LayoutResult,
  MARKER_CATALOG,
  MARKER_GROUP_LABELS,
  type MarkerGlyphDef,
  type NodeBox,
  navigate as navigateGeometry,
  type NodeVisual,
  getLastImage,
  setLastImage,
  imagePlacementOf,
  type ImagePlacement,
  pasteNodes,
  pasteText,
  readFromSystemClipboard,
  renderScene,
  colorForUser,
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
  type ViewportState,
} from '@gmind/engine';
import { todayStr } from '@gmind/shared';
import { attachKeyboardMap, isEditableTarget, resolveDirectEditKey } from '../editor/keyboardMap';
import { rootKidEffectiveSides, rootSiblingForceSide } from '../editor/rootSiblingSide';
import { nextChildText } from '../editor/defaultNodeText';
import { avatarSrcOf, assigneeRowsOf } from '../editor/TaskFields';
import { buildThumbSvg, invalidateThumb } from '../editor/thumbnail';
import { ActivityPanel } from '../editor/ActivityPanel';
import { ThemePanel } from '../editor/ThemePanel';
import {
  ActivityIcon,
  BackIcon,
  ExportIcon,
  FullscreenIcon,
  HistoryIcon,
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
  imageFileFromClipboard,
  MAX_IMAGE_BYTES,
  readImageSize,
  toPngBlob,
  uploadImage,
} from '../editor/imageUpload';
import {
  createImageHandleLayer,
  imageSceneRect,
  renderImageFocusOutline,
  renderImageHandles,
  resizeImageSizeByDelta,
  type ImageCorner,
  type ImageRect,
} from '../editor/imageHandles';
import {
  createImageDragLayer,
  findNodeAt,
  guideLayoutOf,
  placementAt,
  renderImageDrop,
} from '../editor/imageDrag';
import { ImagePreview } from '../editor/ImagePreview';
import { HelpPanel } from '../editor/HelpPanel';
import { MarkerChip } from '../editor/MarkerChip';
import { MemberPanel } from '../editor/MemberPanel';
import { RichPanel } from '../editor/RichPanel';
import { StructurePanel, type StructureTypeValue } from '../editor/StructurePanel';
import { TaskTable } from '../editor/TaskTable';
import { TaskPanel } from '../editor/TaskPanel';
import { useTaskMembers, deriveNodesOfDoc } from '../editor/TaskFields';
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
import { CanvasTabBar } from '../editor/CanvasTabBar';
import {
  canvasIdPrefix,
  handleOf,
  readerOf,
  useActiveCanvas,
  type CanvasSwitchDeps,
} from '../editor/useActiveCanvas';
import { useIsMobileViewport } from '../editor/useIsMobileViewport';
import { exportXmind } from '../editor/xmind-export';
import { exportImage } from '../editor/image-export';
import { track } from '../api/events';
import { api, apiPost, clearToken } from '../api/client';
import './editor.css';
import '../editor/marker-picker.css';
import '../editor/image-preview.css';

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
 * M7b-W3（2026-09-29，企微对标二批交互）：标记面板重做为企微式锚定竖层
 * + 批量标记（多选全含则移除否则设置，单事务）；
 * 节点标记徽章点击换组（同组迷你选盘浮层）；空白无修饰左拖=框选（原 Shift+左拖，
 * 平移改道空格+左拖/中键，Viewport 自理）。
 *
 * 2026-10-10 需求方裁定包（spec 2026-10-10-node-props-and-task-visual-design）：
 * ① 工具栏「插入」菜单整体删除（5 条目全删；链接/图片走格式面板既有入口、评论走
 * comment-toggle；MarkerPanel 改 fixed 视口锚定，入口=TaskPanel「在标记面板中
 * 编辑」）；② 再点已选中节点开 TaskPanel（mindgrid 同款），右键「任务设置」/
 * TaskQuickCard/`,` 快捷键全删；③ 格式/任务面板改判外点即关（点节点不关、跟随
 * 选中，点空白关闭）；④ 节点任务视觉对齐 mindgrid（footer 左负责人文字/右百分比，
 * 预期日期盒右上角外侧悬浮 chip——engine 侧，见 taskvisual.ts 头注）。
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
  // 创建者标识依据（M2 Task 6，FR-COL-005）：GET /api/files/:id 扩展字段
  const ownerUserId = state?.ownerUserId ?? null;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const sceneRef = useRef<SceneRoot | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const selectionRef = useRef<SelectionModel | null>(null);
  // 图片聚焦选中（2026-10-20 需求方「点图片显示图片轮廓、点文字显示整节点轮廓」）：
  // 只记「最近一次点击落在图片上」的节点 id；选区不匹配/图被移除时自动失效
  // （applySelectionClasses 校验）。同 id 再点 selectOnly 不 emit，需显式重刷类。
  const imageFocusRef = useRef<string | null>(null);
  const applySelectionClassesRef = useRef<(() => void) | null>(null);
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

  // —— 画布状态中枢（多画布计划三 Task 1）——
  // activeCanvasId 本地视图态的唯一事实源在 useActiveCanvas（meta.activeCanvasId 仅
  // 作 LWW 持久化，远端改写不强拽本地视图）；此处只做视图侧接线：闭包全部只读 ref /
  // 稳定单例（overlay），useMemo 空依赖保 controller 不因重渲染重建（UM 缓存与视口
  // 存档随之保全）。rebuildForCanvas 经 canvasRebuildRef 桥到装配 effect 内的
  // rebuildScene（装配晚于本 hook 创建，未装配时 no-op——首装由装配 effect 按
  // activeCanvasIdRef 直接绑定，不经切换编排）。
  const canvasRebuildRef = useRef<((saved: ViewportState | null) => void) | null>(null);
  const canvasSwitchDeps = useMemo<CanvasSwitchDeps>(
    () => ({
      captureViewport: () => viewportRef.current?.getState() ?? null,
      rebuildForCanvas: (_canvasId, saved) => {
        canvasRebuildRef.current?.(saved);
      },
      // discardInlineEdit=reconcile 回退路径（旧画布已被删成墓碑）：行内编辑**丢弃**
      // 不提交——提交写按 activeCanvasIdRef（仍指墓碑画布）解析画布抛
      // CANVAS_NOT_FOUND，异常在 Y 观察器回调内无捕获会中断回退编排（Important 修复）。
      resetEphemeral: (discardInlineEdit = false) => {
        if (overlay.isOpen) overlay.close(!discardInlineEdit); // true=提交落旧画布
        // 未开编辑的 pending 新建：作废弃置不回收（同「Tab 后点了别处」口径）
        pendingEditRef.current = null;
        pendingCancelRef.current = null;
        selectionRef.current?.clear(); // 清空选区（onChange 顺带重刷类+广播空选区）
        imageFocusRef.current = null;
        setEditingClass(null);
      },
    }),
    [],
  );
  const { um, activeCanvasId, canvases, activeCanvasIdRef, umRef, switchCanvas, refresh } =
    useActiveCanvas(doc, canvasSwitchDeps);
  /** 全部读/写路径的当帧画布透传源（空串 = 未装配 → 走 core 缺省解析回退链）。 */
  const canvasIdGetter = (): string | undefined => activeCanvasIdRef.current || undefined;

  // dev-only 性能压测钩子（e2e/perf-editor.spec.ts 专用）：页面上下文经
  // window.__gmind.getDoc() 取活动 doc 实例（脚本另用 /@id/@gmind/core 动态导入
  // 复用页面同一模块实例）。import.meta.env.DEV 在生产构建为 false，本副作用被剔除。
  // 多画布（计划三 Task 1）：__gmind 增 switchCanvas——画布切换编排的 e2e/调试
  // 入口，与后续页签条同一通道。
  useEffect(() => {
    if (!import.meta.env.DEV || !doc) return;
    (window as unknown as {
      __gmind?: { getDoc: () => Y.Doc; switchCanvas: (canvasId: string) => void };
    }).__gmind = {
      getDoc: () => doc,
      switchCanvas,
    };
    return () => {
      delete (window as unknown as { __gmind?: unknown }).__gmind;
    };
  }, [doc, switchCanvas]);
  // collab 句柄 ref：afterUserWrite / selection.onChange 需要在装配完成后回调
  // （markEditing / setSelection），时序晚于 startCollab 的调用点。
  const collabHandleRef = useRef<CollabHandle | null>(null);
  // 在线成员（FR-COL-005）：collab onPresence 推进；成员面板开合。
  const [members, setMembers] = useState<PresenceMember[]>([]);
  const [membersOpen, setMembersOpen] = useState(false);
  // 头像点击定位目标（M6 Task 9 评审修复轮）：随面板打开传给 MemberPanel——滚动
  // 目标成员行进视口并短时高亮。members-btn 打开置 null（无定位目标）；面板关闭
  // 时清空（下次普通打开不复用旧目标）。注：头像栏随 2026-10-11 裁定退役，本
  // 定位管线暂无 UI 触发入口，保留为面板能力。
  const [membersFocus, setMembersFocus] = useState<string | null>(null);
  // 个人中心（2026-10-11 需求方裁定：顶栏最右 = [成员钮][本人头像]）：本人身份
  // 经 GET /users/me 拉取（昵称/手机号，presence 自有身份仅用于首字符兜底）；
  // 下拉含返回工作台/退出登录（复用工作台 logout 范式）。
  const [me, setMe] = useState<{ id: string; nickname: string; phone: string | null } | null>(null);
  const [personalOpen, setPersonalOpen] = useState(false);
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
  // wrap 下（同 export-wrap 贴按钮下拉先例）。ref 供渲染期实测 wrap
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
  // 图片缩放手柄（2026-10-15 需求方「拖拽图片周边改尺寸」）：层挂在 g.gm-viewport 内
  // （场景坐标，自动跟随平移/缩放），尺寸按 1/scale 补偿保持屏幕像素恒定。
  const imageHandleLayerRef = useRef<SVGGElement | null>(null);
  // 装配后手柄同步入口 ref（缩放不触发重排，syncZoom 需主动刷新手柄尺寸）。
  const syncImageHandlesRef = useRef<(() => void) | null>(null);
  // 图片拖拽换位层（2026-10-20 图文四槽位）：拖拽 ghost + 四侧引导带。
  // 同样挂在 g.gm-viewport 内最上层（场景坐标），尺寸按 1/scale 补偿。
  const imageDragLayerRef = useRef<SVGGElement | null>(null);
  // 拖拽中的源图（null = 未拖）：松手时一次落库（同节点改 placement 或跨节点 moveImage）。
  const imageDragRef = useRef<{
    nodeId: string;
    key: string;
    w: number;
    h: number;
    placement: ImagePlacement;
    pointerId: number;
    /** 按下时的屏幕坐标：位移超过阈值才真正起拖，短按仍走点击/双击。 */
    startClientX: number;
    startClientY: number;
    /** false = 已按下但尚未越过阈值（不画 ghost/引导，不捕获指针）。 */
    active: boolean;
  } | null>(null);
  // 拖拽中的状态（null = 未在拖）：起始尺寸/起始指针场景坐标/最后写出的尺寸。
  const imageResizeRef = useRef<{
    nodeId: string;
    key: string;
    placement?: ImagePlacement;
    corner: ImageCorner;
    pointerId: number;
    w0: number;
    h0: number;
    startX: number;
    startY: number;
    /** 本帧待写尺寸（rAF 节流：每帧最多一次 setImage，方案甲）。 */
    pending: { w: number; h: number } | null;
    /** 已写出的尺寸（决定 pointerup 是否需要补写/是否进撤销栈）。 */
    written: { w: number; h: number } | null;
    raf: number;
  } | null>(null);
  // 大图预览（双击图片）：存 /api/images/{key}（服务端直出原图，不缩放）与源节点 id
  // （预览内右键「复制图片」复用节点图片复制链路，保留文档内 payload）。
  const [imagePreview, setImagePreview] = useState<{ src: string; nodeId: string } | null>(null);
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
  // 负责人显示名目录（2026-10-10 mindgrid 对齐：节点 footer 文字名取代色点）：
  // 渲染期派生（协作者 ∪ presence ∪ 文档内既有负责人），随 nodeData 透传 engine，
  // 不入 Yjs 文档。tick = 文档版本号（TaskPanel docVersion 同口径）驱动重建。
  const docOwnerIds = useMemo(() => {
    if (!doc) return [] as string[];
    const ids: string[] = [];
    for (const n of deriveNodesOfDoc(doc, canvasIdGetter())) {
      for (const o of n.task?.owners ?? []) if (!ids.includes(o)) ids.push(o);
    }
    return ids;
  }, [doc, tick, activeCanvasId]);
  const memberIndex = useTaskMembers(fileId, members, docOwnerIds);
  const memberIndexRef = useRef(memberIndex);
  memberIndexRef.current = memberIndex;
  // 成员目录异步就绪（协作者拉取返回/presence 变化）→ 画布补一轮重绘刷新节点名字
  useEffect(() => {
    scheduleRerenderRef.current?.();
  }, [memberIndex]);
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
  // 2026-10-10 需求方裁定：再点已选中节点也开本面板（取代已删除的右键「任务设置」
  // 快速卡——TaskQuickCard/`,` 快捷键/quickCard 态全链路退役）。
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  // 节点标记点击换组（M7b-W3 #4）：徽章命中 → 该组迷你选盘浮层（HTML 层锚定点击点，
  // contextMenu 同款 fixed 定位；nodeId/group 为写入目标，x/y 为弹出锚点）。
  // （标记面板 MarkerPanel 弹层已随 2026-10-10「任务面板标记内嵌化」裁定退役，
  //  目录编辑改在 TaskPanel 区块内完成。）
  const [markerPicker, setMarkerPicker] = useState<{
    nodeId: string;
    group: IconGroup;
    x: number;
    y: number;
  } | null>(null);
  // 人员进度/负责人头像选盘（2026-10-11/12 裁定）：点击节点任务行成员头像 → 9 档
  // 选盘快速更新进度（对齐 A 的进度徽章交互标杆）。mode=assignee 写人员列
  // （setCustomField 整值替换）；mode=owner 写标准负责人进度（setNodeTask）。
  const [assigneePicker, setAssigneePicker] = useState<{
    mode: 'assignee' | 'owner';
    nodeId: string;
    user: string;
    colId?: string;
    /** 所属列名（2026-10-13 需求方反馈：选盘头部显示列名——前端/测试…，让人知道
     *  这位成员归哪列）；mode=owner 无列语义，固定「负责人」。 */
    colName?: string;
    name: string;
    avatar: string;
    progress: number;
    x: number;
    y: number;
  } | null>(null);
  // 右键菜单（Task 12）：nodeId 为节点菜单锚点；summaryId 为概要菜单锚点（M6 T6，
  // 二者互斥——右键命中 bracket 时弹概要菜单，命中节点时弹节点菜单）
  const [contextMenu, setContextMenu] = useState<
    | { x: number; y: number; nodeId: string; image?: boolean; summaryId?: undefined }
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

  // （标记面板弹层的 Esc/外点关闭链已随 2026-10-10「任务面板标记内嵌化」裁定退役：
  //  MarkerPanel 无入口整体删除，标记编辑在 TaskPanel 区块内联完成。）

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

  // —— 人员进度选盘（2026-10-11 第二步）Esc/外点关闭——与迷你选盘同机制（pointerdown，
  // 画布 mousedown 被抑制口径同注）；.gm-task-assignee 豁免：选盘开着点头像时先收盘、
  // 紧随 click 又 toggle 重开 → 闪关重弹——开合交给 onSvgClick 的 toggle 分支。 ——
  useEffect(() => {
    if (!assigneePicker) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      if (!(e.target as Element | null)?.closest?.('.assignee-picker, .gm-task-assignee, .gm-task-owner-avatar')) {
        setAssigneePicker(null);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAssigneePicker(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [assigneePicker]);

  // 任务快速设置弹层（M7c-C3）已随 2026-10-10 裁定整体退役（需求方：右键「任务设置」
  // 去除，由「再点已选中节点 → TaskPanel」取代——见文件头注与 spec
  // 2026-10-10-node-props-and-task-visual-design）：TaskQuickCard 组件、`,` 快捷键、
  // openQuickCard 全链路删除。

  // 只读降级 / 切表格视图面板强制收（写弹层不跨视图驻留）
  useEffect(() => {
    if (readOnly && taskPanelOpen) setTaskPanelOpen(false);
    // 结构面板随桌面工具栏装配：只读降级即收（按钮已不装配，面板不留存）
    if (readOnly && structurePanelOpen) setStructurePanelOpen(false);
  }, [readOnly, taskPanelOpen, structurePanelOpen]);

  // —— 工具栏弹层统一外点关闭（2026-09-28 需求方走查：插入/主题/成员/版本/动态/
  // 快捷键/查找/格式/任务/评论点其他地方必须自动消失）——导出/插入/标记已有各自
  // wrapRef 外点监听（上方 4 处 effect，不动），此处收拢其余面板：任一开启即挂
  // document pointerdown，命中豁免区（面板容器 / 带 data-popover-toggle 的切换
  // 按钮——按钮豁免让 pointerdown 不抢先关闭、onClick toggle 正常收起）之外全部
  // 收起。容器口径：右列 .editor-right 整体豁免（评论 pane 关闭按钮与面板内部
  // 交互不受影响）；浮层面板按各自根类名（member-panel/version-panel/theme-panel/
  // activity-panel/help-panel/find-bar）。
  useEffect(() => {
    // 格式/任务右列（需求方 2026-10-09 裁定）**不参与外点关闭**：点击画布空白仅清
    // 选区（面板转空态），面板常驻至显式关闭（自身按钮/工具栏互斥 toggle/只读强
    // 制收）。其余弹层维持外点即关。
    const anyOpen =
      membersOpen ||
      versionsOpen ||
      activityOpen ||
      helpOpen ||
      findOpen ||
      themePanelOpen ||
      structurePanelOpen ||
      commentsOpen ||
      personalOpen ||
      formatOpen ||
      taskPanelOpen;
    if (!anyOpen) return;
    const onDocPointerDown = (e: PointerEvent): void => {
      const el = e.target as Element | null;
      if (!el?.closest) return;
      // 导出菜单内部（含「链接/图片」等右列联动菜单项）豁免：菜单项点击的
      // pointerdown 若在此收掉 formatOpen，紧随的 click 再开会出现一帧收-开抖动，
      // 且聚焦时序与互斥语义纠缠（E3 回归修复）——菜单自身的开合由各自监听管理。
      // 结构/主题面板 wrap（2026-09-30 任务 1）：面板已挂 .structure-wrap/.theme-wrap
      // 下，wrap 整体豁免（面板根类 .structure-panel/.theme-panel 亦在下方豁免清单，
      // 双保险防 wrap 与面板之间的 6px 间隙点击误收）。
      if (
        el.closest('[data-popover-toggle]') ||
        el.closest(
          '.editor-right, .editor-mobile-comments, .theme-panel, .structure-panel, .theme-wrap, .structure-wrap, .activity-panel, .help-panel, .find-bar, .member-panel, .version-panel, .marker-panel, .personal-menu, .gm-task-assignee, .gm-task-owner-avatar, .assignee-picker',
        ) ||
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
      setCommentsOpen(false);
      // 格式/任务面板外点即关（2026-10-10 需求方改判 10-09「点空白转空态不关闭」）：
      // 点**画布空白**关闭；点节点不关（面板跟随选中切换内容，同 mindgrid 属性面板——
      // 否则「再点开面板」路径下换选节点会把面板收掉）。
      if (!el.closest('[data-node-id]')) {
        setFormatOpen(false);
        setTaskPanelOpen(false);
      }
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
    commentsOpen,
    personalOpen,
    formatOpen,
    taskPanelOpen,
  ]);

  // —— 个人中心下拉（2026-10-11）：Esc 关闭（外点关闭走统一 effect 上方）。 ——
  useEffect(() => {
    if (!personalOpen) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPersonalOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [personalOpen]);

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

  /**
   * （applyMarker 批量标记写入已随 2026-10-10「任务面板标记内嵌化」裁定退役——
   *  MarkerPanel 弹层删除后无消费方；TaskPanel 内嵌行单节点直写 setIcon、迷你选盘
   *  applyPickerValue 保留画布徽章点击换组入口。）
   */

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

  /** 人员进度/负责人选盘写回（2026-10-11/12 裁定）：档位百分比 → mode 分支——
   *  assignee 写人员列（setCustomField 整值替换，校验先于事务在 core 内）；
   *  owner 写标准负责人进度（setNodeTask{progress}，进度徽章联动保留——画布
   *  徽章已退役写而不画）；完成后关盘。 */
  const applyAssigneePickerValue = (pct: number): void => {
    const p = assigneePicker;
    const d = doc;
    if (!p || !d) return;
    try {
      if (p.mode === 'owner') {
        if (pct !== (getNode(d, p.nodeId)?.task.progress ?? 0)) {
          setNodeTask(d, p.nodeId, { progress: pct }, ORIGIN_USER);
          afterUserWrite();
        }
      } else {
        const current = getNode(d, p.nodeId)?.custom?.[p.colId ?? ''];
        const base: Record<string, { progress: number; weight?: number }> =
          typeof current === 'object' && current !== null && !Array.isArray(current)
            ? { ...(current as Record<string, { progress: number; weight?: number }>) }
            : {};
        base[p.user] = { progress: pct };
        setCustomField(d, p.nodeId, p.colId ?? '', base, ORIGIN_USER);
        afterUserWrite();
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : '进度更新失败，请调整后重试');
    } finally {
      setAssigneePicker(null);
    }
  };

  // 插入菜单的右面板聚焦助手（focusRichControl/openRichAndFocus/triggerImageInput）
  // 已随 2026-10-10「插入」菜单删除一并退役——链接/图片编辑走格式面板内既有控件。

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
    // 经 umRef 取当帧画布 UM：afterUserWrite 被装配 effect 闭包（拖拽 onDrop、
    // 键盘映射）持有，读 um state 会捕获装配当帧的旧画布 UM——切换后这些路径
    // 持续裁剪旧画布栈、新画布 UM 逃逸栈深上限（FR-EDT-004 修复）。
    const m = umRef.current;
    if (m) capUndoStack(m);
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
    // 缩放手柄的屏幕像素补偿（1/scale）随缩放刷新：缩放不触发 doc 更新/重排，
    // 不主动刷会让手柄在 400% 下变巨块、25% 下看不见。
    syncImageHandlesRef.current?.();
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
    const folded = countCollapsedWithChildren(doc, canvasIdGetter()); // 当前画布折叠处数（Task 4 item 8）
    if (folded > 0 && !window.confirm(`检测到 ${folded} 处折叠，将自动展开后导出`)) return;
    void exportImage(doc, meta.title, {
      format,
      scale,
      transparent: exportTransparent,
      canvasId: canvasIdGetter(), // 导出范围/文件名 = 当前画布（Task 4 item 8）
    })
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

  /** 定位到中心（需求方 2026-10-09）：保持当前缩放，把中心主题平移到画布中心。
   *  居中同式 fitCanvas(maxScale) 分支——按 root 盒单点化：tx' = vw/2 − cx×s
   *  （panBy 补差值）；root 盒缺失（空布局竞态）静默 no-op。 */
  const centerRoot = (): void => {
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!vp || !svgEl) return;
    // 多画布（Task 4 item 2）：定位目标 = 当前画布 root 盒（boxesRef 即当前画布布局）
    const box = boxesRef.current.find((b) => b.id === (doc ? rootIdOf(doc, canvasIdGetter()) : ROOT_NODE_ID));
    if (!box) return;
    const s = vp.scale;
    vp.panBy(
      svgEl.clientWidth / 2 - (box.x + box.w / 2) * s - vp.tx,
      svgEl.clientHeight / 2 - (box.y + box.h / 2) * s - vp.ty,
    );
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

  /** 主选中节点：恰好单选返回该节点，否则以当前画布 root 为操作锚点
   *  （多画布 Task 4 item 1：rootIdOf(doc, activeCanvasId)，异根画布不再锚 'root'）。 */
  const primaryId = (): string => {
    const selection = selectionRef.current;
    if (selection && selection.selected.size === 1) {
      const [id] = selection.selected;
      return id;
    }
    return doc ? rootIdOf(doc, canvasIdGetter()) : ROOT_NODE_ID;
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
   * （root 下「分支主题 N」、其余「子主题 N」，2026-10-09 裁定，规则单源
   * defaultNodeText.nextChildText）同事务写入，节点落位即可见有语义。等用户
   * 敲下第一个可打印字符时才由 keydown effect 补开编辑框（openPendingEditor），
   * 该字符/IME 组字直接落进编辑框。取消语义：Esc 直接回收（pendingCancelRef →
   * removeIfAlive）；「新建后敲字又全删」的空提交同走回收（openPendingEditor
   * onCommit）。撤销语义：建节点（含默认文本）一笔事务、敲字提交再一笔——一次
   * Ctrl+Z 撤回默认文本、两次删节点（编辑器惯例；用例 4 断言「新节点文本消失」
   * 仍成立）。
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
    // 默认名序号计算在事务外（校验先于事务纪律：nextChildText 纯读同级存活兄弟
    // 的最大序号，事务内只执行已验证的写）。
    const defaultText = nextChildText(doc, parentId, canvasIdGetter());
    let createdId = '';
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        createdId = addChild(doc, parentId, index === undefined ? {} : { index });
        setText(doc, createdId, defaultText, ORIGIN_USER);
        if (forceSide && parentId === rootIdOf(doc, canvasIdGetter()) && getMeta(doc, canvasIdGetter()).structureType === 'mindmap') {
          setNodeSide(doc, createdId, forceSide);
        }
        if (relation === 'parent' && nodeToOutdent) moveNode(doc, nodeToOutdent, createdId);
      });
    } catch (e) {
      showToast(e instanceof Error ? e.message : '新建失败');
      return;
    }
    afterUserWrite();
    track('node_add', { via, nodeCount: countAliveReachable(doc, canvasIdGetter()) }, fileId);
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
    // （=本节点）继续新建，pending 被新节点覆盖、旧节点保留默认文本（企
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
   * 默认文本现状；回收闭包在关闭路径一律作废（提交后节点已是常驻节点，不可再
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
        // 取消不回收：文本没变（保留默认文本），仅作废回收闭包
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
        // 编辑框且**不 preventDefault**（空格替换全选的默认文本，原语义不变）。
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
   * 矩阵的左列分支）＋ 同日二次裁定（右满强制左的触发收窄——左下角 bug 修复）：
   * - root 上 Enter/Tab 降级新建子级（现状不变）：addChild 按右列配额自动定侧——右列
   *   未满 3 append 落右列底部，满后 append 落左列顶部（布局左列视觉反序：文档序末位
   *   = 视觉最高位，往左上角生长，围绕中心顺时针）。
   * - root 上 Shift+Enter（逆时针镜像）：左列未满 3 落左列、否则右列；插到该列首个
   *   同侧子级文档位之前（左列=视觉列底自上往下长、右列=视觉列顶自下往上长——与
   *   Enter 完全反向）。logic/org（单侧/无侧结构）维持降级现状。
   * - 二级主题（parent===root，mindmap）：索引全层级统一——Enter=文档序后插、
   *   Shift+Enter=前插；布局左列视觉反序下天然涌现「右列 Enter 向下/左列 Enter 向上」
   *   （顺时针），Shift+Enter 全部反向。侧别经 rootSiblingForceSide（规则单源）：
   *   ① 右满 3 + 左列空 + 文档序末位分支 Enter → 左（顺时针开启左列）；
   *   ② 其余（含右满时的非末位右分支）→ 所按分支有效侧，紧挨其下方同侧落位。
   * - logic（全右单侧）与 org、更深层级维持现状（Enter 下方）。
   */
  const handleEnter = (reverse = false): void => {
    if (!doc) return;
    const current = primaryId();
    const snap = getNode(doc, current);
    if (!snap || snap.deleted) return;
    const canvasRootId = rootIdOf(doc, canvasIdGetter()); // 当前画布根锚点（Task 4 item 1 消费）
    if (current === canvasRootId) {
      if (reverse && getMeta(doc, canvasIdGetter()).structureType === 'mindmap') {
        // 逆时针：左列未满配额落左列、否则右列；插到该列首个同侧子级文档位之前。
        const kids = getNode(doc, canvasRootId)?.childIds ?? [];
        // 有效侧单源：rootSiblingSide.rootKidEffectiveSides（持久 ?? 索引兜底，与
        // engine assignMindmapSides / core countRightSideRootChildren 的兜底同式）。
        const sides = rootKidEffectiveSides(doc, canvasIdGetter());
        const leftCount = sides.filter((s) => s === 'left').length;
        const side: NodeSide = leftCount < 3 ? 'left' : 'right';
        const firstSameSide = sides.findIndex((s) => s === side);
        openNewNodeEditor(
          canvasRootId,
          firstSameSide === -1 ? kids.length : firstSameSide,
          'child',
          'keyboard',
          undefined,
          side,
        );
      } else {
        // root 无同级：降级为新建子级（顺时针/单侧结构——addChild 自动定侧）
        openNewNodeEditor(canvasRootId, undefined, 'child');
      }
      return;
    }
    const parent = getNode(doc, snap.parentId);
    if (!parent || parent.deleted) return;
    const currentIdx = parent.childIds.indexOf(current);
    // root 级 mindmap 同侧落位（规则单源 rootSiblingForceSide，2026-10-09 二次裁定）：
    // 顺时针触发（右满 3+左空+末位分支 Enter）→ 左（开启左列）；其余 → 所按分支
    // 有效侧（持久 side ?? 索引兜底——旧文档不再被 addChild 计数配额强制换侧，
    // 左下角 bug 修复）。非 root 级/非 mindmap → undefined，addChild 自动定侧接管。
    const forceSide: NodeSide | undefined = rootSiblingForceSide(doc, current, reverse, canvasIdGetter());
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
    if (current === rootIdOf(doc, canvasIdGetter())) {
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
      track('node_delete', { via, nodeCount: countAliveReachable(doc, canvasIdGetter()) }, fileId);
      // 配额拦截的解除通道（M1b 终审裁定）：删除节点即解除新增拦截。若删除后仍
      // 超限，服务端边缘触发器在回落限内前不会重复广播（advisory 残余窗口，登记
      // docs/m2-entry-checklist.md §7.6）。
      quotaBlockedRef.current = nextQuotaBlock(quotaBlockedRef.current, { type: 'deleted' });
      selection.selectOnly(rootIdOf(doc, canvasIdGetter())); // 当前画布根（Task 4 item 1 口径）
      fitPendingRef.current = true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleSelectAll = (): void => {
    if (!doc) return;
    // 多画布 Task 4 item 3：全选范围 = 当前画布子树（rootIdOf 起算 + 同画布读）
    selectionRef.current?.set(subtreeIds(doc, rootIdOf(doc, canvasIdGetter()), canvasIdGetter()));
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
    // structureType 按当前画布读（Task 4 item 2 同口径：navigate 几何作用于当前画布布局）
    const structure = getMeta(doc, canvasIdGetter()).structureType;
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
    const ids = [...selection.selected].filter((id) => id !== rootIdOf(d, canvasIdGetter()));
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
    const ids = [...selection.selected].filter((id) => id !== rootIdOf(doc, canvasIdGetter()));
    if (ids.length === 0) return;
    try {
      await writeToSystemClipboard(copyNodes(readerOf(doc, canvasIdGetter), ids));
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
    const ids = [...selection.selected].filter((id) => id !== rootIdOf(doc, canvasIdGetter()));
    if (ids.length === 0) return;
    try {
      writeToSystemClipboard(
        cutNodes(handleOf(doc, canvasIdGetter), ids, (deleteIds) => {
          if (deleteIds.length === 0) return; // 空删集不上报（防御：上游已滤空）
          deleteNodes(doc, deleteIds, ORIGIN_USER);
          track('node_delete', { via, nodeCount: countAliveReachable(doc, canvasIdGetter()) }, fileId);
          afterUserWrite();
        }),
      );
      selection.selectOnly(rootIdOf(doc, canvasIdGetter())); // 当前画布根（Task 4 item 1 口径）
    } catch (e) {
      showToast(clipboardErrorMessage(e));
    }
  };

  // 内部图片 payload 粘贴的一次性让路标志（2026-10-20）：Ctrl+V 由键盘映射处理
  // lastImage 时置位，紧随其后的原生 paste 事件（图片还躺在系统剪贴板）必须跳过
  // onDocPaste 的上传链路，避免「粘贴图片」被双写（内部 payload + 新上传）。
  const internalImagePasteRef = useRef(false);

  /** 内部图片 payload 粘贴：沿用原 key（同文件）；跨文件经 copy 端点 remap。 */
  const pasteImagePayload = async (
    payload: NonNullable<ReturnType<typeof getLastImage>>,
  ): Promise<void> => {
    const d = doc;
    if (!d) return;
    try {
      const key = await remapImageKey(payload.key);
      setImage(
        d,
        primaryId(),
        {
          key,
          w: payload.w,
          h: payload.h,
          ...(payload.placement !== undefined ? { placement: payload.placement } : {}),
        },
        ORIGIN_USER,
      );
      afterUserWrite();
    } catch (e) {
      showToast(e instanceof Error ? e.message : '图片粘贴失败');
    }
  };

  const handlePaste = async (): Promise<void> => {
    if (!doc) return;
    // 图片 payload 优先（2026-10-20 图片独立复制/剪切）：同文件沿用原 key、不重传；
    // 置一次性让路标志，紧跟的原生 paste 事件不再走上传链路（避免双写）。
    const lastImage = getLastImage();
    if (lastImage) {
      internalImagePasteRef.current = true;
      setTimeout(() => {
        internalImagePasteRef.current = false;
      }, 0);
      await pasteImagePayload(lastImage);
      return;
    }
    if (addBlockedByQuota()) return; // 粘贴会新增节点，同受配额拦截
    const selection = selectionRef.current;
    if (!selection) return;
    // FR-EDT-009（PRD 原文「粘贴目标为当前选中节点的子级」）：单选 → 粘贴为该节点
    // 子级（追加其 children 末尾）；无选中/多选 → 当前画布 root 末尾（Task 4 item 4：
    // 兜底父级 = rootIdOf(doc, activeCanvasId)，异根画布不再锚 'root'——引擎
    // requireValidParent 按画布读，'root' 在非首画布不存在会抛 PARENT_INVALID）。
    let parentId = rootIdOf(doc, canvasIdGetter());
    const sel = [...selection.selected];
    if (sel.length === 1) {
      const snap = getNode(doc, sel[0]);
      if (snap && !snap.deleted) parentId = snap.id;
    }
    try {
      const clip = await readFromSystemClipboard();
      // 图片优先仲裁（本轮修复）：剪贴板含图片时让路——图片由原生 paste 事件路径
      // 插入（onDocPaste），本路径不再落文本节点。否则「复制网页图片」这类
      // 图文同存的剪贴板会被双写（文本节点 + 图片）。
      if (clip.hasImage) return;
      const idx = getNode(doc, parentId)?.childIds.length ?? 0;
      if (clip.internal) {
        await pasteNodes(handleOf(doc, canvasIdGetter), parentId, idx, clip.internal, undefined, remapImageKey);
        fitPendingRef.current = true;
      } else if (clip.text !== null && clip.text.trim() !== '') {
        pasteText(handleOf(doc, canvasIdGetter), parentId, idx, clip.text);
        fitPendingRef.current = true;
      } else {
        return; // 无可粘贴内容：无操作
      }
      afterUserWrite();
      // node_add 埋点（M5 Task 4）：一次粘贴动作记一行（via=paste；多节点不逐个拆行）
      track('node_add', { via: 'paste', nodeCount: countAliveReachable(doc, canvasIdGetter()) }, fileId);
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
        // 插入目标：主选中节点（无选中/多选时 primaryId 降级为 root）；换图保留原槽位。
        const targetId = primaryId();
        const placement = getNode(doc, targetId)?.image?.placement;
        setImage(
          doc,
          targetId,
          { key, w, h, ...(placement !== undefined ? { placement } : {}) },
          ORIGIN_USER,
        );
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
    // 图片缩放手柄（2026-10-15）：点手柄不改选区、也不落下方空白兜底（否则会清空
    // 选择，下一次拖拽就没手柄了）。与角标家族同一「让位」纪律，最先判定。
    if (target.closest('.gm-image-resize-handle')) return;
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
    // 人员进度头像（2026-10-11 第二步）：点击节点任务行上的成员头像 → 档位选盘
    // 快速更新该成员进度（对齐 A 的进度徽章交互标杆）；先于标记徽章/折叠/选择
    // 处理并直接 return（角标家族同一让位纪律）。只读不弹（写路径）。
    const assigneeG = target.closest('.gm-task-assignee[data-assignee-user]');
    if (assigneeG && !readOnly) {
      const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
      const user = assigneeG.getAttribute('data-assignee-user');
      const colId = assigneeG.getAttribute('data-assignee-col');
      if (nodeId && user && colId) {
        setContextMenu(null);
        const row = assigneeRowsOf(getNode(doc, nodeId)?.custom?.[colId]).find((r) => r.user === user);
        // 再点同一头像 = toggle 收盘（统一外点已豁免 .gm-task-assignee，同徽章口径）。
        if (
          assigneePicker &&
          assigneePicker.mode === 'assignee' &&
          assigneePicker.nodeId === nodeId &&
          assigneePicker.user === user &&
          assigneePicker.colId === colId
        ) {
          setAssigneePicker(null);
          return;
        }
        setAssigneePicker({
          mode: 'assignee',
          nodeId,
          user,
          colId,
          // 列名（2026-10-13 需求方反馈）：自定义列 schema 里按 colId 取显示名
          colName: getMeta(doc).customColumns.find((c) => c.id === colId)?.name,
          name: memberIndexRef.current.get(user)?.nickname ?? user.slice(0, 8),
          avatar: avatarSrcOf(memberIndexRef.current.get(user)?.avatar ?? null, user),
          progress: row?.progress ?? 0,
          x: e.clientX,
          y: e.clientY,
        });
        return;
      }
    }
    // 负责人头像（2026-10-12 裁定：点负责人头像弹同款选盘快捷改其进度——写
    // setNodeTask；与人员列点头像同交互同选盘，mode 区分写路径）。
    const ownerG = target.closest('.gm-task-owner-avatar[data-owner-user]');
    if (ownerG && !readOnly) {
      const nodeId = target.closest('[data-node-id]')?.getAttribute('data-node-id');
      const user = ownerG.getAttribute('data-owner-user');
      if (nodeId && user) {
        setContextMenu(null);
        const progress = getNode(doc, nodeId)?.task.progress ?? 0;
        if (
          assigneePicker &&
          assigneePicker.mode === 'owner' &&
          assigneePicker.nodeId === nodeId &&
          assigneePicker.user === user
        ) {
          setAssigneePicker(null);
          return;
        }
        setAssigneePicker({
          mode: 'owner',
          nodeId,
          user,
          colName: '负责人',
          name: memberIndexRef.current.get(user)?.nickname ?? user.slice(0, 8),
          avatar: avatarSrcOf(memberIndexRef.current.get(user)?.avatar ?? null, user),
          progress,
          x: e.clientX,
          y: e.clientY,
        });
        return;
      }
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
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !moved) {
        imageFocusRef.current = null;
        selection.clear();
      }
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
      imageFocusRef.current = null; // 多选无图片聚焦（聚焦口径 = 单选 + 点图片）
      selection.toggle(id);
      return;
    }
    // 再点开 TaskPanel（2026-10-10 需求方裁定，mindgrid「单击选中 · 再击开属性」
    // 同款）：本次点击**之前**该节点已是唯一选中 → 开任务面板（只开不 toggle；
    // 与格式面板互斥沿用工具栏口径）；多选中的点击先收敛为单选，不当场开。
    // 双击已选中节点：第一次 click 会开面板、随后 dblclick 进就地编辑——并存
    // 行为同 mindgrid（spec 2026-10-10 §三 已记）。
    //
    // 图片聚焦（2026-10-20）：落点在 .gm-image → 只描图片轮廓；否则整节点蓝框。
    // 需在 selectOnly **之前**置位（emit 同步进 applySelectionClasses）；同 id 再点
    // 不 emit，故 selectOnly 后显式补刷一次类。
    imageFocusRef.current = target.closest('.gm-image') ? id : null;
    const alreadySoleSelected = selection.selected.size === 1 && selection.selected.has(id);
    selection.selectOnly(id);
    applySelectionClassesRef.current?.();
    if (alreadySoleSelected && !readOnly) {
      setFormatOpen(false);
      setTaskPanelOpen(true);
    }
  };

  // —— 图片缩放（拖角手柄，2026-10-15 需求方「拖拽图片周边改尺寸」）——

  /**
   * 起拖：记起始尺寸与起始指针场景坐标，抓指针。
   * 位移口径（非绝对坐标）：拖拽中每次写都会重排、节点盒位置可能变化，绝对坐标
   * 反解尺寸会与布局互相反馈（抖），故一律用「指针位移 → 缩放系数」（见 imageHandles）。
   */
  const beginImageResize = (
    e: React.PointerEvent<SVGSVGElement>,
    handle: Element,
  ): void => {
    const d = doc;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const selection = selectionRef.current;
    const corner = handle.getAttribute('data-corner') as ImageCorner | null;
    if (!d || !vp || !svgEl || !selection || !corner) return;
    if (selection.selected.size !== 1) return;
    const nodeId = [...selection.selected][0];
    const image = nodeId ? getNode(d, nodeId)?.image : null;
    if (!nodeId || !image) return;
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    imageResizeRef.current = {
      nodeId,
      key: image.key,
      placement: image.placement,
      corner,
      pointerId: e.pointerId,
      w0: image.w,
      h0: image.h,
      startX: scene.x,
      startY: scene.y,
      pending: null,
      written: null,
      raf: 0,
    };
    e.preventDefault(); // 抑制拖拽选中文本等浏览器默认行为（框选同款）
    if (typeof svgEl.setPointerCapture === 'function') {
      try {
        svgEl.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 */
      }
    }
  };

  /**
   * 拖拽中：位移 → 尺寸（等比 + 200/24 钳制），**rAF 节流写文档**（方案甲，需求方
   * 2026-10-15 选定）：每帧最多一次 setImage，卡片/兄弟节点/连线/子树实时跟随；
   * 不逐帧调 afterUserWrite（避免每帧广播 awareness 与拉视口），松手统一调一次。
   * 撤销粒度：500ms 内的连续写被 Y.UndoManager captureTimeout 合并为一步。
   */
  const updateImageResize = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = doc;
    const pendingState = imageResizeRef.current;
    const vp = viewportRef.current;
    if (!d || !pendingState || !vp) return;
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    const next = resizeImageSizeByDelta(
      { w: pendingState.w0, h: pendingState.h0 },
      pendingState.corner,
      { dx: scene.x - pendingState.startX, dy: scene.y - pendingState.startY },
    );
    const last = pendingState.written ?? { w: pendingState.w0, h: pendingState.h0 };
    if (next.w === last.w && next.h === last.h) {
      pendingState.pending = null;
      return;
    }
    pendingState.pending = next;
    if (pendingState.raf !== 0) return;
    pendingState.raf = requestAnimationFrame(() => {
      const s = imageResizeRef.current;
      if (!s || s !== pendingState) return;
      s.raf = 0;
      const w = s.pending ?? s.written;
      if (!w) return;
      setImage(d, s.nodeId, { key: s.key, w: w.w, h: w.h, placement: s.placement }, ORIGIN_USER);
      s.written = w;
      s.pending = null;
    });
  };

  /**
   * 松手：冲刷未落帧的尺寸，恰一次记撤销/广播收口（一次拖拽 = 一步撤销）；
   * 置 justDraggedRef 吞掉浏览器合成的 click（否则会清选区/开面板）。
   */
  const endImageResize = (e: React.PointerEvent<SVGSVGElement>): void => {    const d = doc;
    const s = imageResizeRef.current;
    if (!d || !s) return;
    if (s.raf !== 0) {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
    }
    const finalSize = s.pending ?? s.written;
    if (finalSize) {
      const last = s.written;
      if (!last || last.w !== finalSize.w || last.h !== finalSize.h) {
        setImage(d, s.nodeId, { key: s.key, w: finalSize.w, h: finalSize.h, placement: s.placement }, ORIGIN_USER);
      }
      afterUserWrite();
    }
    imageResizeRef.current = null;
    justDraggedRef.current = true;
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    const svgEl = svgRef.current;
    if (svgEl && typeof svgEl.releasePointerCapture === 'function') {
      try {
        svgEl.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放可忽略 */
      }
    }
  };

  // —— 图片拖拽换位（2026-10-20 图文四槽位）——

  /** 清空 ghost/引导带（层可能尚未装配——重建场景窗口期）。 */
  const clearImageDragOverlay = (): void => {
    const layer = imageDragLayerRef.current;
    if (!layer) return;
    const scale = viewportRef.current?.scale ?? 1;
    renderImageDrop(layer, null, scale);
  };

  /** 指针位置的拖拽目标（节点 + 四槽位命中）；无节点返回 null。 */
  const imageDragTargetAt = (
    scene: { x: number; y: number },
  ): { nodeId: string; box: NodeBox; padX: number; placement: ImagePlacement } | null => {
    const d = doc;
    const box = findNodeAt(boxesRef.current, scene);
    if (!d || !box) return null;
    const theme = THEMES[resolveThemeId(getMeta(d).themeId)];
    const layout = guideLayoutOf(box, theme.nodePaddingX);
    return {
      nodeId: box.id,
      box,
      padX: theme.nodePaddingX,
      placement: placementAt(layout, scene),
    };
  };

  /** 拖拽中：ghost 跟随指针 + 悬停节点的四侧虚线引导带（只预览，不写文档）。 */
  const updateImageDrag = (e: React.PointerEvent<SVGSVGElement>): void => {
    const s = imageDragRef.current;
    const vp = viewportRef.current;
    const layer = imageDragLayerRef.current;
    if (!s || !vp) return;
    if (!s.active) {
      // 图片本体直接起拖，但要与单击选中/双击预览共存：位移超过 4px 才进入拖拽。
      if (e.buttons === 0) {
        cancelImageDrag(); // 在画布外松开后回到画布：不把旧按下误判成新拖拽
        return;
      }
      if (Math.hypot(e.clientX - s.startClientX, e.clientY - s.startClientY) <= 4) return;
      s.active = true;
      const svgEl = svgRef.current;
      if (svgEl && typeof svgEl.setPointerCapture === 'function') {
        try {
          svgEl.setPointerCapture(s.pointerId);
        } catch {
          /* 捕获失败可忽略：监听就在 svg 上 */
        }
      }
    }
    if (!layer) return;
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    renderImageDrop(
      layer,
      {
        pointer: scene,
        href: `/api/images/${s.key}`,
        image: { w: s.w, h: s.h },
        target: imageDragTargetAt(scene),
      },
      vp.scale,
    );
  };

  /**
   * 开始拖图：图片本体直接起拖（需求方 2026-10-20 走查：不要额外把手）。
   * 按下时只记待定状态、不 preventDefault/不捕获指针——短按仍走既有单击选中与
   * 双击预览；越过位移阈值后由 updateImageDrag 激活。四角缩放手柄先于本函数拦。
   */
  const beginImageDrag = (e: React.PointerEvent<SVGSVGElement>): boolean => {
    if (readOnly) return false;
    const d = doc;
    const imgEl = (e.target as Element).closest('.gm-image');
    const nodeId = imgEl?.closest('[data-node-id]')?.getAttribute('data-node-id');
    if (!d || !nodeId) return false;
    const image = getNode(d, nodeId)?.image;
    if (!image) return false;
    imageDragRef.current = {
      nodeId,
      key: image.key,
      w: image.w,
      h: image.h,
      placement: imagePlacementOf(image),
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      active: false,
    };
    clearImageDragOverlay();
    return true;
  };

  /** 松手落库：同节点 = 改 placement；跨节点 = moveImage 单事务（一步撤销，目标图直接替换）。 */
  const endImageDrag = (e: React.PointerEvent<SVGSVGElement>): void => {
    const d = doc;
    const s = imageDragRef.current;
    const vp = viewportRef.current;
    if (!s) return;
    imageDragRef.current = null;
    clearImageDragOverlay();
    const svgEl = svgRef.current;
    if (svgEl && typeof svgEl.releasePointerCapture === 'function') {
      try {
        svgEl.releasePointerCapture(e.pointerId);
      } catch {
        /* 已释放可忽略 */
      }
    }
    if (!s.active) return; // 未越过阈值：保留浏览器 click/dblclick（选中/预览）
    justDraggedRef.current = true; // 吞掉浏览器合成的 click（同缩放手势）
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
    if (!d || !vp) return;
    const scene = vp.toSceneFromEvent(e.nativeEvent);
    const target = imageDragTargetAt(scene);
    if (!target) return; // 落在画布空白：取消（不写、不删）
    try {
      if (target.nodeId === s.nodeId) {
        if (target.placement === s.placement) return; // 原槽位：零写入
        setImage(
          d,
          s.nodeId,
          { key: s.key, w: s.w, h: s.h, placement: target.placement },
          ORIGIN_USER,
        );
      } else {
        moveImage(
          d,
          s.nodeId,
          target.nodeId,
          { key: s.key, w: s.w, h: s.h, placement: target.placement },
          ORIGIN_USER,
        );
      }
      afterUserWrite();
    } catch (err) {
      showToast(err instanceof Error ? err.message : '图片移动失败');
    }
  };

  /** 取消拖图（pointercancel，如系统中断）：清预览，不写文档。 */
  const cancelImageDrag = (): void => {
    if (!imageDragRef.current) return;
    imageDragRef.current = null;
    clearImageDragOverlay();
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
    // 图片手柄优先（角标家族同一「让位」纪律）：手柄在独立层、不在节点 g 内，
    // 不先拦会被下方兜底当空白处理（清选区/起框选）。
    const handleEl = (e.target as Element).closest('.gm-image-resize-handle');
    if (handleEl && !readOnly) {
      beginImageResize(e, handleEl);
      return;
    }
    // 图片本体直接起拖（2026-10-20 四槽位）：只记待定状态，越过 4px 才激活，
    // 短按仍走点击/双击；文字/边框上的按键照旧进入节点拖动。空格平移优先。
    if (viewportRef.current?.spacePressed) return;
    if (beginImageDrag(e)) return;
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
    if (imageDragRef.current) {
      updateImageDrag(e); // 图片换位拖拽优先（与 pointerdown 同序）
      return;
    }
    if (imageResizeRef.current) {
      updateImageResize(e); // 图片手柄拖拽优先（与 pointerdown 同序）
      return;
    }
    const selection = selectionRef.current;
    const vp = viewportRef.current;
    if (!selection || !vp) return;
    if (!selection.isMarquee) return;
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
    if (imageDragRef.current) {
      endImageDrag(e); // 图片换位松手：一次落库 + 一次 afterUserWrite
      return;
    }
    if (imageResizeRef.current) {
      endImageResize(e); // 图片手柄松手：冲刷尺寸 + 一次 afterUserWrite
      return;
    }
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

  /** 指针取消：图片换位直接丢弃（不写文档）；其余手势沿用松手收口。 */
  const onSvgPointerCancel = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (imageDragRef.current) {
      cancelImageDrag();
      return;
    }
    onSvgPointerUp(e);
  };

  /** 指针离开画布：未激活的待定拖拽直接取消；已激活由指针捕获继续跟随。 */
  const onSvgPointerLeave = (): void => {
    const s = imageDragRef.current;
    if (s) {
      if (!s.active) cancelImageDrag();
      return;
    }
    clearImageDragOverlay();
  };

  const onSvgDoubleClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (justDraggedRef.current) return;
    // 双击图片 → 大图预览（2026-10-15 需求方裁定）。**先于 readOnly 让路**：预览是
    // 读操作，只读/移动端同样可用（与折叠徽标、评论角标同口径）。代价（已与需求方
    // 对齐）：双击图片区不再进文本编辑——双击文字区仍进编辑，另有 F2 与键入直入。
    const imgEl = (e.target as Element).closest('.gm-image');
    if (imgEl) {
      const d = doc;
      const imgId = (e.target as Element)
        .closest('[data-node-id]')
        ?.getAttribute('data-node-id');
      const key = d && imgId ? getNode(d, imgId)?.image?.key : null;
      if (key && imgId) setImagePreview({ src: `/api/images/${key}`, nodeId: imgId });
      return;
    }
    if (readOnly) return; // 移动端只读：双击（双触）不进编辑（OPEN-T-005）
    const g = (e.target as Element).closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (id) openNodeEditor(id);
  };

  // —— 右键菜单（Task 12）：动作复用与键盘相同的 core/engine 处理器 ——

  /** 右键待决期暂存的菜单请求（rightPendingActive 期间 contextmenu 早到，pointerup 结算）。 */
  const pendingContextMenuRef = useRef<{
    x: number;
    y: number;
    hit: { summaryId?: string; nodeId?: string; image?: boolean };
  } | null>(null);

  /** 命中解析：优先事件 target；被指针捕获重定向（target=svg）时按坐标恢复。 */
  const resolveContextMenuHit = (
    e: React.MouseEvent<SVGSVGElement>,
  ): { summaryId?: string; nodeId?: string; image?: boolean } => {
    const hitAtPoint = (selector: string): Element | null =>
      document.elementFromPoint(e.clientX, e.clientY)?.closest(selector) ?? null;
    // 图片命中优先（2026-10-20 独立右键菜单）：只读下也允许「复制图片」，故必须先于
    // 只读早退判定。
    const imgEl = (e.target as Element).closest('.gm-image') ?? hitAtPoint('.gm-image');
    if (imgEl) {
      const g = imgEl.closest('[data-node-id]');
      const iid = g?.getAttribute('data-node-id');
      if (iid) return { nodeId: iid, image: true };
    }
    const sumG = (e.target as Element).closest('[data-summary-id]') ?? hitAtPoint('[data-summary-id]');
    if (sumG) {
      const sid = sumG.getAttribute('data-summary-id');
      return sid ? { summaryId: sid } : {};
    }
    const g = (e.target as Element).closest('[data-node-id]') ?? hitAtPoint('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    return id ? { nodeId: id } : {};
  };

  /** 菜单提交：概要与节点菜单互斥；节点含多选保持与单选（选中副作用随菜单一起提交）。 */
  const commitContextMenu = (
    x: number,
    y: number,
    hit: { summaryId?: string; nodeId?: string; image?: boolean },
  ): void => {
    if (hit.summaryId !== undefined) {
      setContextMenu({ x, y, summaryId: hit.summaryId });
      return;
    }
    const id = hit.nodeId;
    if (!id || !doc) {
      setContextMenu(null);
      return;
    }
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    if (hit.image) {
      // 图片菜单：不改选区（右键图片只是复制/剪切目标），只读下也允许复制。
      if (!snap.image) return;
      setContextMenu({ x, y, nodeId: id, image: true });
      return;
    }
    // 多选保持（M6 T6）：右键命中成员之一时不折叠选区——「添加概要」依赖多选片段
    const sel = selectionRef.current;
    if (!(sel && sel.selected.size > 1 && sel.selected.has(id))) {
      selectionRef.current?.selectOnly(id);
    }
    setContextMenu({ x, y, nodeId: id });
  };

  const onSvgContextMenu = (e: React.MouseEvent<SVGSVGElement>): void => {
    e.preventDefault();
    if (justDraggedRef.current) return;
    // 右键平移释放（需求方 2026-10-09）：Viewport 右键拖动超阈值平移后，浏览器随
    // pointerup 合成的 contextmenu 不弹菜单（拖了就不弹）；justPanned 在任一
    // pointerdown 复位，下一次原地右键松开照常弹菜单。panning 补位（2026-10-09 右键
    // 菜单修复）：headless/Linux Chromium 的 contextmenu 在 pointerup **之前**合成，
    // 此时 justPanned 尚未置位，须查进行中的平移态才能拦住拖拽释放。
    if (viewportRef.current?.justPanned || viewportRef.current?.panning) return;
    // 图片独立菜单（2026-10-20）：只读下仍允许「复制图片」，因此命中先于只读早退；
    // 非图片命中维持原口径（移动端只读不弹右键菜单）。
    const hit = resolveContextMenuHit(e);
    if (readOnly && !hit.image) return;
    // 命中恢复（2026-10-09 右键平移修复配套）：Viewport 在右键 pointerdown 即捕获
    // 指针（保平移阈值判定期间 move/up 不丢），Chromium 随后合成的 contextmenu
    // target 被重定向到 svg——closest 命中链断裂、菜单永不弹（与 viewport.ts 头注
    // 「捕获会把 click 重定向」同一陷阱）。target 未命中时按坐标 elementFromPoint
    // 恢复命中（几何查询不受指针捕获影响）。
    // 早到的 contextmenu（Linux/headless 紧随 pointerdown 合成，早于 move/pointerup）
    // 此刻无法预知会不会拖动——暂存到 pointerup 结算：拖拽平移丢弃、原地松开补弹
    // （结算见下方 useEffect 的 window 冒泡 pointerup，晚于 Viewport 的 svg 层处理，
    // justPanned 届时已准确）。macOS/Windows 的 contextmenu 在 up 后到达，直接提交。
    if (viewportRef.current?.rightPendingActive) {
      pendingContextMenuRef.current = { x: e.clientX, y: e.clientY, hit };
      return;
    }
    commitContextMenu(e.clientX, e.clientY, hit);
  };

  // 右键菜单请求结算（2026-10-09 修复）：commitContextMenu 是渲染闭包（读 doc），
  // 用 ref 持最新引用；监听挂 window 冒泡阶段——pointerup 从 svg 冒泡而来，Viewport
  // 的 svg 层监听先执行（endPan/justPanned 置位完毕），结算读到的手势态是终态。
  const commitContextMenuRef = useRef(commitContextMenu);
  commitContextMenuRef.current = commitContextMenu;
  useEffect(() => {
    const settle = (): void => {
      const pending = pendingContextMenuRef.current;
      pendingContextMenuRef.current = null;
      if (!pending) return;
      if (viewportRef.current?.justPanned) return; // 拖拽平移过的手势不弹菜单
      commitContextMenuRef.current(pending.x, pending.y, pending.hit);
    };
    window.addEventListener('pointerup', settle);
    window.addEventListener('pointercancel', settle);
    return () => {
      window.removeEventListener('pointerup', settle);
      window.removeEventListener('pointercancel', settle);
    };
  }, []);

  /**
   * 复制 / 剪切节点图片（2026-10-20 图片独立右键菜单）：
   * - 系统剪贴板写 PNG（非 PNG 先转码），供粘贴到外部应用；
   * - 同时记文档内语义 payload（key/w/h/placement），Ctrl+V 粘回画布沿用原 key，
   *   不重复上传；剪切 = 写成功后才清空节点图片（失败不清，避免丢图）。
   */
  const copyNodeImage = async (
    nodeId: string,
    cut: boolean,
    silent = false,
  ): Promise<boolean> => {
    const d = doc;
    const image = d ? getNode(d, nodeId)?.image : null;
    if (!d || !image) return false;
    if (
      typeof ClipboardItem === 'undefined' ||
      typeof navigator.clipboard?.write !== 'function'
    ) {
      if (!silent) {
        showToast('当前浏览器不支持复制图片 / 请使用最新版 Chrome、Edge 或 Safari');
      }
      return false;
    }
    try {
      // ClipboardItem 接收 Promise<Blob>：在用户手势内先发起 write，再等图片转码，
      // 避免先 await fetch 丢失剪贴板写权限。
      const png = fetch(`/api/images/${image.key}`).then(async (res) => {
        if (!res.ok) throw new Error(`图片读取失败（${res.status}）`);
        return toPngBlob(await res.blob());
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      setLastImage({
        key: image.key,
        w: image.w,
        h: image.h,
        placement: image.placement,
        fileId,
      });
      if (cut) {
        setImage(d, nodeId, null, ORIGIN_USER);
        afterUserWrite();
        if (!silent) showToast('已剪切图片');
      } else if (!silent) {
        showToast('已复制图片');
      }
      return true;
    } catch (e) {
      if (!silent) {
        showToast(
          `图片复制失败：${e instanceof Error ? e.message : '未知错误'} / 请检查浏览器剪贴板权限后重试`,
        );
      }
      return false;
    }
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
    if (menu.image) {
      // 图片菜单：复制（只读可用）/ 剪切（写路径，只渲染于可编辑态）
      if (action === 'image-copy') void copyNodeImage(nodeId, false);
      else if (action === 'image-cut' && !readOnly) void copyNodeImage(nodeId, true);
      return;
    }
    switch (action) {
      case 'insert-child':
        openNewNodeEditor(nodeId, undefined, 'child', 'context');
        break;
      case 'insert-sibling': {
        const canvasRootId = rootIdOf(doc, canvasIdGetter());
        if (nodeId === canvasRootId) {
          openNewNodeEditor(canvasRootId, undefined, 'child', 'context');
          break;
        }
        const snap = getNode(doc, nodeId);
        const parent = snap ? getNode(doc, snap.parentId) : null;
        if (!snap || !parent || parent.deleted) break;
        // root 级 mindmap 同侧落位与键盘 Enter 同规则（rootSiblingForceSide 单源，
        // 2026-10-09 二次裁定）：顺时针触发 → 左；其余 → 所按分支有效侧。
        openNewNodeEditor(
          parent.id,
          parent.childIds.indexOf(nodeId) + 1,
          'sibling',
          'context',
          undefined,
          rootSiblingForceSide(doc, nodeId, false, canvasIdGetter()),
        );
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
  // meta 按当前画布读（structureType/themeId 画布级——页签条切换后工具栏/面板回显
  // 随画布变；title/customColumns/tableView 仍 doc 级，canvasId 对它们无语义）。
  const meta = doc ? getMeta(doc, canvasIdGetter()) : null;
  // 标题草稿（2026-10-20 IME 修复）：受控值=草稿 ?? meta.title；组合输入期
  // （拼音上屏前）不写回文档——否则拼音字母被当真值写回、meta 重渲染打断组合
  // （「删不完/中文回车变英文且不全/多空格」根因）。失焦/回车收敛。
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const titleComposingRef = useRef(false);
  const themeId = meta ? resolveThemeId(meta.themeId) : 'gmind-blue';
  // 脚标口径与服务端配额统一（FR-ACC-003）：自当前画布 root 可达的存活节点数
  // （不含 root；墓碑/孤儿不计——与 countAlive 的差异见 @gmind/core countAliveReachable；
  // 多画布 Task 4 item 7：计数/配额按画布，裁定 1）
  const nodeCount = doc ? countAliveReachable(doc, canvasIdGetter()) : 0;
  const selectionNow = selectionRef.current;
  const selectedIds = selectionNow ? [...selectionNow.selected] : [];
  const selectedNodeId =
    selectionNow && selectionNow.selected.size === 1
      ? ([...selectionNow.selected][0] ?? null)
      : null;
  // 有任意选中（单选/多选）即可用工具栏增删按钮（多选时操作主选中节点）
  const hasSelection = (selectionNow?.selected.size ?? 0) > 0;
  // 选中节点快照（M6 Task 2 企微对标）：RichPanel 样式区回显数据源；无选中（空选
  // 区/多选/已删）为 null → 样式区置灰 + 提示。tick 驱动重渲染，切换节点即时刷新。
  const selectedSnapshot = doc && selectedNodeId ? getNode(doc, selectedNodeId) : null;

  // （标记面板批量口径 selectedIds/selectedIcons 已随 2026-10-10「任务面板标记
  //  内嵌化」裁定退役——MarkerPanel 删除后无消费方；TaskPanel 内嵌行单节点读写。）

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

  // —— 评论动作（M3b Task 7，FR-CMT-002）——

  /**
   * 面板条目 → 画布定位：selectOnly + 沿 pathToRoot 展开折叠祖先（pathToRoot 自身
   * 起步至 root；祖先 collapsed=true 才 toggleCollapse——system origin 不进撤销栈）。
   * 定位裁决：选区 + 展开即满足「定位」，不做视口居中（过扰）；选中高亮由
   * .gm-selected 样式承担（rerender 每帧回填类，新展开的节点同样命中）。
   *
   * 跨画布（多画布计划三 Task 5，默认假设 4：评论不绑画布）：canvasIdOfNode 全画布
   * 口径解析归属，不在当前画布 → 先 switchCanvas，场景重建（rAF 调度，切换编排自身
   * 已排入同帧更前的 rerender）后下一帧重入本函数完成展开/选中。全画布不存在/已删
   * 返回 null——与旧行为一致不定位。
   */
  const locateNode = (nodeId: string): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ownerId = canvasIdOfNode(doc, nodeId);
    if (ownerId === null) return; // 全画布口径不存在/已删：无线索可定位（同旧行为）
    if (ownerId !== (activeCanvasIdRef.current || resolveCanvasId(doc))) {
      switchCanvas(ownerId);
      requestAnimationFrame(() => locateNode(nodeId)); // 重建后重入：展开折叠祖先 + 选中
      return;
    }
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

  /** 个人中心动作（2026-10-11）：返回工作台 / 退出登录——复用工作台范式
   *  （POST /auth/logout + clearToken + 回登录页；登出失败也照常本地登出）。 */
  const logout = (): void => {
    void api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearToken();
    navigate('/login');
  };

  // 本人身份（个人中心，2026-10-11）：进编辑器拉一次 GET /users/me（昵称/手机号
  // 展示 + 头像首字符）；失败静默（下拉头部降级「我」，菜单项仍可用）。
  useEffect(() => {
    void api<{ id: string; nickname: string; phone: string | null }>('/users/me')
      .then(setMe)
      .catch(() => undefined);
  }, []);

  // —— 引擎装配主 effect ——
  useEffect(() => {
    if (!state) return;
    const { doc: d } = state;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const selection = new SelectionModel();
    selectionRef.current = selection;
    imageFocusRef.current = null; // 换文件/重装配：图片聚焦随选区模型一起重来
    selection.onChange = () => {
      applySelectionClasses();
      // 选区广播（FR-COL-002）：远端据此渲染我的彩色选区框/昵称标签
      collabHandleRef.current?.setSelection([...selection.selected]);
      setTick((t) => t + 1);
    };

    const reader = readerOf(d, canvasIdGetter);
    const depthById = new Map<string, number>();
    let rafId = 0;
    let scheduled = false;

    const applySelectionClasses = (): void => {
      const scene = sceneRef.current;
      if (!scene) return;
      // 图片聚焦态校验（2026-10-20）：选区不再是单选该节点、节点被删、图被移除 →
      // 聚焦自动失效（键盘导航/框选/清空/远端变更都经此处收敛）。
      let focusId = imageFocusRef.current;
      if (focusId) {
        const snap = getNode(d, focusId, canvasIdGetter());
        const valid =
          selection.selected.size === 1 &&
          selection.selected.has(focusId) &&
          !!snap &&
          !snap.deleted &&
          !!snap.image;
        if (!valid) {
          imageFocusRef.current = null;
          focusId = null;
        }
      }
      const theme = THEMES[resolveThemeId(getMeta(d, canvasIdGetter()).themeId)];
      for (const [id, entry] of scene.nodeEntries) {
        const selected = selection.selected.has(id);
        entry.g.classList.toggle('gm-selected', selected);
        const imageFocused = focusId === id;
        entry.g.classList.toggle('gm-image-focused', imageFocused);
        // 图片聚焦时整节点退回**普通主题边框**，蓝色选中描边让给图片轮廓：
        // 内联 style 高于 .gm-selected 的 CSS；失焦清空后 CSS 蓝框自动回落。
        const rect = entry.g.querySelector<SVGRectElement>(':scope > rect');
        if (rect) {
          if (selected && imageFocused) {
            const style = resolveNodeStyle(
              theme,
              depthById.get(id) ?? 0,
              getNode(d, id, canvasIdGetter())?.style ?? {},
            );
            rect.style.stroke = style.border;
            rect.style.strokeWidth = String(theme.nodeBorderWidth);
          } else {
            rect.style.stroke = '';
            rect.style.strokeWidth = '';
          }
        }
      }
      // 手柄与选中态同源（选区变化与每次重排都经此处）：单选 + 有图 + 非只读才出。
      syncImageHandles();
    };
    applySelectionClassesRef.current = applySelectionClasses;

    /** 节点图片矩形（场景坐标）；无图/已删/无盒 → null。手柄与聚焦轮廓共用。 */
    const nodeImageRectOf = (id: string): ImageRect | null => {
      const snap = getNode(d, id, canvasIdGetter());
      if (!snap || snap.deleted || !snap.image) return null;
      const box = boxesRef.current.find((b) => b.id === id);
      if (!box) return null;
      const theme = THEMES[resolveThemeId(getMeta(d, canvasIdGetter()).themeId)];
      return imageSceneRect(box, snap.image, theme.nodePaddingX);
    };

    /**
     * 当前应出手柄的图片矩形（场景坐标）；不该出返回 null。
     * 口径：**单选**（多选不出，避免歧义）+ 节点存活且有 image + 非只读（写交互）。
     */
    const selectedImageRect = (): ImageRect | null => {
      if (readOnly) return null;
      if (selection.selected.size !== 1) return null;
      const id = [...selection.selected][0];
      return id ? nodeImageRectOf(id) : null;
    };

    /**
     * 图片聚焦轮廓矩形（2026-10-20）：单选 + 点击落点在图片上（imageFocusRef）。
     * **只读同样显示**——选中/轮廓是读操作，与双击预览同口径。
     */
    const focusedImageRect = (): ImageRect | null => {
      const fid = imageFocusRef.current;
      if (!fid) return null;
      if (selection.selected.size !== 1 || !selection.selected.has(fid)) return null;
      return nodeImageRectOf(fid);
    };

    /** 手柄层回填（选区变化 / 重排 / 缩放三处调用；scale 取当前视口）。 */
    const syncImageHandles = (): void => {
      const layer = imageHandleLayerRef.current;
      const vp = viewportRef.current;
      if (!layer || !vp) return;
      renderImageFocusOutline(layer, focusedImageRect()); // 先轮廓（压手柄之下）
      renderImageHandles(layer, selectedImageRect(), vp.scale);
    };
    syncImageHandlesRef.current = syncImageHandles;

    /** 重建场景 + 视口 + 拖拽（主题切换/首次装配；carry-in 裁决 3）。
     *  多画布（计划三 Task 1）：场景 idPrefix 从当前画布 id 派生（canvasIdPrefix
     *  契约）；viewportRestore 显式给切换编排用——ViewportState = 恢复存档，
     *  null = 首访无存档（置 fitPending 交下一帧 rerender fit）；缺省
     *  （undefined）= 主题切换等现状路径，保留旧视口（getState/restore 取代
     *  原逐字段拷贝先例，语义等价）。 */
    const rebuildScene = (viewportRestore?: ViewportState | null): void => {
      const prev = viewportRef.current;
      const prevState = prev ? prev.getState() : null; // 先快照再 destroy
      dragRef.current?.destroy();
      prev?.destroy();
      const canvasId = canvasIdGetter();
      const scene = createScene(svgEl, canvasId ? { idPrefix: canvasIdPrefix(canvasId) } : undefined);
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
      // 图片缩放手柄层（2026-10-15）：场景坐标、最上层（浮在节点与拖拽指示之上）。
      // 只读下不渲染内容（同步函数直接返回 null）。
      imageHandleLayerRef.current = createImageHandleLayer(wrapper);
      // 图片拖拽换位层（2026-10-20 四槽位）：ghost/引导带，手柄层之上最顶层。
      imageDragLayerRef.current = createImageDragLayer(wrapper);
      svgEl.appendChild(wrapper);
      const vp = new Viewport(svgEl, wrapper);
      if (viewportRestore !== undefined) {
        // 画布切换编排：显式恢复存档；无存档（null）→ 首访 fit（rerender 消费
        // fitPendingRef）。restore 内部走 set+apply，transform 同步回写。
        if (viewportRestore === null) fitPendingRef.current = true;
        else vp.restore(viewportRestore);
      } else if (prevState !== null) {
        vp.restore(prevState); // 主题切换等现状路径：视口保留
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
        isDescendant: (id, candidateId) => subtreeIds(d, id, canvasIdGetter()).includes(candidateId),
        // 文档子级序（M7c-D1）：sibling 落点 index 结算输入（engine 纯计算在事务外）。
        childrenIdsOf: (id) => childrenIds(d, id, canvasIdGetter()),
        // 根级左列门控（2026-10-09 需求方修复「左侧没有分支主题时，右侧分支无法拖到
        // 左侧」）：mindmap 恒开放——拖到左半即建首个左列主题（onDrop 内按 target.side
        // setNodeSide 持久化）；logic 向右结构恒右（布局不读 side）；org（down）不经
        // 此门控。
        rootLeftAllowed: () => getMeta(d, canvasIdGetter()).structureType === 'mindmap',
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
          const canvasRootId = rootIdOf(d, canvasIdGetter()); // 当前画布根（组排除/Task 4 item 4）
          return [...selection.selected]
            .filter((id) => id !== canvasRootId && boxById.has(id))
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
              const canvasRootId = rootIdOf(d, canvasIdGetter()); // 当前画布根锚点
              if (target === null) {
                // 多画布 Task 4 item 4：落空白兜底父级 = 当前画布 rootId（引擎 root 盒
                // id 即画布根；'root' 字面量只命中迁移首画布，异根画布会抛 NODE_NOT_FOUND）
                for (const id of ids) moveNode(d, id, canvasRootId, undefined, ORIGIN_USER, canvasIdGetter());
              } else if (target.kind === 'child') {
                for (const id of ids) moveNode(d, id, target.nodeId, undefined, ORIGIN_USER, canvasIdGetter());
              } else {
                ids.forEach((id, i) => moveNode(d, id, target.parentId, target.index + i, ORIGIN_USER, canvasIdGetter()));
                // M7c-H 逆时针定侧：根级落点按引擎解析的目标侧持久化（拖到哪侧就换到
                // 哪侧；setNodeSide 同值零事务幂等）。target.side 仅 root 级落点携带；
                // 仅 mindmap 消费（logic/org 布局不读）。root 判定同画布根（引擎落点
                // parentId 对 root 级 = root 盒 id = 画布 rootId，Task 4 item 4）。
                if (target.side !== undefined && target.parentId === canvasRootId
                    && getMeta(d, canvasIdGetter()).structureType === 'mindmap') {
                  for (const id of ids) setNodeSide(d, id, target.side, ORIGIN_USER, canvasIdGetter());
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
      const canvasId = canvasIdGetter(); // 当前画布口径（多画布 Task 1）
      const canvasRootId = rootIdOf(d, canvasId);
      const m = getMeta(d, canvasId);
      const resolvedThemeId = resolveThemeId(m.themeId);
      const theme = THEMES[resolvedThemeId];
      if (sceneRef.current === null || themeRef.current !== resolvedThemeId) {
        rebuildScene();
        themeRef.current = resolvedThemeId;
      }
      const scene = sceneRef.current;
      if (!scene) return; // 不可达（rebuildScene 必建场景）：类型收窄
      svgEl.style.background =
        // 画布点阵背景（2026-10-24 原型换装）：主题底色打底 + 低对比点阵；当前主题
        // 全系浅色（gmind-blue/warm/accessible），暗色主题引入时需按主题关掉点阵
        `radial-gradient(rgb(31 35 41 / 0.07) 1px, transparent 1px) 0 0 / 22px 22px, ${theme.canvasBackground}`;
      // M7c-D2：主题节点圆角暴露为 CSS 变量，行内编辑浮层（.gm-text-editor）圆角
      // 随主题与节点卡片一致（12 套主题 nodeBorderRadius 4~12 不等）。浮层挂 body
      // （非 svg 后代），变量须落 :root 才能被继承。
      document.documentElement.style.setProperty('--gm-node-radius', `${theme.nodeBorderRadius}px`);

      const result = layout(reader, {
        structure: m.structureType,
        theme,
        measure,
        // 多画布（计划二接口）：布局起始根 = 当前画布 rootId
        rootId: canvasRootId,
        // carry-in 裁决 2：样式闭合 doc 读取
        styleOf: (id, depth) =>
          resolveNodeStyle(theme, depth, getNode(d, id, canvasId)?.style ?? {}).textStyle,
        // 简洁模式（M7b 补课）：紧凑盒测量（描述/任务行不占几何，进度内联）。
        // ref 直读最新值——切换当帧生效，不等 React 提交（viewRef 同款裁定）。
        compact: compactRef.current,
      });
      layoutRef.current = result;
      boxesRef.current = result.nodes;
      depthById.clear();
      for (const b of result.nodes) depthById.set(b.id, b.depth);

      const nodeData = new Map<string, NodeVisual>();
      for (const id of subtreeIds(d, canvasRootId, canvasId)) {
        const snap = getNode(d, id, canvasId);
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
          // ownerNames（2026-10-10 mindgrid 对齐）：footer 文字名数据源——成员目录
          // 映射显示名，查不到回退 ID 前 8 位（useTaskMembers 同口径）；渲染期派生。
          task: {
            ...snap.task,
            ownerNames: snap.task.owners.map(
              (o) => memberIndexRef.current.get(o)?.nickname ?? o.slice(0, 8),
            ),
            // 负责人头像（2026-10-11 头像功能）：成员目录 avatar → 直出 URL
            // （上传键经 /api/images；null 由引擎回退文字首字符——预置分配在宿主 Avatar
            // 组件层兜，画布任务行经 ownerAvatarUrls 显式给稳定预置）。
            ownerAvatarUrls: snap.task.owners.map(
              (o) => avatarSrcOf(memberIndexRef.current.get(o)?.avatar ?? null, o),
            ),
            // 人员进度列头像（2026-10-11 第二步）：拉平条目 + 成员目录显示名
            // （同 ownerNames 口径；engine 任务行绘制圆形文字头像+弧形进度环）。
            assignees: assigneeEntriesOf(d, id, canvasId).map((e) => ({
              ...e,
              name: memberIndexRef.current.get(e.user)?.nickname ?? e.user.slice(0, 8),
              avatar: avatarSrcOf(memberIndexRef.current.get(e.user)?.avatar ?? null, e.user),
            })),
          },
        });
      }
      renderScene(scene, {
        layout: result,
        theme,
        styleOf: (id) => resolveNodeStyle(theme, depthById.get(id) ?? 0, getNode(d, id, canvasId)?.style ?? {}),
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
    // 画布切换桥（多画布 Task 1）：controller 编排经此调装配闭包——重建场景
    // （reader 惰性绑新画布 + idPrefix 从画布 id 派生）；themeRef 对齐新画布
    // 主题（防紧随的 rerender 因主题差二次重建）；同步缩放指示。saved=null
    // 的首访 fit 由 rebuildScene 置 fitPendingRef、下一帧 rerender 消费。
    canvasRebuildRef.current = (saved) => {
      rebuildScene(saved);
      themeRef.current = resolveThemeId(getMeta(d, canvasIdGetter()).themeId);
      syncZoom();
      scheduleRerender();
    };

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
    // 真实缩略图（2026-10-21 需求方裁定真实快照）：persisted ack = 内容已落库 →
    // 节流重建 SVG 快照上传（首次立即，其后 ≥15s 间隔 + 尾沿定时器；失败静默——
    // 缩略图是派生增强，绝不阻塞/报错打断主流程）。上传成功失效卡片缓存。
    let thumbTimer: ReturnType<typeof setTimeout> | null = null;
    let thumbLastAt = 0;
    const uploadThumb = (): void => {
      thumbLastAt = Date.now();
      try {
        const svg = buildThumbSvg(d, measure);
        if (svg === null) return; // 超限/空文档：放弃本次（卡片回退装饰图）
        void apiPost(`/files/${fileId}/thumbnail`, { svg })
          .then(() => invalidateThumb(fileId))
          .catch(() => undefined);
      } catch {
        /* 快照构建失败静默 */
      }
    };
    const scheduleThumb = (): void => {
      const wait = 15_000 - (Date.now() - thumbLastAt);
      if (wait <= 0) {
        uploadThumb();
      } else if (thumbTimer === null) {
        thumbTimer = setTimeout(() => {
          thumbTimer = null;
          uploadThumb();
        }, wait);
      }
    };
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
            aliveCount: d ? countAliveReachable(d, canvasIdGetter()) : 0,
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
      },
      // persisted ack 携带的行 updated_at（M3a 准入 7.1）→ 刷新写序 base；此后断开
      // 走 PUT 兜底时，携带的是最后一次服务端持久化确认的行值
      onPersisted: (updatedAt) => {
        baseUpdatedAtRef.current = updatedAt;
        if (!readOnly) scheduleThumb(); // 真实缩略图：只读态（移动端）不写
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
      undo: () => {
        const m = umRef.current; // 当前画布撤销栈（裁定 2：不跨画布）
        if (m) coreUndo(m);
      },
      redo: () => {
        const m = umRef.current;
        if (m) coreRedo(m);
      },
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
    // preventDefault 截停默认行为并走上传链路（取图 files+items 并集），否则不干预
    // ——无图片时不 preventDefault，让文本/内部 payload 粘贴走键盘映射 Ctrl+V 通道。
    // **前置条件（本轮修复）**：键盘映射不得对 Ctrl+V 抑制默认行为，否则浏览器
    // 根本不派发本监听要接的原生 paste 事件，本入口形同虚设（见 keyboardMap 注释）。
    const onDocPaste = (ev: ClipboardEvent): void => {
      if (readOnly) return; // 移动端只读：画布粘贴截图（写路径）一并禁用
      // 内部图片 payload 已在键盘路径落库：原生 paste 的图片文件不再上传（防双写）。
      if (internalImagePasteRef.current) {
        internalImagePasteRef.current = false;
        ev.preventDefault();
        return;
      }
      if (overlay.isOpen || isEditableTarget(ev.target)) return;
      const file = imageFileFromClipboard(ev.clipboardData);
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
    // 默认选中当前画布中心主题（「选中 root 按 Tab」起点；多画布 Task 1：
    // 初始画布可能不是迁移首画布，rootId 按画布解析）
    selection.selectOnly(rootIdOf(d, canvasIdGetter()));
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
      if (thumbTimer !== null) clearTimeout(thumbTimer); // 缩略图尾沿定时器随装配拆卸
      collabHandleRef.current = null;
      quotaBlockedRef.current = false; // 文件切换不继承上一文件的配额拦截
      collab.destroy(); // provider + IndexedDB 本地副本一并收尾（顺序：先冲刷 saveLoop 决策再断链）
      commentsRefreshRef.current = null; // 文件切换不继承上一文件的评论刷新入口
      scheduleRerenderRef.current = null; // 文件切换不继承上一文件的画布重排入口
      canvasRebuildRef.current = null; // 文件切换不继承画布切换桥（多画布 Task 1）
      commentCountsRef.current = {};
      setComments({ threads: [], counts: {} });
      setCommentFilter(null);
      cursorLayerRef.current = null;
      remoteCursorsRef.current = [];
      setMembers([]);
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
      imageHandleLayerRef.current = null;
      imageDragLayerRef.current = null;
      imageDragRef.current = null;
      syncImageHandlesRef.current = null;
      applySelectionClassesRef.current = null;
      imageFocusRef.current = null;
      layoutRef.current = null;
      themeRef.current = '';
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
            组序：[返回] | [标题·星标·保存状态] | [视图] | [撤销·重做·格式刷] |
            [上级/子级/同级] | [格式·任务·简洁] | [结构·主题] | [导出] |
            [成员·版本历史·动态·快捷键·查找]（插入组 2026-10-10 整体删除；全屏组
            2026-10-09 迁至底栏）；全部按钮内联 SVG 图标 + title 提示，既有
            data-testid 一概保留（members-btn 实名与既有用例一致）。 */}
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
            // 2026-10-20 IME 修复（需求方反馈「删不完/中文回车变英文且不全/多空格」）：
            // 受控值改本地草稿优先——组合输入期（拼音上屏前）不写回文档、不被 meta
            // 重渲染打断；失焦/回车收敛（空标题回灌旧值，不落库——旧语义保留）。
            value={titleDraft ?? meta?.title ?? ''}
            onChange={(e) => {
              const value = e.target.value;
              setTitleDraft(value);
              if (titleComposingRef.current) return; // 组合期只更新草稿
              if (value.trim() === '') return; // 空标题不写（失焦时回灌恢复）
              setTitle(value);
              afterUserWrite(); // fix round 1 minor a：标题写也走统一 capUndoStack 通道
            }}
            onCompositionStart={() => {
              titleComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              titleComposingRef.current = false;
              const value = (e.target as HTMLInputElement).value;
              setTitleDraft(value);
              if (value.trim() === '') return;
              setTitle(value);
              afterUserWrite();
            }}
            onBlur={() => {
              // 收敛：空标题回灌 meta（不落库）；非空草稿如与 meta 一致则天然幂等
              if (titleDraft !== null && titleDraft.trim() !== '') {
                if (titleDraft !== (meta?.title ?? '')) {
                  setTitle(titleDraft);
                  afterUserWrite();
                }
              }
              setTitleDraft(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); // 回车 = 提交收敛
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
          {/* 评论开关（2026-10-10 需求方裁定：插入「评论」项随菜单删除后桌面端补
              入口——与移动端分支同一 testid 同一动作，标题组尾随 save-status，
              位置语义与移动端一致）。 */}
          <button
            data-testid="comment-toggle"
            data-popover-toggle="comment-toggle"
            className="toolbar-btn toolbar-btn-text"
            title="评论"
            aria-label="评论"
            onClick={() => setCommentsOpen((v) => !v)}
          >
            评论
          </button>
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
                // 画布级写（裁定 5，Task 4 item 10）：structureType 落当前画布
                setDocMeta(doc, { structureType: value }, ORIGIN_USER, canvasIdGetter());
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
                // 画布级写（裁定 5，Task 4 item 10）：themeId 落当前画布
                setDocMeta(doc, { themeId: id }, ORIGIN_USER, canvasIdGetter());
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
                      // 当前画布单 Sheet（Task 4 item 12 中间态；全量多 Sheet 属计划四）
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
        {/* 协作/视图组：版本历史 / 快捷键 / 查找（T3 查找替换已接线）；成员入口
            2026-10-11 迁至顶栏最右（头像左侧），本组不再含 members-btn */}
        <div className="toolbar-group">
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
        {/* 顶栏右缘（2026-10-11 需求方裁定）：[成员钮][本人头像=个人中心]。
            成员钮=成员面板唯一入口（MembersIcon + 在线数角标，testid 自协作组迁移，
            既有用例零改动）；本人头像=个人中心下拉（昵称/手机号 + 返回工作台 +
            退出登录）。协作者头像栏（M6 Task 9）整体退役——在线名单以成员面板为
            准；移动端只读分支不装配（随桌面工具栏整体隐藏）。 */}
        <div className="toolbar-trailing">
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
          <button
            type="button"
            data-testid="avatar-me"
            className="avatar-me"
            style={me ? { background: colorForUser(me.id) } : undefined}
            title="个人中心"
            aria-label="个人中心"
            aria-haspopup="menu"
            aria-expanded={personalOpen}
            onClick={() => setPersonalOpen((v) => !v)}
          >
            {(me?.nickname ?? '我').charAt(0)}
          </button>
        </div>
        {personalOpen && (
          <div className="personal-menu" data-testid="personal-menu" role="menu" aria-label="个人中心">
            <div className="personal-head">
              <span
                className="personal-avatar"
                style={me ? { background: colorForUser(me.id) } : undefined}
                aria-hidden
              >
                {(me?.nickname ?? '我').charAt(0)}
              </span>
              <div className="personal-id">
                <span className="personal-nickname" data-testid="personal-nickname">
                  {me?.nickname ?? '我'}
                </span>
                <span className="personal-phone" data-testid="personal-phone">
                  {me?.phone ?? ''}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="personal-item"
              data-testid="personal-workspace"
              role="menuitem"
              onClick={() => navigate('/workspace')}
            >
              返回工作台
            </button>
            <button
              type="button"
              className="personal-item"
              data-testid="personal-logout"
              role="menuitem"
              onClick={logout}
            >
              退出登录
            </button>
          </div>
        )}
      </>
        )}
      </header>

      <div className="editor-main">
        {/* 表格视图（M7a-T4）：画布仅 CSS 隐藏（引擎场景/视口/选中不卸载，切回即恢复），
            概要行内编辑随画布容器一并隐藏。 */}
        <div
          className={
            view === 'table'
              ? 'editor-canvas canvas-hidden'
              : readOnly
                ? 'editor-canvas canvas-readonly'
                : 'editor-canvas'
          }
        >
          <svg
            ref={svgRef}
            onClick={(e) => {
              setContextMenu(null);
              onSvgClick(e);
            }}
            onPointerDown={onSvgPointerDown}
            onPointerMove={onSvgPointerMove}
            onPointerUp={onSvgPointerUp}
            onPointerCancel={onSvgPointerCancel}
            onPointerLeave={onSvgPointerLeave}
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
              canvasId={activeCanvasId || undefined} // 表格快照/写路径 = 当前画布（Task 4）
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
                工具栏 comment-toggle 开评论面板；评论面板头部带 × 关闭。M6 Task 2 的常驻裁决就此改道。 */}
            {formatOpen && doc && um && (
              <RichPanel
                doc={doc}
                fileId={fileId}
                nodeId={selectedNodeId ?? ''}
                selectedIds={selectedIds}
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
                canvasId={activeCanvasId || undefined} // 派生平铺 = 当前画布（Task 4 评审修复）
                presence={members}
                afterUserWrite={afterUserWrite}
                showToast={showToast}
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

      {/* 画布右键菜单：表格视图不渲染（M7a-T4，画布专属浮层随视图隐藏）；
          图片菜单只读下仍渲染「复制图片」（2026-10-20 四槽位裁定）。 */}
      {(!readOnly || (contextMenu !== null && 'image' in contextMenu && contextMenu.image === true)) &&
        contextMenu &&
        view === 'mind' && (
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
          ) : 'image' in contextMenu && contextMenu.image ? (
            /* 图片菜单（2026-10-20）：复制恒有；剪切仅在可编辑态出现 */
            <>
              <button data-testid="menu-image-copy" onClick={() => runMenuAction('image-copy')}>
                复制图片
              </button>
              {!readOnly && (
                <button data-testid="menu-image-cut" onClick={() => runMenuAction('image-cut')}>
                  剪切图片
                </button>
              )}
            </>
          ) : (
            ([
              // 右键「任务设置」已随 2026-10-10 裁定删除（由再点已选中节点开
              // TaskPanel 取代），菜单项数 9 → 8
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

      {/* （标记面板 MarkerPanel 已随 2026-10-10「任务面板标记内嵌化」裁定退役：
          优先级/进度常显 + 六组折叠改在 TaskPanel 区块内联，见 TaskPanel.tsx。） */}

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

      {!readOnly && assigneePicker && view === 'mind' && (
        <div
          className="marker-picker assignee-picker"
          data-testid="assignee-picker"
          style={{
            left: Math.min(assigneePicker.x + 6, window.innerWidth - 262),
            top: Math.min(assigneePicker.y + 6, window.innerHeight - 200),
          }}
          role="menu"
          aria-label="人员进度"
        >
          <div className="marker-picker-head">
            {/* 头部（2026-10-13 需求方反馈）：所属列名（前端/测试…）+ 头像 + 昵称；
                「当前 x%」描述去除——当前档位直接看网格内高亮（蓝环）。 */}
            <span className="assignee-picker-who" data-testid="assignee-picker-who">
              <em className="marker-picker-label">{assigneePicker.colName}</em>
              <img className="assignee-picker-avatar" src={assigneePicker.avatar} alt="" width={22} height={22} />
              <span className="assignee-picker-name">{assigneePicker.name}</span>
            </span>
            <button
              type="button"
              data-testid="assignee-picker-close"
              className="marker-picker-close"
              title="关闭"
              aria-label="关闭"
              onClick={() => setAssigneePicker(null)}
            >
              ×
            </button>
          </div>
          <div className="marker-grid">
            {(MARKER_CATALOG.progress as readonly MarkerGlyphDef[]).map((def) => {
              // 高亮：当前进度落档（progressStageOf 1/8 步进——30% → p25 高亮，
              // 与 A 的进度徽章选盘同口径）；档值=PROGRESS_STAGE_PCT[slug] 写回。
              const active = def.value === progressStageOf(assigneePicker.progress);
              return (
                <button
                  key={def.value}
                  type="button"
                  data-testid={`assignee-picker-value-${def.value}`}
                  title={def.label}
                  aria-label={def.label}
                  aria-pressed={active}
                  className={active ? 'marker-btn active' : 'marker-btn'}
                  onClick={() => applyAssigneePickerValue(PROGRESS_STAGE_PCT[def.value as keyof typeof PROGRESS_STAGE_PCT])}
                >
                  <MarkerChip def={def} />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* 底栏（画布专属，2026-10-09 布局裁定：左计数 / 右定位中心·适应画布·缩放·
          全屏——全屏自工具栏迁入，!readOnly 闸维持移动端不装配口径）：表格视图
          隐藏（M7a-T4）；多画布（计划三 Task 2）左缘增画布页签条（企微形态；
          Task 3 裁定 7 起移动端只读同装配——readOnly 传 prop，页签可见可切换、
          编辑入口不装配），切换编排经 useActiveCanvas 接线 */}
      {view === 'mind' && (
        <footer className="editor-bottombar">
          <span className="node-count" data-testid="node-count">
            {nodeCount} 节点
          </span>
          {doc && (
            <CanvasTabBar
              doc={doc}
              canvases={canvases}
              activeCanvasId={activeCanvasId}
              showToast={showToast}
              onSwitch={switchCanvas}
              onChanged={refresh}
              readOnly={readOnly}
            />
          )}
          <div className="bottombar-right">
            <button
              data-testid="center-btn"
              title="定位中心（保持当前缩放）"
              onClick={centerRoot}
            >
              定位中心
            </button>
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
            {!readOnly && (
              <button
                data-testid="fullscreen-btn"
                className="bottombar-icon-btn"
                title="全屏（Esc 退出）"
                onClick={toggleFullscreen}
              >
                <FullscreenIcon />
              </button>
            )}
          </div>
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
        canvasId={activeCanvasId || undefined} // 快照预览取同 canvasId 画布（Task 4 item 11）
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
        memberIndex={memberIndex}
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* 图片大图预览（双击图片）：读操作，只读/移动端同样可开 */}
      {imagePreview && (
        <ImagePreview
          src={imagePreview.src}
          onClose={() => setImagePreview(null)}
          onCopyImage={() => copyNodeImage(imagePreview.nodeId, false, true)}
        />
      )}
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
          canvasId={canvasIdGetter} // 匹配集/替换 = 当前画布子树（Task 4 item 6）
        />
      )}
      <span hidden>{tick}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// core → engine 适配器（模块级纯函数，绑定 doc）
// ---------------------------------------------------------------------------
// readerOf/handleOf 已迁入 ../editor/useActiveCanvas（多画布计划三 Task 1：画布
// 绑定版，末位透传 canvasId 惰性解析），本文件自该模块导入。

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
