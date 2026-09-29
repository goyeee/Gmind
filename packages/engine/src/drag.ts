/**
 * 节点拖拽：换父 / 同级排序插入 — M1b Task 9 起步，M7c-D1 按企微对标 spec P0-2 重做。
 *
 * M7c-D1 落点三分语义（需求方原话「拖动的功能简直糟糕透了，我都没看懂逻辑是啥」）：
 * - 拖到目标节点**本体**（盒中线 ±25% 区域）= 变其子级（追加末尾，M1b 语义保留）；
 * - 拖到盒子**边缘插入带**（上下各 25%；side='down' 的 org 结构兄弟横排，带在左右）
 *   = 同级插入：悬停 100ms 显示插入指示线（`gm-drop-indicator`，横线盖在间隙上，
 *   org 为竖线），释放调 core moveNode(id, anchor.parentId, index) 按落点排序——
 *   index 由 childrenIdsOf 文档序 + 锚点位次结算，同父移动做「先移除后插入」的
 *   前移修正（纪律#2：纯计算，全部在事务之外）；
 * - 拖到**空白** = 移为 root 子级末尾（现状保留）。
 * - 自身/自身后代仍是禁止目标（fix round 1）：整盒含边缘带一律 drop-forbidden、
 *   释放静默取消不回调（否则 self 落 null 分支会把整枝浮动成根主题，破坏性）。
 * - 根节点无 parentId：整盒 = 变其子级（根不可作兄弟锚点）。
 *
 * 反馈时机（300ms → 100ms，spec P0-2）：同一落点悬停满 100ms 才点亮高亮/指示线；
 * 切换落点立即摘除并重置计时。**释放裁决不再要求悬停时长**——指针在哪里松开，
 * 落点就按哪里结算（企微/XMind 通例）。旧版「未满 300ms 视同无目标 → onDrop(null)
 * → 浮动到根」正是「看不懂逻辑」的主源：快速拖放会把整枝意外甩成根主题；改为
 * 几何落点直判后「点亮 ⟹ 按落点生效、未点亮释放 ⟹ 同样按落点生效」，二者永不满
 * 背离（fix round 1「高亮与释放配对」问题的根治）。
 *
 * 被拖节点视觉反馈（需求方「拖动节点时被拖节点零反馈」）：激活瞬间（activate，
 * 过 4px 阈值那一步）给被拖节点 g 挂 `gm-dragging` 类，半透明/cursor 视觉由页面
 * CSS 落地；所有结束路径（释放成功、禁止目标静默取消、pointercancel、svg 外
 * pointerup 兜底、destroy）统一经 clearHighlights 摘除——挂/摘以 draggingVisualId
 * 字段配对，不依赖 this.drag 的清空时序，任何路径不残留类。落点分类与结算语义
 * （classifyAt/resolveTarget/指示线）不受影响。
 *
 * 原生文字拖选根治（需求方「点击节点拖动时竟然把文字选中了」）：web 侧
 * user-select:none（editor.css .editor-canvas）之外，engine 在候选 pointerdown 与
 * 激活 move 上 e.preventDefault()——按 Pointer Events 规范，取消 pointerdown 抑制
 * 其默认动作（含文本选择起锚与兼容 mousedown 派发），click/dblclick/contextmenu
 * 合成不受影响（页面 onSvgClick / 双击编辑 / justDragged 防抖链路不变）。jsdom
 * 无法复现原生拖选，测试以 event.defaultPrevented 断言；真机由浏览器默认动作
 * 语义保证 + CSS 双保险。
 *
 * 生命周期绑定裁决（沿用 M1b Task 9 + fix round 1）：
 * - pointerdown 命中 <g data-node-id>（主键）才登记候选；折叠徽标 <g data-for-id>
 *   与标记徽标 <g data-marker-group> 嵌在节点 g 内，先排除——点击归页面层。
 * - 位移阈值 4px（screen px）之前不激活：click 仍是 click；激活时记录拖拽 id 与
 *   ghost 偏移（指针场景点 − 节点盒左上角，供页面画 ghost）。
 * - 拖动中每帧命中检测：viewport.toSceneFromEvent → classifyAt 落点分类。
 * - 候选/拖拽期间挂 window 级 pointerup/pointercancel 兜底：svg 外释放（如拖出
 *   窗口）不走 svg 处理器，防候选/拖拽卡死；svg 内释放先冒泡过 svg 处理器（状态
 *   已清），window 处理器成 no-op，天然幂等。
 * - pointercancel 视为取消；setPointerCapture 特性探测 + try/catch（T7 先例）；
 *   destroy() 全解绑、释放捕获、清反馈（不回调 onDrop）。
 * - 给页面的注记：拖拽激活后的释放**不会拦截**浏览器随后合成的 click 事件（本控
 *   制器只在 pointerdown/move 上 preventDefault）——页面仍需 justDragged 防抖
 *   「刚拖拽完」的合成 click（EditorPage 现状）。
 */
