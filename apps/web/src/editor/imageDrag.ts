import type { ImagePlacement } from '@gmind/engine';

/**
 * 图片拖拽换位（2026-10-20 图文四槽位）—— 纯几何 + 场景层绘制助手。
 *
 * 交互口径（需求方 2026-10-20 裁定，同日走查改为图片本体直接起拖）：
 * - 鼠标悬停图片 → `cursor: move`（四向箭头）；按住图片本体拖动即换位，不再需要
 *   额外把手；双击预览、四角缩放手势仍优先（缩放手柄在独立层且先拦）；
 * - 拖拽中：半透明 ghost 跟随指针；当前悬停节点绘制**四侧虚线引导带**，命中的
 *   槽位高亮；松手才落库（拖拽期不写文档，一次拖拽 = 一步撤销）；
 * - 可拖到其他节点；目标已有图直接替换（core moveImage 单事务）。
 *
 * 层挂在 `g.gm-viewport` 内（场景坐标，自动跟随平移/缩放），尺寸按 1/scale 补偿
 * 保持屏幕像素恒定（与 imageHandles.ts 同纪律）。几何函数纯、可单测。
 */

/** 拖拽 ghost 最长边的屏幕像素。 */
export const GHOST_MAX_SCREEN = 96;
/** 四侧引导带厚度上下限（屏幕/场景同口径；内容区过小时重叠可接受）。 */
export const GUIDE_BAND_MAX = 56;
export const GUIDE_BAND_MIN = 18;

export interface SceneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PointLike {
  x: number;
  y: number;
}

export interface ImageGuideLayout {
  /** 内容区（盒内缩 nodePaddingX；过小时回退整盒）。 */
  content: SceneRect;
  bands: Record<ImagePlacement, SceneRect>;
}

/** 点是否在矩形内（含边界）。 */
export function rectContains(rect: SceneRect, point: PointLike): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.w &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.h
  );
}

/** 四侧引导带几何（虚线渲染与命中判定同源）。 */
export function guideLayoutOf(box: SceneRect, nodePaddingX: number): ImageGuideLayout {
  const inset = Math.max(0, nodePaddingX);
  const w = Math.max(0, box.w - inset * 2);
  const h = Math.max(0, box.h - inset * 2);
  const content: SceneRect =
    w > 0 && h > 0
      ? { x: box.x + inset, y: box.y + inset, w, h }
      : { x: box.x, y: box.y, w: Math.max(0, box.w), h: Math.max(0, box.h) };
  const t = Math.max(GUIDE_BAND_MIN, Math.min(GUIDE_BAND_MAX, Math.min(content.w, content.h) / 4));
  return {
    content,
    bands: {
      top: { x: content.x, y: content.y, w: content.w, h: t },
      bottom: { x: content.x, y: content.y + content.h - t, w: content.w, h: t },
      left: { x: content.x, y: content.y, w: t, h: content.h },
      right: { x: content.x + content.w - t, y: content.y, w: t, h: content.h },
    },
  };
}

const PLACEMENTS: readonly ImagePlacement[] = ['top', 'bottom', 'left', 'right'];

/**
 * 命中槽位：取「指针到四侧引导带中心」最近者（四角重叠处也有确定答案）。
 * 顺序固定 top→bottom→left→right，平局取先者（确定性）。
 */
export function placementAt(layout: ImageGuideLayout, point: PointLike): ImagePlacement {
  let best: ImagePlacement = 'bottom';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const placement of PLACEMENTS) {
    const band = layout.bands[placement];
    const cx = band.x + band.w / 2;
    const cy = band.y + band.h / 2;
    const dist = (point.x - cx) ** 2 + (point.y - cy) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = placement;
    }
  }
  return best;
}

/**
 * 指针下最上层的图片命中（倒序遍历节点盒，与渲染层序一致）。
 * `imageOf` 返回 null 表示该节点无图；返回矩形为图片场景矩形。
 */
export function findImageNode<T extends { id: string; x: number; y: number }>(
  boxes: readonly T[],
  imageOf: (id: string) => { w: number; h: number } | null | undefined,
  rectOf: (box: T, image: { w: number; h: number }) => SceneRect,
  point: PointLike,
): { nodeId: string; rect: SceneRect; image: { w: number; h: number } } | null {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    const box = boxes[i]!;
    const image = imageOf(box.id);
    if (!image) continue;
    const rect = rectOf(box, image);
    if (rectContains(rect, point)) return { nodeId: box.id, rect, image };
  }
  return null;
}

