import { IMAGE_MAX_EDGE } from './imageUpload';

/**
 * 节点头像/图片缩放的手柄几何与尺寸计算 —— 纯函数模块（页面侧交互，engine 零改动）。
 *
 * 为什么在页面侧画手柄（2026-10-15 需求方「拖拽图片周边改尺寸」）：engine 的
 * render/layout/measure 一行不改 → 布局金样零风险（金样树本就不含图片）；手柄层
 * 挂在既有 `g.gm-viewport` 内（先例 `g.gm-drag-overlay`），场景坐标自动跟随平移/
 * 缩放，尺寸按 1/scale 补偿保持屏幕像素恒定。
 *
 * 尺寸口径（需求方裁定「可以暂时不突破 px 上限」）：等比锁定（比例继承上传时已
 * 等比的 w/h）、长边 ≤ 200px（FR-EDT-020 不变）、短边 ≥ MIN_EDGE（防缩到点不着）。
 */

export type ImageCorner = 'nw' | 'ne' | 'sw' | 'se';

/** 手柄渲染顺序（四角），也是 e2e 断言 4 个手柄的顺序来源。 */
export const IMAGE_CORNERS: readonly ImageCorner[] = ['nw', 'ne', 'sw', 'se'];

/** 手柄边长（屏幕像素；落到 SVG 时除以视口 scale 保持恒定视觉大小）。 */
export const HANDLE_SCREEN_PX = 9;

/** 短边下限（屏幕/场景像素一致口径）：再小就抓不住手柄也看不清图。 */
export const IMAGE_MIN_EDGE = 24;

/**
 * 拖角灵敏度（2026-10-20 需求方「指哪打哪操控好一些」）：指针位移 ×2 映射到尺寸，
 * 同样拖距变化翻倍；200px 上限 / 24px 下限 / 等比锁定口径全部不变。
 */
export const IMAGE_RESIZE_SENSITIVITY = 2;

export interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 图片在**场景坐标**里的矩形。引擎把 `<image class="gm-image">` 画在节点 g 内，
 * 节点 g 平移到盒左上角 —— 故图片矩形 = 盒左上角 + 盒内图片偏移，宽高直取 image.w/h。
 *
 * 2026-10-20 图文四槽位起：图片偏移不再是固定的 (nodePaddingX, 0)，改由测量侧
 * `NodeBox.content`（imageX/imageTop）单源给出；无 content（旧布局/无图节点）仍回退
 * 旧口径 (nodePaddingX, 0)，几何与既有手柄完全一致。
 */
export function imageSceneRect(
  box: { x: number; y: number; content?: { imageX?: number; imageTop?: number } },
  image: { w: number; h: number },
  nodePaddingX: number,
): ImageRect {
  return {
    x: box.x + (box.content?.imageX ?? nodePaddingX),
    y: box.y + (box.content?.imageTop ?? 0),
    w: image.w,
    h: image.h,
  };
}

/** 四角手柄中心点（场景坐标）。 */
export function handleCenters(rect: ImageRect): Record<ImageCorner, { x: number; y: number }> {
  const { x, y, w, h } = rect;
  return {
    nw: { x, y },
    ne: { x: x + w, y },
    sw: { x, y: y + h },
    se: { x: x + w, y: y + h },
  };
}

/** 角手柄的方向符号：e/s 侧向右下为「放大」，w/n 侧向左上为「放大」。 */
function growSigns(corner: ImageCorner): { sx: number; sy: number } {
  return { sx: corner.includes('e') ? 1 : -1, sy: corner.includes('s') ? 1 : -1 };
}

/**
 * 拖角手柄 → 新的显示尺寸。**基于指针位移而非绝对坐标**（关键取舍）：每次拖拽都
 * 触发重排，节点盒位置可能随之变化，若用绝对坐标反解尺寸会与布局相互反馈（抖）；
 * 位移口径单调、无反馈，也与用户手感一致（拖多远就长多少）。
 *
 * 等比锁定：比例取**拖拽起始**的 w/h（不随中途结果漂移），缩放系数取两轴需求的
 * 较大者（跟随指针所在的主轴，避免斜拖时"缩水"）。
 */
