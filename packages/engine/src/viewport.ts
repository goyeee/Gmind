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
 * - 拖拽平移（M7b-W3 平移改道，需求方裁定「空白左拖=框选」后平移让位；
 *   2026-10-09 需求方追加右键拖动平移）：
 *   触发条件 = **鼠标中键拖动**（任意目标，preventDefault 抑制中键自动滚动）、
 *   **鼠标右键拖动超 4px 阈值**（任意目标；阈值内原地松开不平移，归页面层右键
 *   菜单——防止手抖位移吃掉菜单。平移增量自按下起点起算，阈值不吞位移）或
 *   **空格按住 + 左键拖动**（仅空白处；节点/折叠徽标/概要上的左键仍归节点拖拽/
 *   页面层手势）。空格状态由 Viewport 自持（attach 期 window keydown/keyup/blur
 *   跟踪，公开只读 spacePressed 供页面层框选起点让位判定），destroy 即解绑。
 *   pointermove 按位移增量 panBy，pointerup/pointercancel 结束；setPointerCapture
 *   特性探测（jsdom 无该 API 时降级为 svg 自身监听）。
 *   平移进行中给 svg 挂 gm-panning 类（页面层抓手光标钩子），结束即摘；
 *   justPanned 标记「上一次手势是否发生了平移」（pointerup 后为 true、任一
 *   pointerdown 复位）——页面层 contextmenu 防抖依据（右键拖拽释放不弹菜单）。
 *   历史（Task 15，FR-EDT-008）：空白无修饰左键（原 Shift+左键）留给页面层框选
 *   起点（SelectionModel.beginMarquee），Viewport 不启动平移。
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
  private panningFlag = false;
  private lastPan: Point = { x: 0, y: 0 };
  /** 右键平移待决起点（按下未超 4px 阈值；超阈值转 panning，原地松开丢弃）。 */
  private rightPending: Point | null = null;
  /** 上一次手势是否发生了平移（pointerup 置位、任一 pointerdown 复位）。 */
  private justPannedFlag = false;
  /** 空格按住状态（attach 期 window 键盘跟踪；平移手势闸，M7b-W3 平移改道）。 */
  private spaceDown = false;

  /** 右键平移进入阈值（px）：阈值内原地松开不平移（归右键菜单），起点位移不吞。 */
  static readonly RIGHT_PAN_THRESHOLD = 4;

  constructor(svg: SVGSVGElement, sceneRoot: SVGGElement) {
    this.svg = svg;
    this.sceneRoot = sceneRoot;
    this.apply();
  }

  /** 空格是否按住（页面层框选起点据此让位给平移手势；未 attach 恒 false）。 */
  get spacePressed(): boolean {
    return this.attached && this.spaceDown;
  }

  /** 上一次手势是否发生了平移（页面层 contextmenu 防抖：右键拖拽释放不弹菜单）。 */
  get justPanned(): boolean {
    return this.justPannedFlag;
  }

  /**
   * 平移是否进行中（页面层 contextmenu 防抖补位，2026-10-09 右键菜单修复）：合成
   * contextmenu 的时机平台不一致——macOS 在 pointerup 后（justPanned 已置位即可拦），
   * Linux/headless Chromium 在 pointerup **前**（此时 justPanned 尚为 false，只有本
   * getter 能识别「拖拽已超阈值转平移、松手在即」的手势，拦截拖拽释放弹菜单）。
   */
  get panning(): boolean {
    return this.panningFlag;
  }

  /**
   * 右键按下是否处于阈值待决期（2026-10-09 右键菜单修复）：Linux/headless 的
   * contextmenu 紧随 pointerdown 合成（早于 move/pointerup），此刻无法预知会不会拖
   * 动——页面层据本 getter 把菜单请求**暂存到 pointerup 结算**（拖拽平移丢弃、原地
   * 松开补弹）；macOS/Windows 的 contextmenu 在 pointerup 后到达，本 getter 已是
   * false，走页面层直接弹路径。
   */
  get rightPendingActive(): boolean {
    return this.rightPending !== null && !this.panningFlag;
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

  /** 绑定滚轮与拖拽平移监听（幂等）。 */
  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.svg.addEventListener('wheel', this.onWheel, { passive: false });
    this.svg.addEventListener('pointerdown', this.onPointerDown);
    this.svg.addEventListener('pointermove', this.onPointerMove);
    this.svg.addEventListener('pointerup', this.onPointerUp);
    this.svg.addEventListener('pointercancel', this.onPointerUp);
    // 空格跟踪（window 级）：按住即置位，抬起/窗口失焦即复位（防按住时切窗卡死）。
    window.addEventListener('keydown', this.onSpaceKeyDown);
    window.addEventListener('keyup', this.onSpaceKeyUp);
    window.addEventListener('blur', this.onSpaceBlur);
  }

  /** 解绑全部监听并结束进行中的拖拽（幂等；之后可再次 attach）。 */
  destroy(): void {
    if (!this.attached) return;
    this.attached = false;
    this.endPan();
    this.rightPending = null;
    this.justPannedFlag = false;
    this.spaceDown = false;
    this.svg.removeEventListener('wheel', this.onWheel);
    this.svg.removeEventListener('pointerdown', this.onPointerDown);
    this.svg.removeEventListener('pointermove', this.onPointerMove);
    this.svg.removeEventListener('pointerup', this.onPointerUp);
    this.svg.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('keydown', this.onSpaceKeyDown);
    window.removeEventListener('keyup', this.onSpaceKeyUp);
    window.removeEventListener('blur', this.onSpaceBlur);
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

  private onSpaceKeyDown = (e: KeyboardEvent): void => {
    if (e.key === ' ' && !e.repeat) this.spaceDown = true;
  };

  private onSpaceKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ') this.spaceDown = false;
  };

  private onSpaceBlur = (): void => {
    this.spaceDown = false;
  };

  private onPointerDown = (e: PointerEvent): void => {
    // M7b-W3 平移改道：中键/右键拖动（任意目标）或空格+左键（仅空白）才平移；
    // 无修饰左键空白留给页面层框选（SelectionModel.beginMarquee），不平移。
    // 新手势开始：上一轮 justPanned 复位（contextmenu 只看最近一次手势）。
    this.justPannedFlag = false;
    const isMiddle = e.button === 1;
    const isRight = e.button === 2;
    const isSpaceLeft = e.button === 0 && this.spaceDown;
    if (!isMiddle && !isRight && !isSpaceLeft) return;
    if (isSpaceLeft && e.shiftKey) return;
    const target = e.target as Element | null;
    // 概要 bracket（M6 T6）非空白：其命中既不平移也不捕获指针——捕获会把随后的
    // click 重定向到 svg，页面层「点标签编辑概要」将收不到命中元素。
    // 空白判定仅约束空格+左键（中/右键拖动在节点上也平移，不与节点拖拽冲突——
    // DragController 只认主键）。
    if (
      !isMiddle &&
      !isRight &&
      (target?.closest('[data-node-id]') ||
        target?.closest('[data-for-id]') ||
        target?.closest('[data-summary-id]'))
    ) {
      return;
    }
    e.preventDefault(); // 中/右键抑制默认行为；空格+左键抑制选中文本等默认行为
    if (isRight) {
      // 右键阈值待决：move 超 4px 才转平移（原地松开归右键菜单）；先捕获指针，
      // 保证阈值判定期间的 move/up 事件不丢失。
      this.rightPending = { x: e.clientX, y: e.clientY };
      this.capturePointer(e);
      return;
    }
    this.rightPending = null;
    this.lastPan = { x: e.clientX, y: e.clientY };
    this.startPan();
    this.capturePointer(e);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.rightPending && !this.panningFlag) {
      const dx = e.clientX - this.rightPending.x;
      const dy = e.clientY - this.rightPending.y;
      if (Math.hypot(dx, dy) <= Viewport.RIGHT_PAN_THRESHOLD) return;
      // 超阈值转正式平移：增量自按下起点起算（阈值期间的位移不吞）。
      this.lastPan = this.rightPending;
      this.rightPending = null;
      this.panBy(e.clientX - this.lastPan.x, e.clientY - this.lastPan.y);
      this.lastPan = { x: e.clientX, y: e.clientY };
      this.startPan();
      return;
    }
    if (!this.panningFlag) return;
    this.panBy(e.clientX - this.lastPan.x, e.clientY - this.lastPan.y);
    this.lastPan = { x: e.clientX, y: e.clientY };
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.panningFlag) {
      this.endPan();
      this.justPannedFlag = true; // 页面层 contextmenu 防抖依据
      this.releasePointer(e);
      return;
    }
    if (this.rightPending) {
      // 右键阈值内原地松开：不平移（justPanned 保持 false，右键菜单照常弹）。
      this.rightPending = null;
      this.releasePointer(e);
    }
  };

  /** 进入平移态：置位 + svg 挂 gm-panning 类（页面层抓手光标钩子）。 */
  private startPan(): void {
    this.panningFlag = true;
    this.svg.classList.add('gm-panning');
  }

  /** 结束平移态：复位 + 摘类（幂等，destroy 兜底复用）。 */
  private endPan(): void {
    this.panningFlag = false;
    this.svg.classList.remove('gm-panning');
  }

  // 指针捕获保证移出 svg 仍收到 move/up；jsdom 无该 API，特性探测降级。
  private capturePointer(e: PointerEvent): void {
    if (typeof this.svg.setPointerCapture === 'function') {
      try {
        this.svg.setPointerCapture(e.pointerId);
      } catch {
        /* 捕获失败可忽略：监听就在 svg 上 */
      }
    }
  }

  private releasePointer(e: PointerEvent): void {
    if (typeof this.svg.releasePointerCapture === 'function') {
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* 同上 */
      }
    }
  }
}
