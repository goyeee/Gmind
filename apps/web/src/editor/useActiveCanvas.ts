/**
 * 画布状态中枢（多画布计划三 Task 1）：activeCanvasId 单一事实源 + reader/handle
 * 画布绑定 + 切换编排。EditorPage（已 4700+ 行）只接线不加肉——编排逻辑全部在
 * 本文件的 controller 层（纯 TS、无 DOM/React 依赖，单测直钉）；useActiveCanvas
 * 是做 React 状态镜像与 Y 观察器装配的薄壳。
 *
 * 语义裁定（对齐 docs/superpowers/specs/2026-10-21-multi-canvas-ruling.md 与
 * 2026-10-22-multi-canvas-web.md）：
 * - activeCanvasId 是**本地视图态**（EditorPage activeCanvasIdRef 为全部写路径的
 *   透传源）；meta.activeCanvasId 仅作 LWW 持久化（装载恢复上次画布）。远端改写
 *   meta.activeCanvasId **不**强拽本地视图——远端增/删/改名/排序经观察器只刷新
 *   画布列表；唯一例外 = 当前画布被远端删除，reconcileActive 同步回退（显式
 *   canvasId 读路径遇墓碑画布抛 CANVAS_NOT_FOUND，回退必须先于下一次 rerender，
 *   Y 观察器事务提交时同步触发，时序天然满足）。回退编排**丢弃**在途行内编辑
 *   （discardEphemeral）——提交写会按仍指墓碑的 activeCanvasIdRef 解析画布而抛错，
 *   异常在观察器回调内无捕获会中断回退（Important 修复）。
 * - 撤销不跨画布（裁定 2）：UndoManager 经 core createUndoManager(doc, canvasId)
 *   scope=画布子图，每画布缓存一个实例（来回切换保住各自撤销栈）。
 * - idPrefix 契约：createScene 前缀只从画布 id 派生（canvasIdPrefix），禁止从
 *   画布名派生。
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type * as Y from 'yjs';
import {
  addChild,
  childrenIds,
  createUndoManager,
  getMeta,
  getNode,
  listCanvases,
  listSummaries,
  ORIGIN_USER,
  resolveCanvasId,
  sanitizeCustomForDoc,
  setActiveCanvas,
  setCustomField,
  setDescription,
  setHref,
  setIcon,
  setImage,
  setNote,
  setStyle,
  setText,
  canvasOrderArr,
  canvasesMap,
  type CanvasInfo,
  type IconGroup,
} from '@gmind/core';
import type { DocReader, IDocHandle, ViewportState } from '@gmind/engine';

/** 画布 id 惰性解析器：空串/undefined = 缺省解析（core resolveCanvasId 回退链）。 */
export type CanvasIdGetter = () => string | undefined;

/** createScene idPrefix 契约：只从画布 id（ULID/迁移常量）派生，禁止从画布名派生。 */
export function canvasIdPrefix(canvasId: string): string {
  return `c${canvasId}-`;
}

// ---------------------------------------------------------------------------
// core → engine 适配器（自 EditorPage 迁入，画布绑定版）
// ---------------------------------------------------------------------------

/** @gmind/core 读 API → engine DocReader；canvasId 惰性解析（调用时取当前值）。 */
export function readerOf(d: Y.Doc, canvasId?: CanvasIdGetter): DocReader {
  const cid = (): string | undefined => canvasId?.();
  return {
    getMeta: () => getMeta(d, cid()),
    getNode: (id) => getNode(d, id, cid()),
    childrenIds: (id) => childrenIds(d, id, cid()),
    summaries: () => listSummaries(d, cid()),
  };
}