import type { NodeBox } from './types';
import type { Viewport } from './viewport';

/** 拖拽激活位移阈值（screen px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 落点反馈确认时长（同一落点累计悬停 ≥ 此值才点亮高亮/指示线；纯视觉时机，不裁决释放）。 */
export const DROP_HOVER_MS = 100;
/** 边缘插入带占比：盒高（org 为宽）两侧各此比例为「插入带」，其余为本体（变子级）。 */
export const SIBLING_BAND_RATIO = 0.25;
/** 插入指示线两端超出锚盒的外伸量（scene px）。 */
const INDICATOR_EXTEND_PX = 8;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 悬停中的几何落点（未含文档序 index——index 仅在释放时按 childrenIdsOf 结算）。 */
export type DropPlacement =
  | { kind: 'child'; nodeId: string }
  | { kind: 'sibling'; anchorId: string; position: 'before' | 'after' };

/**
 * 释放落点（onDrop 第二参，M7c-D1 三分）：
 * - `{kind:'child'}` = 变 nodeId 子级（追加末尾）；
 * - `{kind:'sibling'}` = 插为 parentId 的第 index 个子级（core moveNode 直用；
 *   anchorId/position 为落点意图，供测试/调试，页面可忽略）；
 * - `null` = 空白 → 页面层移为 root 子级（现状语义）。
 */
export type DropTarget =
  | { kind: 'child'; nodeId: string }
  | {
      kind: 'sibling';
      parentId: string;
      index: number;
      anchorId: string;
      position: 'before' | 'after';
    }
  | null;

/** 依赖注入：坐标换算与落点写参数由页面侧提供。 */
export interface DragControllerDeps {
  svg: SVGSVGElement;
  viewport: Viewport;
  /** 当前布局节点盒（场景坐标；每次命中检测实时取，拖拽中可被重布局刷新）。 */
  getBoxes(): NodeBox[];
  /** 释放回调：target 见 {@link DropTarget}（空白 null → 页面层 moveNode(id,'root')）。 */
  onDrop(id: string, target: DropTarget): void;
  /** candidateId 是否为 id 的后代（含间接）——后代不可作为落点锚（禁止目标）。 */
  isDescendant(id: string, candidateId: string): boolean;
  /** 文档子级序（页面适配 core childrenIds）：sibling 落点 index 结算输入（事务外纯计算）。 */
  childrenIdsOf(nodeId: string): string[];
  /** 场景坐标悬浮层：插入指示线宿主（页面在视口 wrapper 内 nodesLayer 之上的 <g>）。 */
  overlayLayer: SVGGElement;
  /** 可选：id 是否允许被换父（页面级门控，如只读态）；缺省允许。 */
  canReparent?(id: string): boolean;
}

/** 拖拽进行中的公开快照（供页面绘制 ghost；offset 为指针场景点 − 盒左上角）。 */
export interface DragSnapshot {
  id: string;
  offsetX: number;
  offsetY: number;
}