/** 指针下最上层的节点盒（拖拽目标判定）。 */
export function findNodeAt<T extends SceneRect>(
  boxes: readonly T[],
  point: PointLike,
): T | null {
  for (let i = boxes.length - 1; i >= 0; i -= 1) {
    if (rectContains(boxes[i]!, point)) return boxes[i]!;
  }
  return null;
}

/** ghost 矩形：最长边 = GHOST_MAX_SCREEN 屏幕像素，等比、以指针为中心。 */
export function ghostRect(
  point: PointLike,
  image: { w: number; h: number },
  scale: number,
  maxScreen = GHOST_MAX_SCREEN,
): SceneRect {
  const k = (maxScreen / (scale > 0 ? scale : 1)) / Math.max(1, image.w, image.h);
  const w = Math.max(1, image.w * k);
  const h = Math.max(1, image.h * k);
  return { x: point.x - w / 2, y: point.y - h / 2, w, h };
}

// ───────────────────────────── 场景层绘制 ─────────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node as SVGElementTagNameMap[K];
}

/** 创建拖拽层（挂在 g.gm-viewport 末尾最上层；内容由 render* 维护）。 */
export function createImageDragLayer(parent: SVGGElement): SVGGElement {
  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('class', 'gm-image-drag-layer');
  parent.appendChild(layer);
  return layer;
}

export interface DropView {
  pointer: PointLike;
  href: string;
  image: { w: number; h: number };
  /** 悬停节点与命中槽位；null = 指针不在任何节点上（ghost 仍跟随）。 */
  target: { nodeId: string; box: SceneRect; padX: number; placement: ImagePlacement } | null;
}

/** 拖拽中的 ghost + 引导带；data=null 时清空。 */
export function renderImageDrop(
  layer: SVGGElement,
  data: DropView | null,
  scale: number,
): void {
  let ghost = layer.querySelector<SVGImageElement>(':scope > image.gm-image-drag-ghost');
  let guides = layer.querySelector<SVGGElement>(':scope > g.gm-image-drop-guides');
  if (!data) {
    ghost?.remove();
    guides?.remove();
    return;
  }
  const rect = ghostRect(data.pointer, data.image, scale);
  if (!ghost) {
    ghost = svgEl('image', { class: 'gm-image-drag-ghost', 'data-testid': 'image-drag-ghost' });
    layer.appendChild(ghost);
  }
  ghost.setAttribute('href', data.href);
  ghost.setAttribute('x', String(rect.x));
  ghost.setAttribute('y', String(rect.y));
  ghost.setAttribute('width', String(rect.w));
  ghost.setAttribute('height', String(rect.h));

  if (!data.target) {
    guides?.remove();
    return;
  }
  if (!guides) {
    guides = svgEl('g', { class: 'gm-image-drop-guides', 'data-testid': 'image-drop-guides' });
    // 目标节点外框：小节点上四侧带只有十几像素，单靠带子容易与图片边框混淆；
    // 外框明确「当前目标节点」，四带明确「放到哪一侧」（2026-10-20 走查反馈）。
    guides.appendChild(
      svgEl('rect', {
        class: 'gm-image-drop-outline',
        'data-testid': 'image-drop-outline',
        rx: '6',
      }),
    );
    for (const placement of PLACEMENTS) {
      const band = svgEl('rect', {
        class: 'gm-image-drop-band',
        'data-band': placement,
        'data-testid': `image-drop-band-${placement}`,
        rx: '3',
      });
      guides.appendChild(band);
    }
    layer.appendChild(guides);
  }
  const layout = guideLayoutOf(data.target.box, data.target.padX);
  guides.setAttribute('data-node-id', data.target.nodeId);
  guides.setAttribute('data-placement', data.target.placement);
  const outline = guides.querySelector<SVGRectElement>('rect.gm-image-drop-outline');
  if (outline) {
    outline.setAttribute('x', String(data.target.box.x));
    outline.setAttribute('y', String(data.target.box.y));
    outline.setAttribute('width', String(data.target.box.w));
    outline.setAttribute('height', String(data.target.box.h));
  }
  for (const placement of PLACEMENTS) {
    const band = layout.bands[placement];
    const el = guides.querySelector<SVGRectElement>(`rect[data-band="${placement}"]`);
    if (!el) continue;
    el.setAttribute('x', String(band.x));
    el.setAttribute('y', String(band.y));
    el.setAttribute('width', String(band.w));
    el.setAttribute('height', String(band.h));
    el.classList.toggle('is-active', placement === data.target.placement);
  }
}
