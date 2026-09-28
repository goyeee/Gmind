/**
 * 视口：平移 / 以光标为中心缩放 / 适应画布 — M1b Task 7（FR-EDT-027/028）。
 *
 * 绑定裁决（M1b 计划 Task 7）：
 * - Viewport 独占 sceneRoot 的 transform（`translate(tx, ty) scale(s)`，4 位小数
 *   确定性输出）；渲染层（render.ts）不写任何视口变换。
 * - 数学全部收敛在纯函数 computeZoomAt / computeFit / clampScale（含 contentBounds），
 *   Viewport 方法仅委托——坐标换算可不依赖 DOM 单测。
 * - 滚轮（viewport 自有手势）：无修饰键 = 平移 panBy(-deltaX, -deltaY)；ctrl/meta =
 *   以光标为锚缩放（deltaY<0 → ×1.1，否则 ×1/1.1），preventDefault 阻止浏览器缩放，
 *   监听 { passive: false }。cx/cy 与 toScene 输入均为 svg 相对坐标。
 * - 空白拖拽平移也归 Viewport（裁决：Task 9 只做节点手势）：pointerdown（主键）且
 *   目标不在 [data-node-id]（节点盒及其子元素）也不在 [data-for-id]（折叠徽标）内
 *   即开始，pointermove 按位移增量 panBy，pointerup/pointercancel 结束；
 *   setPointerCapture 特性探测（jsdom 无该 API 时降级为 svg 自身监听）。
 *   例外（Task 15，FR-EDT-008）：Shift+主键在空白处留给页面层框选起点
 *   （SelectionModel.beginMarquee），Viewport 对 shift 按下不启动平移。
 * - 生命周期：构造不绑任何事件；attach() 显式绑定、destroy() 全部解绑
 *   （幂等：未 attach 时 destroy 是 no-op，attach 可再次复用）。
 */
import type { LayoutResult, Point } from './types';

/** 缩放上下限。 */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

/** 视口状态三元组（scale 为缩放倍率，tx/ty 为 svg 相对 screen px 平移量）。 */
export interface ViewportState {
  scale: number;
  tx: number;
  ty: number;
}

/** 数值 → 属性串：4 位小数确定性输出（apply 的 transform 全走此格式）。 */
function fmt4(n: number): string {
  return String(Math.round(n * 10000) / 10000);
}

/** 缩放钳制到 [MIN_SCALE, MAX_SCALE]。 */
export function clampScale(s: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * 以 screen 锚点 (cx, cy) 缩放：scale' = clamp(scale×factor)，
 * tx' = cx - (cx - tx)×(scale'/scale)——锚点指向的场景点缩放前后不变。
 */
export function computeZoomAt(
  scale: number,
  tx: number,
  ty: number,
  factor: number,
  cx: number,
  cy: number,
): ViewportState {
  const next = clampScale(scale * factor);
  const ratio = scale > 0 ? next / scale : 1;
  return {
    scale: next,
    tx: cx - (cx - tx) * ratio,
    ty: cy - (cy - ty) * ratio,
  };
}

/** 适应画布的内容包围盒：宽高由调用方给（布局结果），minX/minY 由节点盒取最小。 */
export interface FitBox {
  width: number;
  height: number;
  minX: number;
  minY: number;
}

/** 从布局结果取内容包围盒（LayoutResult 不携带 minX/minY，按节点盒补算；空集回退 0）。 */
export function contentBounds(layout: Pick<LayoutResult, 'nodes' | 'width' | 'height'>): FitBox {
  let minX = 0;
  let minY = 0;
  for (const n of layout.nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
  }
  return { width: layout.width, height: layout.height, minX, minY };
}

/**
 * 适应画布：scale = min((1-2×pad)×vw/width, (1-2×pad)×vh/height) 钳制到
 * [0.1, 4]，内容居中（tx = (vw - width×scale)/2 - minX×scale，ty 同理）。
 * 退化保护：宽/高/视口任一 ≤0（含 NaN）→ scale = 1，居中该点，不产生 NaN/Infinity。
 */
export function computeFit(
  box: FitBox,
  vw: number,
  vh: number,
  maxPaddingRatio = 0.05,
): ViewportState {
  const degenerate =
    !(box.width > 0) || !(box.height > 0) || !(vw > 0) || !(vh > 0);
  const scale = degenerate
    ? clampScale(1)
    : clampScale(
        Math.min(
          ((1 - 2 * maxPaddingRatio) * vw) / box.width,
          ((1 - 2 * maxPaddingRatio) * vh) / box.height,
        ),
      );
  return {
    scale,
    tx: (vw - box.width * scale) / 2 - box.minX * scale,
    ty: (vh - box.height * scale) / 2 - box.minY * scale,
  };
}

