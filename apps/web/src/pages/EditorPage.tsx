import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type * as Y from 'yjs';
import {
  addChild,
  capUndoStack,
  childrenIds,
  countAlive,
  deleteNodes,
  getMeta,
  getNode,
  moveNode,
  ORIGIN_USER,
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
  cutNodes,
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
import { attachKeyboardMap } from '../editor/keyboardMap';
import { RichPanel } from '../editor/RichPanel';
import { startSaveLoop } from '../editor/saveLoop';
import { useEditorDoc } from '../editor/useEditorDoc';
import { api } from '../api/client';
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

export function EditorPage() {
  const { fileId = '' } = useParams();
  const navigate = useNavigate();
  const { state, error, setTitle } = useEditorDoc(fileId);
  const doc = state?.doc ?? null;
  const um = state?.um ?? null;

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
  // 框选橡皮筋（Task 15 FR-EDT-008）：svg 直挂的 <rect class="gm-marquee">（不进
  // wrapper——橡皮筋按 svg 相对 screen 坐标自绘，不受视口 transform），锚点同步记
  // screen 坐标供 move 阶段重绘。
  const marqueeRectRef = useRef<SVGRectElement | null>(null);
  const marqueeAnchorScreenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState('尚未编辑');
  const [toast, setToast] = useState('');
  const [zoomPct, setZoomPct] = useState(100);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(
    null,
  );
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (message: string): void => {
    setToast(message);
    if (toastTimer.current !== null) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };

  /** 所有用户写后统一调用（carry-in 裁决：capUndoStack 集中封装）。 */
  const afterUserWrite = (): void => {
    if (um) capUndoStack(um);
  };

  const syncZoom = (): void => {
    const vp = viewportRef.current;
    if (vp) setZoomPct(Math.round(vp.scale * 100));
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
   */
  const openNewNodeEditor = (
    parentId: string,
    index: number | undefined,
    anchorBox: NodeBox | null,
    relation: 'child' | 'sibling',
  ): void => {
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
    try {
      withTransaction(doc, ORIGIN_USER, () => {
        const newId = addChild(doc, parentId, { index });
        moveNode(doc, currentId, newId); // 缺省 index：追加为新节点末子级
      });
      afterUserWrite();
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

  const handleDelete = (): void => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected];
    if (ids.length === 0) return;
    try {
      deleteNodes(doc, ids, ORIGIN_USER); // root 含其中时降级为清空子级
      afterUserWrite();
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
    await writeToSystemClipboard(copyNodes(readerOf(doc), ids));
  };

  const handleCut = async (): Promise<void> => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    const ids = [...selection.selected].filter((id) => id !== ROOT_NODE_ID);
    if (ids.length === 0) return;
    writeToSystemClipboard(
      cutNodes(handleOf(doc), ids, (deleteIds) => {
        deleteNodes(doc, deleteIds, ORIGIN_USER);
        afterUserWrite();
      }),
    );
    selection.selectOnly(ROOT_NODE_ID);
  };

  const handlePaste = async (): Promise<void> => {
    if (!doc) return;
    const selection = selectionRef.current;
    if (!selection) return;
    // 语义：有单选 → 粘贴为其同级（选中位置之后）；否则追加到 root 末尾
    let parentId = ROOT_NODE_ID;
    let index: number | undefined;
    const sel = [...selection.selected];
    if (sel.length === 1 && sel[0] !== ROOT_NODE_ID) {
      const snap = getNode(doc, sel[0]);
      if (snap && !snap.deleted) {
        const parent = getNode(doc, snap.parentId);
        if (parent && !parent.deleted) {
          parentId = parent.id;
          index = parent.childIds.indexOf(sel[0]) + 1;
        }
      }
    }
    try {
      const clip = await readFromSystemClipboard();
      const idx = index ?? getNode(doc, parentId)?.childIds.length ?? 0;
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
    } catch (e) {
      showToast(e instanceof Error ? e.message : '粘贴失败');
    }
  };

  // —— 画布指针交互（点击选择 / 框选 / 徽标折叠 / 双击编辑） ——

  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>): void => {
    if (justDraggedRef.current) return; // 拖拽释放后浏览器合成的 click：忽略（carry-in 裁决）
    const selection = selectionRef.current;
    if (!doc || !selection) return;
    const target = e.target as Element;
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
    const g = (e.target as Element).closest('[data-node-id]');
    const id = g?.getAttribute('data-node-id');
    if (id) openNodeEditor(id);
  };

  // —— 右键菜单（Task 12）：动作复用与键盘相同的 core/engine 处理器 ——

  const onSvgContextMenu = (e: React.MouseEvent<SVGSVGElement>): void => {
    e.preventDefault();
    if (justDraggedRef.current) return;
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
        openNewNodeEditor(menu.nodeId, undefined, nodeBox, 'child');
        break;
      case 'insert-sibling': {
        if (menu.nodeId === ROOT_NODE_ID) {
          openNewNodeEditor(ROOT_NODE_ID, undefined, nodeBox, 'child');
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
        );
        break;
      }
      case 'delete':
        handleDelete();
        break;
      case 'copy':
        void handleCopy();
        break;
      case 'cut':
        void handleCut();
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
  const nodeCount = doc ? countAlive(doc) : 0;
  const selectionNow = selectionRef.current;
  const selectedNodeId =
    selectionNow && selectionNow.selected.size === 1
      ? ([...selectionNow.selected][0] ?? null)
      : null;

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
        });
      }
      renderScene(scene, {
        layout: result,
        theme,
        styleOf: (id) => resolveNodeStyle(theme, depthById.get(id) ?? 0, getNode(d, id)?.style ?? {}),
        nodeData,
      });
      applySelectionClasses();
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

    rebuildScene();
    themeRef.current = resolveThemeId(getMeta(d).themeId);
    const stopSave = startSaveLoop(d, fileId, setStatus);
    const detachKeys = attachKeyboardMap({
      // 覆盖层打开即让路（其 Enter/Esc 已 stopPropagation，此为其余按键的兜底）
      isEditorOpen: () => overlay.isOpen,
      undo: () => coreUndo(manager),
      redo: () => coreRedo(manager),
      onEnter: handleEnter,
      onTab: handleTab,
      onDelete: handleDelete,
      onSelectAll: handleSelectAll,
      onToggleCollapse: handleToggleCollapse,
      onNavigate: handleNavigate,
      onSiblingEnd: handleSiblingEnd,
      onCopy: () => void handleCopy(),
      onCut: () => void handleCut(),
      onPaste: () => void handlePaste(),
    });

    const onDocUpdate = (): void => scheduleRerender();
    d.on('update', onDocUpdate);
    const onWheelSync = (): void => {
      requestAnimationFrame(syncZoom);
    };
    svgEl.addEventListener('wheel', onWheelSync);

    rerender();
    selection.selectOnly(ROOT_NODE_ID); // 默认选中中心主题（「选中 root 按 Tab」起点）
    requestAnimationFrame(() => fitCanvas());

    return () => {
      cancelAnimationFrame(rafId);
      scheduled = false;
      svgEl.removeEventListener('wheel', onWheelSync);
      d.off('update', onDocUpdate);
      stopSave();
      detachKeys();
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
  }, [state, fileId]);

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
        <span className="save-status" data-testid="save-status">
          {status}
        </span>
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

        {doc && um && selectedNodeId && (
          <RichPanel
            doc={doc}
            fileId={fileId}
            nodeId={selectedNodeId}
            afterUserWrite={afterUserWrite}
            showToast={showToast}
          />
        )}
      </div>

      {contextMenu && (
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
      <span hidden>{tick}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// core → engine 适配器（模块级纯函数，绑定 doc）
// ---------------------------------------------------------------------------

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