/** 落点比较键：落点切换（含同一节点本体↔边缘带互切）即重置反馈计时。 */
function placementKey(p: DropPlacement | null): string | null {
  if (!p) return null;
  return p.kind === 'child' ? `child:${p.nodeId}` : `sibling:${p.anchorId}:${p.position}`;
}

export class DragController {
  private deps: DragControllerDeps | null = null;
  private attached = false;
  /** 阈值前候选：已按下但未激活。 */
  private candidate: { id: string; x: number; y: number; pointerId: number } | null = null;
  /** 激活中的拖拽。 */
  private drag: { id: string; pointerId: number; offsetX: number; offsetY: number } | null = null;
  /** 当前悬停落点（比较键见 placementKey）；空白/禁止为 null。 */
  private hoverPlacement: DropPlacement | null = null;
  /** 落点反馈的 100ms 点亮定时器（离开/切换/结束即撤销）。 */
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前被标 drop-forbidden 的节点 id（自身或后代）。 */
  private hoverForbidden: string | null = null;
  /** 被拖节点当前挂 gm-dragging 的 id（激活挂上、clearHighlights 摘除，保证配对）。 */
  private draggingVisualId: string | null = null;
  /** 插入指示线（悬浮层内临时 line；离开落点/结束即移除）。 */
  private indicator: SVGLineElement | null = null;
  /** 候选/拖拽期间挂着的 window 级兜底监听标记。 */
  private windowBound = false;
  /** 已成功捕获的 pointerId（null = 未捕获）；finish/destroy 释放。 */
  private capturedPointerId: number | null = null;

  /** 拖拽进行中的快照；未拖拽为 null。 */
  get dragging(): DragSnapshot | null {
    return this.drag ? { id: this.drag.id, offsetX: this.drag.offsetX, offsetY: this.drag.offsetY } : null;
  }

  /** 绑定指针监听（幂等；可传新 deps 复用）。 */
  attach(deps: DragControllerDeps): void {
    if (this.attached) {
      this.deps = deps;
      return;
    }
    this.attached = true;
    this.deps = deps;
    deps.svg.addEventListener('pointerdown', this.onPointerDown);
    deps.svg.addEventListener('pointermove', this.onPointerMove);
    deps.svg.addEventListener('pointerup', this.onPointerUp);
    deps.svg.addEventListener('pointercancel', this.onPointerCancel);
  }

  /** 解绑全部监听、释放指针捕获并中止进行中的拖拽（不触发 onDrop；幂等）。 */
  destroy(): void {
    if (this.deps) {
      this.deps.svg.removeEventListener('pointerdown', this.onPointerDown);
      this.deps.svg.removeEventListener('pointermove', this.onPointerMove);
      this.deps.svg.removeEventListener('pointerup', this.onPointerUp);
      this.deps.svg.removeEventListener('pointercancel', this.onPointerCancel);
    }
    this.clearHighlights();
    this.releaseCapture();
    this.unbindWindowFallback();
    this.deps = null;
    this.attached = false;
    this.candidate = null;
    this.drag = null;
  }

