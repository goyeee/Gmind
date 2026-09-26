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
  markLastEditor,
  moveNode,
  ORIGIN_USER,
  pathToRoot,
  redo as coreRedo,
  ROOT_NODE_ID,
  setDocMeta,
  setHref,
  setImage,
  setIcon,
  setNote,
  setStyle,
  setText,
  subtreeIds,
  toggleCollapse,
  undo as coreUndo,
  withTransaction,
  type IconGroup,
} from '@gmind/core';
import {
  copyNodes,
  createScene,
  createCursorLayer,
  cutNodes,
  type CursorLayer,
  DragController,
  type DocReader,
  type Direction,
  type IDocHandle,
  layout,
  type LayoutResult,
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
  type TextStyle,
  siblingEnd,
  SelectionModel,
  THEMES,
  TextEditorOverlay,
  writeToSystemClipboard,
  Viewport,
} from '@gmind/engine';
import { attachKeyboardMap, isEditableTarget } from '../editor/keyboardMap';
import {
  clampImageSize,
  MAX_IMAGE_BYTES,
  readImageSize,
  uploadImage,
} from '../editor/imageUpload';
import { HelpPanel } from '../editor/HelpPanel';
import { MemberPanel } from '../editor/MemberPanel';
import { RichPanel } from '../editor/RichPanel';
import { CommentPanel, type CommentThreadView } from '../editor/CommentPanel';
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
 * M1 验收修复轮（2026-09-22）新增：空格进编辑态（FR-EDT-005）、粘贴为选中节点
 * 子级（FR-EDT-009，推翻旧「同级」实现）、链接角标新标签页打开（FR-EDT-019）、
 * 画布粘贴截图直插（FR-EDT-020，imageUpload 共享助手）、剪贴板错误码映射。
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

const STRUCTURE_OPTIONS: { value: string; label: string }[] = [
  { value: 'mindmap', label: '思维导图' },
  { value: 'logic', label: '逻辑图（向右）' },
  { value: 'org', label: '组织架构图' },
];

const THEME_OPTIONS: { value: string; label: string }[] = [
  { value: 'gmind-blue', label: '经典蓝' },
  { value: 'gmind-warm', label: '暖橙' },
  { value: 'gmind-accessible', label: '无障碍' },
];

/** 缩放快捷档位（Task 15 FR-EDT-027，PRD 50%~200%）。 */
const ZOOM_PRESETS = [50, 75, 100, 150, 200];

/** node_add/node_delete 埋点的操作方式（M5 Task 4，PRD 6.4「操作方式」）：键盘 /
 *  右键菜单 / 拖拽 / 粘贴。drag 当前无生产点（画布拖拽是 moveNode 移动，非增删），
 *  联合类型保留以对齐埋点契约；paste 一次粘贴动作记一行 node_add（多节点合并计数
 *  不拆行）。 */