/** @gmind/core 写 API → engine IDocHandle（origin 缺省 ORIGIN_USER，末位透传画布）。 */
export function handleOf(d: Y.Doc, canvasId?: CanvasIdGetter): IDocHandle {
  const cid = (): string | undefined => canvasId?.();
  return {
    ...readerOf(d, canvasId),
    addChild: (parentId, opts, origin) => addChild(d, parentId, opts, origin ?? ORIGIN_USER, cid()),
    setText: (id, text, origin) => setText(d, id, text, origin ?? ORIGIN_USER, cid()),
    setNote: (id, note, origin) => setNote(d, id, note, origin ?? ORIGIN_USER, cid()),
    setDescription: (id, text, origin) => setDescription(d, id, text, origin ?? ORIGIN_USER, cid()),
    setHref: (id, href, origin) => setHref(d, id, href, origin ?? ORIGIN_USER, cid()),
    setImage: (id, image, origin) => setImage(d, id, image, origin ?? ORIGIN_USER, cid()),
    setIcon: (id, group, value, origin) =>
      setIcon(d, id, group as IconGroup, value, origin ?? ORIGIN_USER, cid()),
    setStyle: (id, patch, origin) => setStyle(d, id, patch, origin ?? ORIGIN_USER, cid()),
    // custom 透传（engine 剪贴板粘贴路径）：先按目标文档 schema 过滤（未知列/类型
    // 不符静默丢弃——core sanitizeCustomForDoc 单源，页面不做目录判断），再逐键经
    // setCustomField 落写（过滤后必合法不抛，粘贴不因跨文档未知列半途失败）。
    setCustomFields: (id, custom, origin) => {
      const sanitized = sanitizeCustomForDoc(d, custom);
      if (sanitized === null) return;
      for (const [colId, value] of Object.entries(sanitized)) {
        setCustomField(d, id, colId, value, origin ?? ORIGIN_USER, cid());
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 切换编排 controller（纯 TS；单测直钉）
// ---------------------------------------------------------------------------

/** 视图侧接线面（EditorPage 装配闭包桥出；未装配时各实现须 no-op 安全）。 */
export interface CanvasSwitchDeps {
  /** 当前视口快照（vp.getState()）；无视口（未装配/已拆卸）→ null。 */
  captureViewport(): ViewportState | null;
  /** 重建场景绑定新画布并恢复视口：saved=null = 首访无存档 → 由实现安排 fit。 */
  rebuildForCanvas(canvasId: string, saved: ViewportState | null): void;
  /** 清空选区 / 处理在途行内编辑 / 作废 pending 新建等临时态。
   *  discardInlineEdit=true（reconcile 回退路径，旧画布已墓碑化）：行内编辑**丢弃**
   *  不提交——提交写按 activeCanvasIdRef（仍指墓碑画布）解析画布会抛
   *  CANVAS_NOT_FOUND，而异常发生在 Y 观察器回调内，会中断回退编排。 */
  resetEphemeral(discardInlineEdit?: boolean): void;
}

export interface ActiveCanvasControllerEvents {
  /** 活动画布变更的同步回调（ref 桥接先于场景重建就位；React setState 镜像）。 */
  onActiveChange?(canvasId: string): void;
}

export interface ActiveCanvasController {
  /** 当前活动画布（本地视图态唯一事实源）。 */
  readonly activeCanvasId: string;
  /** 存活画布列表（listCanvases 口径，canvasOrder 序）。 */
  list(): CanvasInfo[];
  /** 当前画布的 UndoManager（懒建 + 每画布缓存一个实例）。 */
  um(): Y.UndoManager;
  /** 切换编排；同 id 幂等（零步骤）。目标不存在由 core setActiveCanvas 抛错。
   *  opts.discardEphemeral = reconcile 回退路径专用：丢弃在途行内编辑（旧画布已
   *  墓碑化，提交写必抛 CANVAS_NOT_FOUND 且会中断回退编排）。 */
  switchCanvas(canvasId: string, opts?: { discardEphemeral?: boolean }): void;
  /** 活动画布被删（远端/本端）后的同步回退：存活则 no-op。 */
  reconcileActive(): void;
  /** 销毁全部缓存 UM（doc 切换/卸载）。 */
  destroy(): void;
}

export function createActiveCanvasController(
  doc: Y.Doc,
  deps: CanvasSwitchDeps,
  events: ActiveCanvasControllerEvents = {},
): ActiveCanvasController {
  let activeId = resolveCanvasId(doc);
  const viewportStates = new Map<string, ViewportState>();
  const undoManagers = new Map<string, Y.UndoManager>();

  const umFor = (canvasId: string): Y.UndoManager => {
    const cached = undoManagers.get(canvasId);
    if (cached) return cached;
    const created = createUndoManager(doc, canvasId);
    undoManagers.set(canvasId, created);
    return created;
  };
  umFor(activeId); // 初始画布 UM 预建（首装即绑定撤销栈）

  const switchCanvas = (target: string, opts: { discardEphemeral?: boolean } = {}): void => {
    if (target === activeId) return; // 同画布幂等
    // 临时态清理先于文档写（编排顺序对 brief 的唯一微调）：行内编辑提交
    // （overlay.close(true) → setText）与 pending 回收落在旧画布——置
    // activeCanvasId 之后再 close，写路径会解析到新画布而节点查无。
    // reconcile 路径（discardEphemeral）丢弃在途编辑：旧画布已被删成墓碑，
    // 提交写按 activeCanvasIdRef（仍指墓碑）解析画布必抛 CANVAS_NOT_FOUND，
    // 异常在 Y 观察器回调内无捕获，会中断回退编排（Important 修复）。
    deps.resetEphemeral(opts.discardEphemeral === true);
    const snap = deps.captureViewport();
    if (snap !== null) viewportStates.set(activeId, snap); // null 不覆盖已存档位
    setActiveCanvas(doc, target); // ORIGIN_SYSTEM（core 内置）；校验先于事务，抛错即零写
    activeId = target;
    events.onActiveChange?.(target); // 同步桥：activeCanvasIdRef/umRef 先于重建就位
    umFor(target);
    deps.rebuildForCanvas(target, viewportStates.get(target) ?? null);
  };

  const reconcileActive = (): void => {
    const infos = listCanvases(doc);
    if (infos.some((info) => info.id === activeId)) return;
    // 全灭（crafted 态，正常路径不可达——core 禁删最后一张）：无回退目标，保持现状
    if (infos.length === 0) return;
    // 丢弃在途行内编辑（旧画布已墓碑化，提交写必抛 CANVAS_NOT_FOUND 中断回退）
    switchCanvas(resolveCanvasId(doc), { discardEphemeral: true });
  };

  return {
    get activeCanvasId() {
      return activeId;
    },
    list: () => listCanvases(doc),
    um: () => umFor(activeId),
    switchCanvas,
    reconcileActive,
    destroy: () => {
      for (const manager of undoManagers.values()) manager.destroy();
      undoManagers.clear();
      viewportStates.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// React 薄壳
// ---------------------------------------------------------------------------

export interface ActiveCanvasState {
  /** 当前活动画布（React 镜像；写路径请用 activeCanvasIdRef 读当帧值）。 */
  activeCanvasId: string;
  /** 存活画布列表（页签条数据源，Task 2 消费；远端增删改名排序经观察器即时反映）。 */
  canvases: CanvasInfo[];
  /** 当前画布 UndoManager（撤销/重做入口；null = 未装配）。 */
  um: Y.UndoManager | null;
  /** 当帧活动画布 ref：全部写路径透传 canvasId 的唯一源（同步于切换编排）。 */
  activeCanvasIdRef: MutableRefObject<string>;
  /** 当帧 UndoManager ref：装配闭包（键盘映射等）读，免 React 提交延迟。 */
  umRef: MutableRefObject<Y.UndoManager | null>;
  switchCanvas(canvasId: string): void;
  /** 重读画布列表 + 回退校验（观察器已自动覆盖，本入口为画布管理写后的显式刷新）。 */
  refresh(): void;
}

/**
 * @param doc 已装载文档（null = 未装载/已卸载）。
 * @param deps 视图侧接线面——**必须稳定**（useMemo 空依赖、闭包只读 ref）：身份
 *   变化会重建 controller（丢弃 UM 缓存与视口存档）。
 */
export function useActiveCanvas(doc: Y.Doc | null, deps: CanvasSwitchDeps): ActiveCanvasState {
  const activeCanvasIdRef = useRef('');
  const umRef = useRef<Y.UndoManager | null>(null);
  const controllerRef = useRef<ActiveCanvasController | null>(null);
  const [activeCanvasId, setActiveCanvasId] = useState('');
  const [canvases, setCanvases] = useState<CanvasInfo[]>([]);
  const [um, setUm] = useState<Y.UndoManager | null>(null);

  useEffect(() => {
    if (!doc) {
      controllerRef.current = null;
      activeCanvasIdRef.current = '';
      umRef.current = null;
      setActiveCanvasId('');
      setCanvases([]);
      setUm(null);
      return;
    }
    const controller = createActiveCanvasController(doc, deps, {
      onActiveChange: (id) => {
        activeCanvasIdRef.current = id; // 同步桥先于 rebuildForCanvas 就位
        const manager = controller.um();
        umRef.current = manager;
        setActiveCanvasId(id);
        setUm(manager);
      },
    });
    controllerRef.current = controller;
    activeCanvasIdRef.current = controller.activeCanvasId;
    const manager = controller.um();
    umRef.current = manager;
    setActiveCanvasId(controller.activeCanvasId);
    setCanvases(controller.list());
    setUm(manager);

    // 画布集观察：远端增/删/改名/排序即时反映（页签条数据源）；当前画布被删 →
    // 同步回退编排（Y 观察器事务提交时同步触发，先于 rAF 重排，读路径不会读到
    // 墓碑画布）。meta.activeCanvasId 的远端改写**不**强拽本地视图（本地视图态
    // 裁定，见文件头注）。
    const onCanvasesChange = (): void => {
      setCanvases(controller.list());
      controller.reconcileActive();
    };
    const observed = canvasesMap(doc);
    const order = canvasOrderArr(doc);
    observed.observeDeep(onCanvasesChange);
    order.observe(onCanvasesChange);
    return () => {
      observed.unobserveDeep(onCanvasesChange);
      order.unobserve(onCanvasesChange);
      controller.destroy();
      controllerRef.current = null;
    };
  }, [doc, deps]);

  const switchCanvas = useCallback((id: string): void => {
    controllerRef.current?.switchCanvas(id);
  }, []);
  const refresh = useCallback((): void => {
    const controller = controllerRef.current;
    if (!controller) return;
    setCanvases(controller.list());
    controller.reconcileActive();
  }, []);

  return { activeCanvasId, canvases, um, activeCanvasIdRef, umRef, switchCanvas, refresh };
}
