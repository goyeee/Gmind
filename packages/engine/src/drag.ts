/**
 * 节点拖拽换父 / 浮动主题手势 — M1b Task 9（FR-EDT-003）。
 *
 * 绑定裁决（M1b 计划 Task 9）：
 * - pointerdown 命中 <g data-node-id>（主键）才登记候选；折叠徽标 <g data-for-id>
 *   嵌在节点 g 内，须先按 data-for-id 排除——徽标点击归页面层（Task 11）。
 * - 位移阈值 4px（screen px）之前不激活：click 仍是 click（页面另接点击/编辑）。
 *   激活时记录拖拽 id 与 ghost 偏移（指针场景点 − 节点盒左上角，供页面画 ghost）。
 * - 拖动中每帧命中检测：viewport.toSceneFromEvent → 命中 NodeBox（排除自身；
 *   deps.isDescendant(id, cand) 为真的后代盒记为「禁止」）。合法目标需**同一目标**
 *   累计悬停 ≥300ms 才可释放换父：hoverStart 按目标记忆，切换目标即重置——
 *   未满 300ms 就释放视同无目标 → onDrop(id, null)。计时用 Date.now()，
 *   vitest fake timers 默认伪造 Date，测试可确定性推进。
 * - 高亮：目标 <g> 加 class `drop-target`；被禁止的后代 <g> 加 class
 *   `drop-forbidden`；移开/抬起/取消即清除。
 * - 释放：合法目标（≥300ms）→ onDrop(id, targetId)；空白/未满阈值悬停 →
 *   onDrop(id, null)（浮动主题 = 页面层 moveNode(id, 'root')）；后代 → 取消不回调。
 *   自身盒被排除在命中外，其上释放即「无目标」→ null（浮装主题语义与空白一致）。
 * - 生命周期仿 Viewport（Task 7）：构造不绑事件；attach() 绑定（幂等）、
 *   destroy() 全解绑并中止进行中的拖拽（不回调）；pointercancel 视为取消。
 *   setPointerCapture 特性探测 + try/catch（jsdom 无该 API 时降级）。
 */
import type { NodeBox } from './types';
import type { Viewport } from './viewport';

/** 拖拽激活位移阈值（screen px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 悬停目标确认时长（同一目标累计 ≥ 此值才允许换父）。 */
export const DROP_HOVER_MS = 300;

/** 依赖注入：坐标换算与换父裁决由页面侧提供。 */
export interface DragControllerDeps {
  svg: SVGSVGElement;
  viewport: Viewport;
  /** 当前布局节点盒（场景坐标；每次命中检测实时取，拖拽中可被重布局刷新）。 */
  getBoxes(): NodeBox[];
  /** 释放回调：targetId 为 null 表示落到空白 → 页面层 moveNode(id, 'root') 浮动主题。 */
  onDrop(id: string, targetId: string | null): void;
  /** candidateId 是否为 id 的后代（含间接）——后代不可作为换父目标。 */
  isDescendant(id: string, candidateId: string): boolean;
  /** 可选：id 是否允许被换父（页面级门控，如只读态）；缺省允许。 */
  canReparent?(id: string): boolean;
}

/** 拖拽进行中的公开快照（供页面绘制 ghost；offset 为指针场景点 − 盒左上角）。 */
export interface DragSnapshot {
  id: string;
  offsetX: number;
  offsetY: number;
}

/** 命中结果：命中的盒 + 是否为禁止目标（拖拽源的后代）。 */
interface Hit {
  box: NodeBox;
  forbidden: boolean;
}

export class DragController {
  private deps: DragControllerDeps | null = null;
  private attached = false;
  /** 阈值前候选：已按下但未激活。 */
  private candidate: { id: string; x: number; y: number; pointerId: number } | null = null;
  /** 激活中的拖拽。 */
  private drag: { id: string; pointerId: number; offsetX: number; offsetY: number } | null = null;
  /** 当前悬停的合法目标与起悬时刻（Date.now()）；无目标为 null/0。 */
  private hoverTarget: string | null = null;
  private hoverStart = 0;
  /** 当前被标 drop-forbidden 的后代 id。 */
  private hoverForbidden: string | null = null;

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