type NodeVia = 'keyboard' | 'context' | 'drag' | 'paste';

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
  // 版本历史面板开合（M4 Task 8，FR-VER-004 UI）：装配模式同成员面板 open/onClose
  const [versionsOpen, setVersionsOpen] = useState(false);
  // 快捷键帮助面板开合（M5 Task 2，FR-EDT-007）：Ctrl/Cmd+? 经 keyboardMap onHelp
  // 与工具栏「快捷键」按钮双入口，均为 toggle 语义
  const [helpOpen, setHelpOpen] = useState(false);
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
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(
    null,
  );
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

  // 导出菜单外点关闭（菜单打开期间挂 document mousedown，命中按钮/菜单之外即收起）
  useEffect(() => {
    if (!exportOpen) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (exportWrapRef.current && !exportWrapRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [exportOpen]);

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

  const fitCanvas = (): void => {
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const lay = layoutRef.current;
    if (!vp || !svgEl) return;
    vp.fit(
      lay ?? { nodes: [], width: 0, height: 0 },
      { w: svgEl.clientWidth, h: svgEl.clientHeight },
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

  /** 主选中节点：恰好单选返回该节点，否则以 root 为操作锚点。 */
  const primaryId = (): string => {
    const selection = selectionRef.current;
    if (selection && selection.selected.size === 1) {
      const [id] = selection.selected;
      return id;
    }
    return ROOT_NODE_ID;
  };

  /** 打开既有节点编辑覆盖层（双击/后续交互入口）。 */
  const openNodeEditor = (id: string): void => {
    if (!doc) return;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    const box = boxesRef.current.find((b) => b.id === id);
    if (!vp || !svgEl || !box) return;
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    const rect = svgEl.getBoundingClientRect();
    const p = vp.toScreen(box.x, box.y);
    overlay.open({
      anchorRect: {
        x: rect.left + window.scrollX + p.x,
        y: rect.top + window.scrollY + p.y,
        w: box.w * vp.scale,
        h: box.h * vp.scale,
      },
      scale: vp.scale,
      value: snap.text,
      onCommit: (text) => {
        try {
          setText(doc, id, text, ORIGIN_USER);
          afterUserWrite();
        } catch (e) {
          showToast(e instanceof Error ? e.message : '保存失败');
        }
      },
      onCancel: () => undefined,
      onTruncated: () => showToast('节点文本长度已达上限'),
    });
    selectionRef.current?.selectOnly(id);
  };

  /**
   * 新建节点进编辑态（Tab/Enter）：先开空编辑器，提交时在**单个 user 事务**内
   * addChild + setText——保证一次 Ctrl+Z 撤销整个新建（undo captureTimeout 之外
   * 的两次分立写会拆成两个撤销单元，用例 4 依赖单步撤销语义）。
   * via（M5 Task 4）：node_add 埋点的操作方式——键盘（Tab/Enter）与右键菜单
   * （插入子级/同级）共用本入口，由调用方告知。
   */
  const openNewNodeEditor = (
    parentId: string,
    index: number | undefined,
    anchorBox: NodeBox | null,
    relation: 'child' | 'sibling',
    via: NodeVia = 'keyboard',
  ): void => {
    if (addBlockedByQuota()) return; // 配额拦截（Tab 插子级/Enter 插同级/右键菜单共用本入口）
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!vp || !svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const base = anchorBox ?? {
      id: '',
      x: 0,
      y: 0,
      w: 120,
      h: 36,
      side: 'right' as const,
      depth: 1,
    };
    const dy = base.h + 8;
    const dx = relation === 'child' ? base.w * 0.4 + 24 : 0;
    const p = vp.toScreen(base.x + dx, base.y + dy);
    overlay.open({
      anchorRect: {
        x: rect.left + window.scrollX + p.x,
        y: rect.top + window.scrollY + p.y,
        w: 140 * vp.scale,
        h: 36 * vp.scale,
      },
      scale: vp.scale,
      value: '',
      onCommit: (text) => {
        if (!doc) return;
        try {
          let createdId = '';
          withTransaction(doc, ORIGIN_USER, () => {
            createdId = addChild(doc, parentId, index === undefined ? { text } : { index, text });
          });
          afterUserWrite();
          // node_add 埋点（M5 Task 4）：写入成功才上报；nodeCount 为写后可达活跃数
          track('node_add', { via, nodeCount: countAliveReachable(doc) }, fileId);
          if (createdId) selectionRef.current?.selectOnly(createdId);
          fitPendingRef.current = true; // 重渲染后适应画布，新节点必可见
        } catch (e) {
          showToast(e instanceof Error ? e.message : '新建失败');
        }
      },
      onCancel: () => undefined,
      onTruncated: () => showToast('节点文本长度已达上限'),
    });
  };

  const handleEnter = (): void => {
    if (!doc) return;
    const current = primaryId();
    const snap = getNode(doc, current);
    if (!snap || snap.deleted) return;
    if (current === ROOT_NODE_ID) {
      // root 无同级：降级为新建子级
      openNewNodeEditor(
        ROOT_NODE_ID,
        undefined,
        boxesRef.current.find((b) => b.id === ROOT_NODE_ID) ?? null,
        'child',
      );
      return;
    }
    const parent = getNode(doc, snap.parentId);
    if (!parent || parent.deleted) return;
    openNewNodeEditor(
      parent.id,
      parent.childIds.indexOf(current) + 1,
      boxesRef.current.find((b) => b.id === current) ?? null,
      'sibling',
    );
  };

  /**
   * Shift+Tab（PRD FR-EDT-001，fix round 1 修正）：在与父节点之间插入新父 = P→N→C——
   * 新节点插入**当前节点父**的 children 中当前节点原 index 处，随后当前节点换父到新节点
   * （原子树跟随）。旧实现插到祖父层会让 P 平白失去子节点，N 与 P 并排为空节点，违反 PRD。
   */
  const createOutdent = (parentId: string, index: number, currentId: string): void => {
    if (!doc) return;
    if (addBlockedByQuota()) return; // Shift+Tab 会新增节点，同受配额拦截
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        const newId = addChild(doc, parentId, { index });
        moveNode(doc, currentId, newId); // 缺省 index：追加为新节点末子级
      });
      afterUserWrite();
      track('node_add', { via: 'keyboard', nodeCount: countAliveReachable(doc) }, fileId);
      fitPendingRef.current = true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : '操作失败');
    }
  };

  const handleTab = (shift: boolean): void => {
    if (!doc) return;
    const current = primaryId();
    const snap = getNode(doc, current);
    if (!snap || snap.deleted) return;
    if (!shift) {
      openNewNodeEditor(
        current,
        undefined,
        boxesRef.current.find((b) => b.id === current) ?? null,
        'child',
      );
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
    createOutdent(parent.id, parent.childIds.indexOf(current), current);
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
    const g = target.closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (!id) return;
    // FR-EDT-008：Ctrl/Cmd+点击 = 加/减选；Shift+点击让位给框选起点（无操作，
    // 裁决：右键已被 contextmenu 占用，框选 = Shift+左键拖拽）
    if (e.shiftKey) return;
    if (e.ctrlKey || e.metaKey) {
      selection.toggle(id);
      return;
    }
    selection.selectOnly(id);
  };

  /** Shift+左键在空白处按下 → 引擎 beginMarquee（scene 坐标）+ 起画橡皮筋。 */
  const onSvgPointerDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0 || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    const selection = selectionRef.current;
    const vp = viewportRef.current;
    const svgEl = svgRef.current;
    if (!selection || !vp || !svgEl) return;
    const target = e.target as Element;
    if (target.closest('[data-node-id]') || target.closest('[data-for-id]')) return;
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
    const g = (e.target as Element).closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (!id || !doc) {
      setContextMenu(null);
      return;
    }
    const snap = getNode(doc, id);
    if (!snap || snap.deleted) return;
    selectionRef.current?.selectOnly(id);
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: id });
  };

  const runMenuAction = (action: string): void => {
    const menu = contextMenu;
    setContextMenu(null);
    if (!menu || !doc) return;
    const nodeBox = boxesRef.current.find((b) => b.id === menu.nodeId) ?? null;
    switch (action) {
      case 'insert-child':
        openNewNodeEditor(menu.nodeId, undefined, nodeBox, 'child', 'context');
        break;
      case 'insert-sibling': {
        if (menu.nodeId === ROOT_NODE_ID) {
          openNewNodeEditor(ROOT_NODE_ID, undefined, nodeBox, 'child', 'context');
          break;
        }
        const snap = getNode(doc, menu.nodeId);
        const parent = snap ? getNode(doc, snap.parentId) : null;
        if (!snap || !parent || parent.deleted) break;
        openNewNodeEditor(
          parent.id,
          parent.childIds.indexOf(menu.nodeId) + 1,
          nodeBox,
          'sibling',
          'context',
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
      // 视口包装层（fix round 1）：createScene 的边/节点两层是 svg 直接子元素，
      // Viewport 只transform单个 g——必须包一层同时携带两层，否则平移/缩放时边脱节点。
      const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      wrapper.setAttribute('class', 'gm-viewport');
      wrapper.appendChild(scene.edgesLayer);
      wrapper.appendChild(scene.nodesLayer);
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
        onDrop: (id, targetId) => {
          justDraggedRef.current = true;
          setTimeout(() => {
            justDraggedRef.current = false;
          }, 0);
          try {
            moveNode(d, id, targetId ?? ROOT_NODE_ID); // 缺省 index：追加末尾（carry-in 裁决 7）
            afterUserWrite();
            fitPendingRef.current = true;
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

      const result = layout(reader, {
        structure: m.structureType,
        theme,
        measure,
        // carry-in 裁决 2：样式闭合 doc 读取
        styleOf: (id, depth) =>
          resolveNodeStyle(theme, depth, getNode(d, id)?.style ?? {}).textStyle,
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
        });
      }
      renderScene(scene, {
        layout: result,
        theme,
        styleOf: (id) => resolveNodeStyle(theme, depthById.get(id) ?? 0, getNode(d, id)?.style ?? {}),
        nodeData,
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
          // 重连无待同步变更时不会有 persisted ack，主动清掉离线指示；
          // 有待同步变更则等 ack 收尾（先落到「保存中」）
          if (collab.provider.hasUnsyncedChanges) setStatus('保存中…');
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
      onPresence: (next) => setMembers(next),
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
    requestAnimationFrame(() => fitCanvas());
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
      stopSave();
      collabHandleRef.current = null;
      quotaBlockedRef.current = false; // 文件切换不继承上一文件的配额拦截
      collab.destroy(); // provider + IndexedDB 本地副本一并收尾（顺序：先冲刷 saveLoop 决策再断链）
      commentsRefreshRef.current = null; // 文件切换不继承上一文件的评论刷新入口
      commentCountsRef.current = {};
      setComments({ threads: [], counts: {} });
      setCommentFilter(null);
      cursorLayerRef.current = null;
      remoteCursorsRef.current = [];
      setMembers([]);
      detachKeys?.();
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
        <button data-testid="back-btn" title="返回工作台" onClick={() => navigate('/workspace')}>
          ←
        </button>
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
              title="评论"
              onClick={() => setCommentsOpen((v) => !v)}
            >
              评论
            </button>
          </>
        ) : (
          <>
        <select
          data-testid="structure-select"
          value={meta?.structureType ?? 'mindmap'}
          onChange={(e) => {
            if (!doc) return;
            setDocMeta(doc, { structureType: e.target.value as 'mindmap' | 'logic' | 'org' }, ORIGIN_USER);
            afterUserWrite();
          }}
        >
          {STRUCTURE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          data-testid="theme-select"
          value={themeId}
          onChange={(e) => {
            if (!doc) return;
            setDocMeta(doc, { themeId: e.target.value }, ORIGIN_USER);
            afterUserWrite();
          }}
        >
          {THEME_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button data-testid="undo-btn" title="撤销 (Ctrl+Z)" onClick={() => um && coreUndo(um)}>
          撤销
        </button>
        <button data-testid="redo-btn" title="重做 (Ctrl+Y)" onClick={() => um && coreRedo(um)}>
          重做
        </button>
        <button data-testid="fullscreen-btn" title="全屏（Esc 退出）" onClick={toggleFullscreen}>
          全屏
        </button>
        {/* 导出菜单（M4 Task 5，FR-IO-004）：XMind + PNG/JPG（Task 9 就地追加，
            不改动既有 XMind 项）。文件名与 header 标题同源 getMeta(doc).title。 */}
        <div className="export-wrap" ref={exportWrapRef}>
          <button data-testid="export-menu" onClick={() => setExportOpen((v) => !v)}>
            导出
          </button>
          {exportOpen && (
            <div className="export-menu" role="menu">
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
        {/* 版本历史（M4 Task 8，FR-VER-004 UI）：时间轴/只读预览/一键恢复入口 */}
        <button data-testid="versions-toggle" title="版本历史" onClick={() => setVersionsOpen((v) => !v)}>
          版本历史
        </button>
        {/* 快捷键帮助（M5 Task 2，FR-EDT-007）：工具栏入口，Ctrl/Cmd+? 同一开关 */}
        <button
          data-testid="help-toggle"
          title="快捷键帮助 (Ctrl+?)"
          onClick={() => setHelpOpen((v) => !v)}
        >
          快捷键
        </button>
        <button
          data-testid="members-btn"
          title="在线成员"
          onClick={() => setMembersOpen((v) => !v)}
        >
          成员
          <span className="members-badge" data-testid="members-count">
            {members.length}
          </span>
        </button>
          </>
        )}
      </header>

      <div className="editor-main">
        <div className="editor-canvas">
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
        </div>

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
          <div className="editor-right">
            {doc && um && selectedNodeId && (
              <RichPanel
                doc={doc}
                fileId={fileId}
                nodeId={selectedNodeId}
                afterUserWrite={afterUserWrite}
                showToast={showToast}
              />
            )}
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

      {!readOnly && contextMenu && (
        <div
          className="context-menu"
          data-testid="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {(
            [
              ['insert-child', '插入子级'],
              ['insert-sibling', '插入同级'],
              ['toggle-collapse', '折叠/展开'],
              ['copy', '复制'],
              ['cut', '剪切'],
              ['paste', '粘贴'],
              ['delete', '删除'],
            ] as const
          ).map(([action, label]) => (
            <button key={action} onClick={() => runMenuAction(action)}>
              {label}
            </button>
          ))}
        </div>
      )}

      <footer className="editor-bottombar">
        <button data-testid="fit-btn" onClick={fitCanvas}>
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
      <MemberPanel
        members={members}
        ownerUserId={ownerUserId}
        open={membersOpen}
        onClose={() => setMembersOpen(false)}
        fileId={fileId}
        canInvite={meId !== '' && meId === ownerUserId}
        showToast={showToast}
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
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

/** @gmind/core 读 API → engine DocReader。 */
function readerOf(d: Y.Doc): DocReader {
  return {
    getMeta: () => getMeta(d),
    getNode: (id) => getNode(d, id),
    childrenIds: (id) => childrenIds(d, id),
  };
}

/** @gmind/core 写 API → engine IDocHandle（origin 缺省 ORIGIN_USER）。 */
function handleOf(d: Y.Doc): IDocHandle {
  return {
    ...readerOf(d),
    addChild: (parentId, opts, origin) => addChild(d, parentId, opts, origin ?? ORIGIN_USER),
    setText: (id, text, origin) => setText(d, id, text, origin ?? ORIGIN_USER),
    setNote: (id, note, origin) => setNote(d, id, note, origin ?? ORIGIN_USER),
    setHref: (id, href, origin) => setHref(d, id, href, origin ?? ORIGIN_USER),
    setImage: (id, image, origin) => setImage(d, id, image, origin ?? ORIGIN_USER),
    setIcon: (id, group, value, origin) =>
      setIcon(d, id, group as IconGroup, value, origin ?? ORIGIN_USER),
    setStyle: (id, patch, origin) => setStyle(d, id, patch, origin ?? ORIGIN_USER),
  };
}
