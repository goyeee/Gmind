/**
 * 节点拖拽换父 / 浮动主题手势 — M1b Task 9（FR-EDT-003）。
 *
 * 绑定裁决（M1b 计划 Task 9 + fix round 1）：
 * - pointerdown 命中 <g data-node-id>（主键）才登记候选；折叠徽标 <g data-for-id>
 *   嵌在节点 g 内，须先按 data-for-id 排除——徽标点击归页面层（Task 11）。
 * - 位移阈值 4px（screen px）之前不激活：click 仍是 click（页面另接点击/编辑）。
 *   激活时记录拖拽 id 与 ghost 偏移（指针场景点 − 节点盒左上角，供页面画 ghost）。
 * - 拖动中每帧命中检测：viewport.toSceneFromEvent → 命中 NodeBox。**自身盒与
 *   后代盒同为「禁止目标」**（fix round 1：自身释放曾落入 null 分支 → 页面
 *   moveNode(id,'root') 会把整枝浮动成根主题，属合法但破坏性的意外；裁决改为
 *   静默取消，与后代同待遇）：悬停即亮 .drop-forbidden 反馈，释放不回调 onDrop。
 * - 合法目标需**同一目标**累计悬停 ≥300ms 才可释放换父：hoverStart 按目标记忆，
 *   切换目标即重置；未满 300ms 就释放视同无目标 → onDrop(id, null)。
 *   高亮时机与释放裁决配对（fix round 1）：.drop-target 满 300ms 才由定时器翻转
 *   点亮（悬停中即亮会诱导用户在 <300ms 时释放而触发 null/浮动），离开/切换/
 *   结束立即摘除并撤销未触发的定时器。计时全走 Date.now()/setTimeout，
 *   vitest fake timers 默认伪造二者，测试可确定性推进。
 * - 释放：合法目标（≥300ms）→ onDrop(id, targetId)；空白/未满阈值悬停 →
 *   onDrop(id, null)（浮动主题 = 页面层 moveNode(id, 'root')）；自身/后代 → 取消。
 * - 候选/拖拽期间额外挂 window 级 pointerup/pointercancel 兜底（fix round 1：
 *   pointerdown 未捕获指针时，svg 外释放——如拖出窗口——不会在 svg 上派发
 *   pointerup，candidate 卡死会使后续所有 pointerdown 被拒，拖拽永久失效）；
 *   结束/destroy 即卸载。svg 内释放先冒泡过 svg 处理器（状态已清），window
 *   处理器成 no-op，天然幂等。
 * - 生命周期仿 Viewport（Task 7）：构造不绑事件；attach() 绑定（幂等）、
 *   destroy() 全解绑、释放已持有的指针捕获并中止进行中的拖拽（不回调）；
 *   pointercancel 视为取消；setPointerCapture 特性探测 + try/catch（T7 先例）。
 * - 给 Task 11 的注记：拖拽激活后的释放**不会拦截**浏览器随后合成的 click
 *   事件（上层规范未授权 preventDefault）——页面点击选择须自行防抖「刚拖拽完」
 *   （如记录 last-drag 时间戳，click 距其 < X ms 内忽略）。
 */
import type { NodeBox } from './types';
import type { Viewport } from './viewport';

/** 拖拽激活位移阈值（screen px）。 */
export const DRAG_THRESHOLD_PX = 4;
/** 悬停目标确认时长（同一目标累计 ≥ 此值才允许换父并点亮高亮）。 */
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

/** 命中结果：命中的盒 + 是否为禁止目标（拖拽源自身或其后代）。 */
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
  /** .drop-target 的 300ms 翻转定时器（离开/切换/结束即撤销）。 */
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  /** 当前被标 drop-forbidden 的节点 id（自身或后代）。 */
  private hoverForbidden: string | null = null;
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
    const g = target?.closest('[data-node-id]');
    if (!g) return;
    const id = g.getAttribute('data-node-id');
    if (!id) return;
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
      this.unbindWindowFallback();
      return;
    }
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const id = this.drag.id;
    const scene = deps.viewport.toSceneFromEvent(e);
    const hit = this.hitAt(scene.x, scene.y, id);
    const hoveredOk =
      hit !== null && !hit.forbidden && this.hoverTarget === hit.box.id &&
      Date.now() - this.hoverStart >= DROP_HOVER_MS;
    this.finish();
    if (hit === null) {
      deps.onDrop(id, null); // 空白 → 浮动主题
      return;
    }
    if (hit.forbidden) return; // 自身/自身后代：静默取消
    deps.onDrop(id, hoveredOk ? hit.box.id : null); // 悬停未满 300ms 视同无目标
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
        this.capturedPointerId = e.pointerId;
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 + window 兜底（Task 7 先例） */
      }
    }
    this.updateHover(this.hitAt(scene.x, scene.y, cand.id));
  }

  /** 结束拖拽：清高亮、释放捕获、卸 window 兜底（不触发 onDrop——由调用方决定）。 */
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

  /** 场景点命中：命中最先匹配的盒；自身与后代均为禁止目标（fix round 1）。 */
  private hitAt(sceneX: number, sceneY: number, draggedId: string): Hit | null {
    const deps = this.deps;
    if (!deps) return null;
    for (const b of deps.getBoxes()) {
      if (sceneX < b.x || sceneX > b.x + b.w || sceneY < b.y || sceneY > b.y + b.h) continue;
      return {
        box: b,
        forbidden: b.id === draggedId || deps.isDescendant(draggedId, b.id),
      };
    }
    return null;
  }

  /** 悬停状态机：目标切换重置计时；.drop-target 满 300ms 定时器翻转，禁止反馈即时。 */
  private updateHover(hit: Hit | null): void {
    const targetId = hit !== null && !hit.forbidden ? hit.box.id : null;
    const forbiddenId = hit !== null && hit.forbidden ? hit.box.id : null;
    if (targetId !== this.hoverTarget) {
      this.clearTargetHighlight(); // 离开/切换：立即摘除 + 撤销未触发的翻转定时器
      if (targetId !== null) {
        this.hoverTarget = targetId;
        this.hoverStart = Date.now(); // 换目标即重置 300ms 计时
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null;
          if (this.hoverTarget === targetId) this.setClass(targetId, 'drop-target', true);
        }, DROP_HOVER_MS);
      }
    }
    // 自身/后代的禁止反馈即时显隐，不参与 300ms 延迟。
    if (forbiddenId !== this.hoverForbidden) {
      this.setClass(this.hoverForbidden, 'drop-forbidden', false);
      this.hoverForbidden = forbiddenId;
      if (forbiddenId !== null) this.setClass(forbiddenId, 'drop-forbidden', true);
    }
  }

  /** 摘除目标高亮：清定时器、去类、复位悬停状态。 */
  private clearTargetHighlight(): void {
    if (this.hoverTimer !== null) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.setClass(this.hoverTarget, 'drop-target', false);
    this.hoverTarget = null;
    this.hoverStart = 0;
  }

  private clearHighlights(): void {
    this.clearTargetHighlight();
    this.setClass(this.hoverForbidden, 'drop-forbidden', false);
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