  /** 解绑全部监听并中止进行中的拖拽（不触发 onDrop；幂等）。 */
  destroy(): void {
    if (this.deps) {
      this.deps.svg.removeEventListener('pointerdown', this.onPointerDown);
      this.deps.svg.removeEventListener('pointermove', this.onPointerMove);
      this.deps.svg.removeEventListener('pointerup', this.onPointerUp);
      this.deps.svg.removeEventListener('pointercancel', this.onPointerCancel);
    }
    this.clearHighlights();
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
    const g = target?.closest('[data-node-id]');
    if (!g) return;
    const id = g.getAttribute('data-node-id');
    if (!id) return;
    this.candidate = { id, x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  };

  private onPointerMove = (e: PointerEvent): void => {
    const deps = this.deps;
    if (!deps) return;
    if (this.drag) {
      if (e.pointerId !== this.drag.pointerId) return;
      const scene = deps.viewport.toSceneFromEvent(e);
      this.updateHover(this.hitAt(scene.x, scene.y, this.drag.id));
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
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const id = this.drag.id;
    const scene = deps.viewport.toSceneFromEvent(e);
    const hit = this.hitAt(scene.x, scene.y, id);
    const hoveredOk =
      hit !== null && !hit.forbidden && this.hoverTarget === hit.box.id &&
      Date.now() - this.hoverStart >= DROP_HOVER_MS;
    this.finish(e.pointerId);
    if (hit === null) {
      deps.onDrop(id, null); // 空白 → 浮动主题
      return;
    }
    if (hit.forbidden) return; // 拖入自身后代：取消
    deps.onDrop(id, hoveredOk ? hit.box.id : null); // 悬停未满 300ms 视同无目标
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (!this.candidate && !this.drag) return;
    this.finish(e.pointerId);
  };

  /** 过阈值：登记拖拽与 ghost 偏移（可选门控 canReparent 不放行则保持候选不激活）。 */
  private activate(e: PointerEvent): void {
    const deps = this.deps;
    const cand = this.candidate;
    if (!deps || !cand) return;
    if (deps.canReparent && !deps.canReparent(cand.id)) {
      this.candidate = null;
      return;
    }
    const scene = deps.viewport.toSceneFromEvent(e);
    const box = deps.getBoxes().find((b) => b.id === cand.id);
    this.drag = {
      id: cand.id,
      pointerId: cand.pointerId,
      offsetX: box ? scene.x - box.x : 0,
      offsetY: box ? scene.y - box.y : 0,
    };
    this.candidate = null;
    if (typeof deps.svg.setPointerCapture === 'function') {
      try {
        deps.svg.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上（Task 7 先例） */
      }
    }
    this.updateHover(this.hitAt(scene.x, scene.y, cand.id));
  }

  /** 结束拖拽：清高亮与状态并释放指针捕获（不触发 onDrop——由调用方决定）。 */
  private finish(pointerId?: number): void {
    const deps = this.deps;
    this.clearHighlights();
    this.candidate = null;
    this.drag = null;
    if (deps && pointerId !== undefined && typeof deps.svg.releasePointerCapture === 'function') {
      try {
        deps.svg.releasePointerCapture(pointerId);
      } catch {
        /* 指针可能已释放 */
      }
    }
  }

  /** 场景点命中：排除自身；后代盒标 forbidden。命中最先匹配的盒。 */
  private hitAt(sceneX: number, sceneY: number, draggedId: string): Hit | null {
    const deps = this.deps;
    if (!deps) return null;
    for (const b of deps.getBoxes()) {
      if (b.id === draggedId) continue;
      if (sceneX < b.x || sceneX > b.x + b.w || sceneY < b.y || sceneY > b.y + b.h) continue;
      return { box: b, forbidden: deps.isDescendant(draggedId, b.id) };
    }
    return null;
  }

  /** 悬停状态机：目标切换重置计时；同步 drop-target / drop-forbidden 高亮。 */
  private updateHover(hit: Hit | null): void {
    const targetId = hit !== null && !hit.forbidden ? hit.box.id : null;
    const forbiddenId = hit !== null && hit.forbidden ? hit.box.id : null;
    if (targetId !== this.hoverTarget) {
      this.setClass(this.hoverTarget, 'drop-target', false);
      if (targetId !== null) {
        this.hoverTarget = targetId;
        this.hoverStart = Date.now(); // 换目标即重置 300ms 计时
        this.setClass(targetId, 'drop-target', true);
      } else {
        this.hoverTarget = null;
        this.hoverStart = 0;
      }
    }
    if (forbiddenId !== this.hoverForbidden) {
      this.setClass(this.hoverForbidden, 'drop-forbidden', false);
      this.hoverForbidden = forbiddenId;
      if (forbiddenId !== null) this.setClass(forbiddenId, 'drop-forbidden', true);
    }
  }

  private clearHighlights(): void {
    this.setClass(this.hoverTarget, 'drop-target', false);
    this.setClass(this.hoverForbidden, 'drop-forbidden', false);
    this.hoverTarget = null;
    this.hoverStart = 0;
    this.hoverForbidden = null;
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
