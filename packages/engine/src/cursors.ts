/**
 * 远端光标层 — M2 Task 4（FR-COL-002）。
 *
 * 绑定裁决（M2 计划 Task 4）：
 * - colorForUser：userId 的 FNV-1a 32 位哈希 → 10 色高对比色板取模。
 *   同一 userId 恒定同色（会话内固定）；色板避开纯红/纯绿对（红绿色弱友好），
 *   走蓝/橙/青绿/紫/金/青/品红/棕/藏青/粉家族。
 * - createCursorLayer：在 scene.nodesLayer 末尾追加 <g class="gm-cursors">
 *   （最上层，随视口 transform 管辖——主题切换重建场景时由页面层整体重建，
 *   故不提供 destroy）。
 * - setCursors(cursors, boxes) 整集差分协调，元素身份按 data-cursor-user 键
 *   （镜像 render.ts 的 seen-set 模式）：
 *   - 每个远端用户在其选中的每个（场景中存在的）节点 <g> 内叠加
 *     rect.gm-remote-selection（用户色描边 2.5、fill none、data-cursor-user）；
 *   - 另在第一个选中节点左上（y−18，钳制 ≥2）放一个 g.gm-remote-cursor 标签
 *     （色点 circle r=4 + 昵称 <text>，白字 + 用户色 paint-order:stroke 描边，
 *     免测量的确定性做法）。多节点选中 → 多框但单标签。
 *   - 用户消失 → 其全部元素移除；用户保留 → 原地回填（节点可能已随布局移动），
 *     不重复建元素；用户不再选中的节点上的框随之移除。
 *   - 不存在于场景（nodeEntries）或缺盒子几何的 nodeId 优雅跳过。
 * - clear()：移除全部光标元素（层本身保留，可继续 setCursors）。
 * - 纯渲染无事件；选区框 pointer-events=none，不遮挡宿主交互。
 */
import type { SceneRoot } from './render';
import type { NodeBox } from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 协作光标 10 色板（高对比、避开纯红/纯绿对，红绿色弱可辨）。
 * 导出供测试与页面侧图例复用；顺序即取模顺序，勿重排（会话内色随序固定）。
 */
export const CURSOR_COLORS: readonly string[] = [
  '#2563eb', // 蓝
  '#ea580c', // 橙
  '#0d9488', // 青绿
  '#7c3aed', // 紫
  '#ca8a04', // 金
  '#0891b2', // 青
  '#c026d3', // 品红
  '#92400e', // 棕
  '#1d4ed8', // 藏青
  '#db2777', // 粉
];

/** FNV-1a 32 位哈希（确定性，跨会话稳定）。 */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 用户 → 稳定光标色：FNV-1a(userId) 对色板取模（同一 userId 恒定同色）。 */
export function colorForUser(userId: string): string {
  return CURSOR_COLORS[fnv1a(userId) % CURSOR_COLORS.length];
}

/** 远端用户光标/选区输入（color 一般来自 colorForUser，页面侧也可自定义）。 */
export interface RemoteCursor {
  userId: string;
  name: string;
  color: string;
  /** 该用户当前选中的节点 id 列表（首个存在节点为标签锚点）。 */
  nodeIds: string[];
}

/** 远端光标层句柄（纯渲染，无事件；随场景生命周期，无 destroy）。 */
export interface CursorLayer {
  /** 整集差分：以 boxes（当前布局盒子）解析几何，cursors 为全量远端用户集。 */
  setCursors(cursors: RemoteCursor[], boxes: NodeBox[]): void;
  /** 清空全部光标元素（层保留）。 */
  clear(): void;
}

/** 数值 → 属性串：与 render.ts 同规（两位小数去尾零），坐标/尺寸输出确定。 */
function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key] as string | number));
  return node;
}

/** 选区框描边宽 / 标签几何常量（确定性）。 */
const SELECTION_STROKE_WIDTH = 2.5;
const LABEL_OFFSET_Y = 18;
const LABEL_MIN_Y = 2;
const LABEL_DOT_R = 4;
const LABEL_FONT_SIZE = 11;
/** 选区框 map 键分隔符（userId 不含 \u0000，拼键无歧义）。 */
const KEY_SEP = '\u0000';