  // -------------------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps || this.candidate || this.drag) return;
    if (e.button !== 0) return;
    const target = e.target as Element | null;
    // 折叠徽标（嵌于节点 g 内）优先排除：徽标点击归页面层。
    if (target?.closest('[data-for-id]')) return;
    // 标记徽标（M7b-W3 点击换组）：同折叠徽标让位纪律——徽标上的按下不进节点
    // 拖拽候选（click 归页面层「点徽章弹同组选盘」）。
    if (target?.closest('[data-marker-group]')) return;
    const g = target?.closest('[data-node-id]');
    if (!g) return;
    const id = g.getAttribute('data-node-id');
    if (!id) return;
    // 原生文字拖选根治（M7c-D1）：取消 pointerdown 默认动作——文本选择不再起锚、
    // 兼容 mousedown 不派发；click/dblclick 合成不受影响（页面点击链路不变）。
    e.preventDefault();
    this.candidate = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    // 候选期尚未捕获指针：svg 外释放只在 window 上可见，兜底防候选卡死。
    this.bindWindowFallback();
  };

  private onPointerMove = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const scene = deps.viewport.toSceneFromEvent(e);
      this.updateHover(this.classifyAt(scene.x, scene.y, this.drag.id));
      return;
    }
    if (!this.candidate || e.pointerId !== this.candidate.pointerId) return;
    const dist = Math.hypot(e.clientX - this.candidate.x, e.clientY - this.candidate.y);
    if (dist < DRAG_THRESHOLD_PX) return;
    this.activate(e);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.candidate && e.pointerId === this.candidate.pointerId) {
      this.candidate = null; // 未激活即抬起：click，不做任何事
      this.unbindWindowFallback();
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const id = this.drag.id;
    const scene = deps.viewport.toSceneFromEvent(e);
    const { placement, forbiddenId } = this.classifyAt(scene.x, scene.y, id);
    if (forbiddenId !== null) {
      this.finish();
      return; // 自身/自身后代：静默取消（fix round 1 裁决沿用）
    }
    const target = this.resolveTarget(id, placement);
    this.finish();
    deps.onDrop(id, target); // 空白 null / child / sibling（含快速释放——见头注）
  };

  private onPointerCancel = (): void => {
    if (!this.candidate && !this.drag) return;
    this.finish();
  };

  /** 过阈值：登记拖拽与 ghost 偏移（可选门控 canReparent 不放行则保持候选不激活）。 */
  private activate(e: PointerEvent): void {
    const deps = this.deps;
    const cand = this.candidate;
    if (!deps || !cand) return;
    if (deps.canReparent && !deps.canReparent(cand.id)) {
      this.candidate = null;
      this.unbindWindowFallback();
      return;
    }
    // 激活即再抑制一次默认动作（拖选拖拽等），与 pointerdown 的抑制双保险。
    e.preventDefault();
    const scene = deps.viewport.toSceneFromEvent(e);
    const box = deps.getBoxes().find((b) => b.id === cand.id);
    this.drag = {
      id: cand.id,
      pointerId: cand.pointerId,
      offsetX: box ? scene.x - box.x : 0,
      offsetY: box ? scene.y - box.y : 0,
    };
    this.candidate = null;
    // 被拖节点视觉反馈（半透明/cursor 由页面 CSS 落地）；摘除统一走 clearHighlights，
    // finish/destroy/svg 外 pointerup 兜底全部汇入该收尾，任何路径不残留。
    this.draggingVisualId = cand.id;
    this.setClass(cand.id, 'gm-dragging', true);
    if (typeof deps.svg.setPointerCapture === 'function') {
      try {
        deps.svg.setPointerCapture(e.pointerId);
        this.capturedPointerId = e.pointerId;
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 + window 兜底（Task 7 先例） */
      }
    }
    this.updateHover(this.classifyAt(scene.x, scene.y, cand.id));
  }

  /** 结束拖拽：清反馈、移指示线、释放捕获、卸 window 兜底（onDrop 由调用方决定）。 */
  private finish(): void {
    this.clearHighlights();
    this.candidate = null;
    this.drag = null;
    this.releaseCapture();
    this.unbindWindowFallback();
  }

  private releaseCapture(): void {
    const svg = this.deps?.svg;
    if (
      this.capturedPointerId !== null &&
      svg &&
      typeof svg.releasePointerCapture === 'function'
    ) {
      try {
        svg.releasePointerCapture(this.capturedPointerId);
      } catch {
        /* 指针可能已释放 */
      }
    }
    this.capturedPointerId = null;
  }

  private bindWindowFallback(): void {
    if (this.windowBound) return;
    this.windowBound = true;
    // svg 内释放会先冒泡过 svg 处理器（状态已清），此兜底处理器成 no-op。
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
  }

  private unbindWindowFallback(): void {
    if (!this.windowBound) return;
    this.windowBound = false;
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
  }

  /**
   * 场景点落点分类（M7c-D1 三分）：命中最先匹配的盒（getBoxes 序；盒不重叠）。
   * - 自身/后代 → forbiddenId（整盒含边缘带一律禁止，fix round 1）；
   * - 根（无 parentId）→ 整盒 = 变其子级（根不可作兄弟锚点）；
   * - 其余按边缘插入带切分：横向布局（side left/right，兄弟纵排）取上下 25% 带，
   *   org（side 'down'，兄弟横排）取左右 25% 带；带内 = sibling(before/after)，
   *   带外本体 = child。
   * - 未命中任何盒 → 空白（placement/forbiddenId 双 null）。
   */
  private classifyAt(
    sceneX: number,
    sceneY: number,
    draggedId: string,
  ): { placement: DropPlacement | null; forbiddenId: string | null } {
    const deps = this.deps;
    if (!deps) return { placement: null, forbiddenId: null };
    for (const b of deps.getBoxes()) {
      if (sceneX < b.x || sceneX > b.x + b.w || sceneY < b.y || sceneY > b.y + b.h) continue;
      if (b.id === draggedId || deps.isDescendant(draggedId, b.id)) {
        return { placement: null, forbiddenId: b.id };
      }
      if (b.parentId === undefined) {
        return { placement: { kind: 'child', nodeId: b.id }, forbiddenId: null };
      }
      const vertical = b.side === 'down';
      const rel = vertical ? (sceneX - b.x) / b.w : (sceneY - b.y) / b.h;
      if (rel < SIBLING_BAND_RATIO || rel > 1 - SIBLING_BAND_RATIO) {
        return {
          placement: {
            kind: 'sibling',
            anchorId: b.id,
            position: rel < SIBLING_BAND_RATIO ? 'before' : 'after',
          },
          forbiddenId: null,
        };
      }
      return { placement: { kind: 'child', nodeId: b.id }, forbiddenId: null };
    }
    return { placement: null, forbiddenId: null };
  }

  /**
   * 释放结算：把几何落点换算成文档写参数（纪律#2：纯计算，事务之外）。
   * sibling 的 index = 锚点在 childrenIdsOf(parentId) 的位次（before 取本位、after
   * 取下一位）；同父移动因 moveNode 先移除后插入，移除位次在结算位次之前时 index
   * −1 修正。锚点不在文档序（协同删除窗口期/桩不一致）→ 降级为变其子级，由 core
   * 校验兜底（拒绝即抛错走页面 toast）。
   */
  private resolveTarget(draggedId: string, placement: DropPlacement | null): DropTarget {
    const deps = this.deps;
    if (!deps || placement === null) return null;
    if (placement.kind === 'child') return { kind: 'child', nodeId: placement.nodeId };
    const anchor = deps.getBoxes().find((b) => b.id === placement.anchorId);
    if (!anchor || anchor.parentId === undefined) {
      return { kind: 'child', nodeId: placement.anchorId };
    }
    const parentId = anchor.parentId;
    const siblings = deps.childrenIdsOf(parentId);
    const anchorIdx = siblings.indexOf(anchor.id);
    if (anchorIdx === -1) return { kind: 'child', nodeId: anchor.id };
    let index = placement.position === 'before' ? anchorIdx : anchorIdx + 1;
    const dragged = deps.getBoxes().find((b) => b.id === draggedId);
    if (dragged && dragged.parentId === parentId) {
      const curIdx = siblings.indexOf(draggedId);
      if (curIdx !== -1 && curIdx < index) index -= 1; // 先移除自身：后续位次前移
    }
    return { kind: 'sibling', parentId, index, anchorId: anchor.id, position: placement.position };
  }

  /** 悬停反馈状态机：落点切换立即摘除旧反馈并重置计时；满 100ms 点亮；禁止即时。 */
  private updateHover(hit: { placement: DropPlacement | null; forbiddenId: string | null }): void {
    const key = placementKey(hit.placement);
    if (key !== placementKey(this.hoverPlacement)) {
      this.clearTargetFeedback(); // 离开/切换：立即摘除 + 撤销未触发的点亮定时器
      if (hit.placement !== null) {
        this.hoverPlacement = hit.placement;
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null;
          if (placementKey(this.hoverPlacement) === key) {
            this.applyFeedback(this.hoverPlacement as DropPlacement);
          }
        }, DROP_HOVER_MS);
      }
    }
    // 自身/后代的禁止反馈即时显隐，不参与 100ms 延迟。
    if (hit.forbiddenId !== this.hoverForbidden) {
      this.setClass(this.hoverForbidden, 'drop-forbidden', false);
      this.hoverForbidden = hit.forbiddenId;
      if (hit.forbiddenId !== null) this.setClass(hit.forbiddenId, 'drop-forbidden', true);
    }
  }

  /** 点亮落点反馈：child=目标盒描边高亮（.drop-target）；sibling=插入指示线。 */
  private applyFeedback(p: DropPlacement): void {
    if (p.kind === 'child') {
      this.setClass(p.nodeId, 'drop-target', true);
      return;
    }
    this.showIndicator(p);
  }

  /** 摘除落点反馈：清定时器、去类/移指示线、复位落点。 */
  private clearTargetFeedback(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    const p = this.hoverPlacement;
    if (p) {
      if (p.kind === 'child') this.setClass(p.nodeId, 'drop-target', false);
      else this.removeIndicator();
    }
    this.hoverPlacement = null;
  }

  /** 插入指示线（gm-drop-indicator）：横线盖在锚盒上/下缘（org 为竖线贴左/右缘），
   *  两端各外伸 8px；悬浮层 scene 坐标，CSS 定视觉（pointer-events:none）。 */
  private showIndicator(p: { anchorId: string; position: 'before' | 'after' }): void {
    const deps = this.deps;
    if (!deps) return;
    const anchor = deps.getBoxes().find((b) => b.id === p.anchorId);
    if (!anchor) return;
    let line = this.indicator;
    if (!line) {
      line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('class', 'gm-drop-indicator');
      deps.overlayLayer.appendChild(line);
      this.indicator = line;
    }
    const before = p.position === 'before';
    if (anchor.side === 'down') {
      const x = before ? anchor.x : anchor.x + anchor.w;
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      line.setAttribute('y1', String(anchor.y - INDICATOR_EXTEND_PX));
      line.setAttribute('y2', String(anchor.y + anchor.h + INDICATOR_EXTEND_PX));
      return;
    }
    const y = before ? anchor.y : anchor.y + anchor.h;
    line.setAttribute('x1', String(anchor.x - INDICATOR_EXTEND_PX));
    line.setAttribute('x2', String(anchor.x + anchor.w + INDICATOR_EXTEND_PX));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
  }

  private removeIndicator(): void {
    this.indicator?.remove();
    this.indicator = null;
  }

  private clearHighlights(): void {
    this.clearTargetFeedback();
    this.setClass(this.hoverForbidden, 'drop-forbidden', false);
    this.hoverForbidden = null;
    // 被拖节点反馈兜底摘除：finish/destroy 全走这里（激活与收尾配对，见头注）。
    this.setClass(this.draggingVisualId, 'gm-dragging', false);
    this.draggingVisualId = null;
    this.removeIndicator(); // 兜底：任何结束路径指示线必摘（destroy 中途打断等）
  }

  private setClass(id: string | null, cls: string, on: boolean): void {
    const svg = this.deps?.svg;
    if (!svg || id === null) return;
    // 按属性值精确匹配（不用选择器插值，避免 id 含特殊字符时的转义问题）。
    const all = svg.querySelectorAll<SVGGElement>('[data-node-id]');
    for (let i = 0; i < all.length; i += 1) {
      const g = all[i] as SVGGElement;
      if (g.getAttribute('data-node-id') === id) {
        if (on) g.classList.add(cls);
        else g.classList.remove(cls);
        return;
      }
    }
  }
}