export function resizeImageSizeByDelta(
  start: { w: number; h: number },
  corner: ImageCorner,
  delta: { dx: number; dy: number },
  opts: { maxEdge?: number; minEdge?: number } = {},
): { w: number; h: number } {
  const maxEdge = opts.maxEdge ?? IMAGE_MAX_EDGE;
  const minEdge = opts.minEdge ?? IMAGE_MIN_EDGE;
  const { sx, sy } = growSigns(corner);
  const w0 = Math.max(1, start.w);
  const h0 = Math.max(1, start.h);
  // 灵敏度：位移 ×IMAGE_RESIZE_SENSITIVITY 再换算缩放系数（零位移 ×2 仍为零，幂等不变）。
  const dx = delta.dx * IMAGE_RESIZE_SENSITIVITY;
  const dy = delta.dy * IMAGE_RESIZE_SENSITIVITY;
  const wantScale = Math.max((w0 + sx * dx) / w0, (h0 + sy * dy) / h0);
  // 上下限都**不反过来强迫用户**：下限只用来阻止缩过头（起始短边已小于下限时，
  // scaleMin 截到 1 → 不许再缩、也不被放大），上限只用来阻止涨过头（起始长边已超
  // 上限的存量脏数据同样截到 1 → 点击零位移不会被静默shrink）。两条都截到 1 之后
  // 区间恒含 1，零位移严格幂等（拖回原位不产生脏写）。
  const scaleMin = Math.min(1, minEdge / Math.min(w0, h0));
  const scaleMax = Math.max(1, maxEdge / Math.max(w0, h0));
  const scale = Math.min(Math.max(wantScale, scaleMin), scaleMax);
  return {
    w: Math.max(1, Math.round(w0 * scale)),
    h: Math.max(1, Math.round(h0 * scale)),
  };
}

/**
 * 创建手柄层（场景坐标，挂在 g.gm-viewport 末尾、拖拽悬浮层之上）。
 * 只建容器：逐帧位置/尺寸由 renderImageHandles 回填（同 render.ts 的 syncOptional 思路）。
 */
export function createImageHandleLayer(parent: SVGGElement): SVGGElement {
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  layer.setAttribute('class', 'gm-image-handles');
  parent.appendChild(layer);
  return layer;
}

/**
 * 回填手柄层：rect 为 null（非单选/无图/只读）则清空。
 * 手柄中心贴四角、边长 = HANDLE_SCREEN_PX / scale（屏幕像素恒定）。
 */
export function renderImageHandles(
  layer: SVGGElement,
  rect: ImageRect | null,
  scale: number,
): void {
  if (!rect) {
    // 只清手柄：同层的图片聚焦轮廓（gm-image-focus-outline）由 renderImageFocusOutline 自管，
    // 只读/多选下手柄消失但聚焦轮廓仍可保留。
    layer
      .querySelectorAll(':scope > rect.gm-image-resize-handle')
      .forEach((h) => h.remove());
    return;
  }
  const size = HANDLE_SCREEN_PX / (scale > 0 ? scale : 1);
  const centers = handleCenters(rect);
  for (const corner of IMAGE_CORNERS) {
    let handle = layer.querySelector<SVGRectElement>(
      `:scope > rect.gm-image-resize-handle[data-corner="${corner}"]`,
    );
    if (!handle) {
      handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      handle.setAttribute('class', 'gm-image-resize-handle');
      handle.setAttribute('data-corner', corner);
      handle.setAttribute('data-testid', `image-resize-handle-${corner}`);
      layer.appendChild(handle);
    }
    const c = centers[corner];
    handle.setAttribute('x', String(c.x - size / 2));
    handle.setAttribute('y', String(c.y - size / 2));
    handle.setAttribute('width', String(size));
    handle.setAttribute('height', String(size));
  }
}

/**
 * 图片聚焦选中轮廓（2026-10-20 需求方「点图片显示图片轮廓、点文字显示整节点轮廓」）：
 * 画在手柄层（压四角手柄之下），描边即图片矩形本身；整节点蓝色描边由页面侧
 * applySelectionClasses 内联退回主题边框来让位。只读同样显示（选中是读操作）。
 * rect=null 时移除。
 */
export function renderImageFocusOutline(layer: SVGGElement, rect: ImageRect | null): void {
  let outline = layer.querySelector<SVGRectElement>(':scope > rect.gm-image-focus-outline');
  if (!rect) {
    outline?.remove();
    return;
  }
  if (!outline) {
    outline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    outline.setAttribute('class', 'gm-image-focus-outline');
    outline.setAttribute('data-testid', 'image-focus-outline');
    layer.insertBefore(outline, layer.firstChild);
  }
  outline.setAttribute('x', String(rect.x));
  outline.setAttribute('y', String(rect.y));
  outline.setAttribute('width', String(rect.w));
  outline.setAttribute('height', String(rect.h));
}