/**
 * 视口控制器：持有 scale/tx/ty 并独占 sceneRoot 的 transform 属性。
 * 构造只写恒等 transform，事件监听由 attach()/destroy() 显式管理。
 */
export class Viewport {
  /** 当前缩放（恒在 [MIN_SCALE, MAX_SCALE]）。 */
  scale = 1;
  /** 平移量（svg 相对 screen px）。 */
  tx = 0;
  ty = 0;

  private readonly svg: SVGSVGElement;
  private readonly sceneRoot: SVGGElement;
  private attached = false;
  private panning = false;
  private lastPan: Point = { x: 0, y: 0 };

  constructor(svg: SVGSVGElement, sceneRoot: SVGGElement) {
    this.svg = svg;
    this.sceneRoot = sceneRoot;
    this.apply();
  }

  /** 把当前状态写到 sceneRoot：`translate(tx, ty) scale(scale)`（4 位小数）。 */
  apply(): void {
    this.sceneRoot.setAttribute(
      'transform',
      `translate(${fmt4(this.tx)}, ${fmt4(this.ty)}) scale(${fmt4(this.scale)})`,
    );
  }

  /** 按 screen px 平移。 */
  panBy(dx: number, dy: number): void {
    this.tx += dx;
    this.ty += dy;
    this.apply();
  }

  /** 以 screen 锚点 (cx, cy)（svg 相对）缩放。 */
  zoomAt(factor: number, cx: number, cy: number): void {
    this.set(computeZoomAt(this.scale, this.tx, this.ty, factor, cx, cy));
  }

  /** 直接设缩放（钳制）。 */
  zoomTo(scale: number): void {
    this.scale = clampScale(scale);
    this.apply();
  }

  /** screen（svg 相对）→ 场景坐标。 */
  toScene(clientX: number, clientY: number): Point {
    return { x: (clientX - this.tx) / this.scale, y: (clientY - this.ty) / this.scale };
  }

  /** 场景坐标 → screen（svg 相对；toScene 的逆变换）。 */
  toScreen(sceneX: number, sceneY: number): Point {
    return { x: this.tx + sceneX * this.scale, y: this.ty + sceneY * this.scale };
  }

  /** 事件坐标 → 场景坐标（自动减 svg 包围盒原点）。 */
  toSceneFromEvent(e: MouseEvent): Point {
    const rect = this.svg.getBoundingClientRect();
    return this.toScene(e.clientX - rect.left, e.clientY - rect.top);
  }

  /** 适应画布：按布局结果与视口尺寸缩放并居中内容。 */
  fit(
    layout: Pick<LayoutResult, 'nodes' | 'width' | 'height'>,
    viewportSize: { w: number; h: number },
    maxPaddingRatio = 0.05,
  ): void {
    this.set(
      computeFit(contentBounds(layout), viewportSize.w, viewportSize.h, maxPaddingRatio),
    );
  }

  /** 绑定滚轮与空白拖拽平移监听（幂等）。 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.svg.addEventListener('wheel', this.onWheel, { passive: false });
    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
  }

  /** 解绑全部监听并结束进行中的拖拽（幂等；之后可再次 attach）。 */
  destroy(): void {
    if (!this.attached) return;
    this.attached = false;
    this.panning = false;
    this.svg.removeEventListener('wheel', this.onWheel);
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerUp);
  }

  private set(state: ViewportState): void {
    this.scale = state.scale;
    this.tx = state.tx;
    this.ty = state.ty;
    this.apply();
  }

  private onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
    } else {
      this.panBy(-e.deltaX, -e.deltaY);
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    if (e.shiftKey) return; // Shift+左键空白 = 框选起点（页面层），不平移
    const target = e.target as Element | null;
    // 概要 bracket（M6 T6）非空白：其命中既不平移也不捕获指针——捕获会把随后的
    // click 重定向到 svg，页面层「点标签编辑概要」将收不到命中元素。
    if (
      target?.closest('[data-node-id]') ||
      target?.closest('[data-for-id]') ||
      target?.closest('[data-summary-id]')
    ) {
      return;
    }
    this.panning = true;
    this.lastPan = { x: e.clientX, y: e.clientY };
    // 指针捕获保证移出 svg 仍收到 move/up；jsdom 无该 API，特性探测降级。
    if (typeof this.svg.setPointerCapture === 'function') {
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 */
      }
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.panning) return;
    this.panBy(e.clientX - this.lastPan.x, e.clientY - this.lastPan.y);
    this.lastPan = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.panning) return;
    this.panning = false;
    if (typeof this.svg.releasePointerCapture === 'function') {
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
    }
  };
}