/**
 * 创建远端光标层：<g class="gm-cursors"> 追加到 scene.nodesLayer 末尾
 * （最上层、随视口 transform）。重复创建时移除旧层（幂等重建）。
 */
export function createCursorLayer(scene: SceneRoot): CursorLayer {
  scene.nodesLayer.querySelector('g.gm-cursors')?.remove();
  const layer = el('g', { class: 'gm-cursors' });
  scene.nodesLayer.appendChild(layer);

  /** 标签元素按 userId 键（幂等复用）。 */
  const labels = new Map<string, SVGGElement>();
  /** 选区框按 `${userId}\u0000${nodeId}` 键（幂等复用，跨更新保引用）。 */
  const rects = new Map<string, SVGRectElement>();

  const setCursors = (cursors: RemoteCursor[], boxes: NodeBox[]): void => {
    const boxById = new Map(boxes.map((b) => [b.id, b]));
    const seenRectKeys = new Set<string>();
    const seenUsers = new Set<string>();

    for (const cursor of cursors) {
      // 该用户在本场景中真实可渲染的选中节点（按 nodeIds 首现序，去重）。
      const anchored: NodeBox[] = [];
      const seenNodes = new Set<string>();
      for (const nodeId of cursor.nodeIds) {
        if (seenNodes.has(nodeId)) continue;
        seenNodes.add(nodeId);
        const entry = scene.nodeEntries.get(nodeId);
        const b = boxById.get(nodeId);
        if (!entry || !b) continue; // 不存在的 nodeId 优雅跳过
        anchored.push(b);

        const key = `${cursor.userId}${KEY_SEP}${nodeId}`;
        seenRectKeys.add(key);
        let rect = rects.get(key);
        if (!rect) {
          rect = el('rect', {
            class: 'gm-remote-selection',
            x: '0',
            y: '0',
            fill: 'none',
            'stroke-width': SELECTION_STROKE_WIDTH,
            'pointer-events': 'none',
          });
          rects.set(key, rect);
        }
        entry.g.appendChild(rect); // 已挂载则保持末位（同父 append 为无位移幂等）
        rect.setAttribute('width', fmt(b.w));
        rect.setAttribute('height', fmt(b.h));
        rect.setAttribute('stroke', cursor.color);
        rect.setAttribute('data-cursor-user', cursor.userId);
      }

      if (anchored.length === 0) continue; // 无可锚定节点：不渲染标签
      seenUsers.add(cursor.userId);
      let label = labels.get(cursor.userId);
      if (!label) {
        label = el('g', { class: 'gm-remote-cursor', 'pointer-events': 'none' });
        label.appendChild(el('circle', { cx: '4', cy: '-4', r: LABEL_DOT_R }));
        // 白字 + 用户色 paint-order:stroke 描边：任何背景可读，免文本测量。
        label.appendChild(
          el('text', {
            x: '12',
            y: '0',
            'font-size': LABEL_FONT_SIZE,
            fill: '#ffffff',
            'stroke-width': '3',
            'paint-order': 'stroke',
          }),
        );
        labels.set(cursor.userId, label);
      }
      layer.appendChild(label);
      const anchor = anchored[0];
      if (anchor) {
        label.setAttribute('data-cursor-user', cursor.userId);
        label.setAttribute(
          'transform',
          `translate(${fmt(anchor.x)}, ${fmt(Math.max(anchor.y - LABEL_OFFSET_Y, LABEL_MIN_Y))})`,
        );
        label.querySelector('circle')?.setAttribute('fill', cursor.color);
        const text = label.querySelector('text');
        if (text) {
          text.textContent = cursor.name;
          text.setAttribute('stroke', cursor.color);
        }
      }
    }

    // 差分清理：不再选中的（用户, 节点）框、已消失的用户标签。
    for (const [key, rect] of rects) {
      if (!seenRectKeys.has(key)) {
        rect.remove();
        rects.delete(key);
      }
    }
    for (const [userId, label] of labels) {
      if (!seenUsers.has(userId)) {
        label.remove();
        labels.delete(userId);
      }
    }
  };

  const clear = (): void => {
    for (const rect of rects.values()) rect.remove();
    rects.clear();
    for (const label of labels.values()) label.remove();
    labels.clear();
  };

  return { setCursors, clear };
}
