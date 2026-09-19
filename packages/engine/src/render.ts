/**
 * SVG 场渲染器与按 id 协调更新 — M1b Task 6。
 *
 * 绑定裁决（M1b 计划 Task 6）：
 * - createScene：在 svg 内建 <g class="gm-edges">（下）+ <g class="gm-nodes">（上）两层，
 *   创建前清空 svg 既有内容（幂等重建）。
 * - renderScene 按 id 集合差分协调：id 消失 → 元素移除；id 新增 → 创建；id 保持 →
 *   就地改属性，**既有 DOM 元素引用恒定**（焦点/事件委托稳定性）。
 *   文本 tspan 仅在文本变化时重建（未变文本的 tspan 元素引用也不变）。
 * - 节点 <g data-node-id> 子元素：rect（圆角=theme.nodeBorderRadius、填充/描边/
 *   描边宽 = styleOf 解析结果 + theme）、<text class="gm-text">（按 '\n' 分 tspan，
 *   fill/字体取解析样式）、<text class="gm-icons">（图标字符映射，固定组序
 *   priority→progress→flag→star，未知组忽略；M1b 值后缀不区分字形，视觉打磨后置）、
 *   <text class="gm-note-badge">（note 非空渲染 'N'）、<text class="gm-link-badge">
 *   （href 非空渲染）、<image class="gm-image">（href=/api/images/{key}，宽高用
 *   image.w/h——页面侧负责 ≤200px 等比钳制；M1b 盒高不含图，重叠视觉后置）、
 *   折叠徽标 <g class="gm-collapse-badge" data-for-id>（「+N」，N=collapsedCounts；
 *   位置按 box.side 确定：right→盒右、left→盒左、down→盒下）。
 * - 边 <path data-edge-id>：bezier 为 `M from C c1 c2 to`（controls 恒 2 个，缺省退化）；
 *   elbow 为正交段（有 controls 走控制点折线，org 无 controls 按两端算中线拐点）。
 *   stroke/stroke-width 取 theme.edgeColor/edgeWidth，fill=none。
 * - 样式全走属性，无 CSS 文件；不绑任何事件（交互层 Task 8/9 事件委托）。
 */
import type {
  EdgeRoute,
  LayoutResult,
  NodeBox,
  ResolvedNodeStyle,
  ThemeTokens,
} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 图标字符映射表：key=图标组名，value=M1b 占位字符（值后缀不区分，T12+ 再丰富）。 */
export const ICON_GLYPHS: Record<string, string> = {
  priority: '①',
  progress: '◐',
  flag: '⚑',
  star: '★',
};

/** 折叠徽标几何（确定性常量）。 */
const BADGE_W = 28;
const BADGE_H = 18;
const BADGE_RX = 9;
const BADGE_FONT_SIZE = 12;

/** 角标（note/link）基线与右内边距。 */
const CORNER_BADGE_BASELINE = 12;
const CORNER_BADGE_FONT_SIZE = 12;
const CORNER_BADGE_PAD = 6;
/** link 角标与 note 角标的水平错位步长（同时存在时不重叠）。 */
const CORNER_BADGE_STEP = 18;

/** 数值 → 属性串：统一保留两位小数并去掉尾零（坐标/尺寸全走此格式，输出确定）。 */
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

// ---------------------------------------------------------------------------
// 场景根与注册表
// ---------------------------------------------------------------------------

/** 节点协调条目：元素引用 + 需差分的状态。 */
export interface NodeEntry {
  g: SVGGElement;
  rect: SVGRectElement;
  text: SVGTextElement;
  icons: SVGTextElement | null;
  noteBadge: SVGTextElement | null;
  linkBadge: SVGTextElement | null;
  image: SVGImageElement | null;
  badge: SVGGElement | null;
  badgeText: SVGTextElement | null;
  /** 上次渲染的文本（tspan 仅在变化时重建）。 */
  lastText: string;
}

/** 边协调条目。 */
export interface EdgeEntry {
  path: SVGPathElement;
}

/**
 * 场景根：两层 <g> + 按 id 的协调注册表（plain Map，非 WeakMap——
 * 供宿主/测试直接检视；renderScene 全权维护其内容）。
 */
export interface SceneRoot {
  readonly svg: SVGSVGElement;
  readonly edgesLayer: SVGGElement;
  readonly nodesLayer: SVGGElement;
  readonly nodeEntries: Map<string, NodeEntry>;
  readonly edgeEntries: Map<string, EdgeEntry>;
}

/** 节点视觉数据（布局盒子之外的渲染输入；collapsed 计数走 layout.collapsedCounts）。 */
export interface NodeVisual {
  text: string;
  icons?: Record<string, unknown>;
  note?: string;
  href?: string;
  image?: { key: string; w: number; h: number } | null;
}

/** 渲染输入：布局结果 + 主题 + 样式解析 + 文档视觉数据。 */
export interface SceneInput {
  layout: LayoutResult;
  theme: ThemeTokens;
  /** 节点最终样式（主题分级 + nodeStyle 覆盖已在页面侧闭合）。 */
  styleOf: (id: string) => ResolvedNodeStyle;
  nodeData: Map<string, NodeVisual>;
}

/**
 * 创建场景：清空 svg 既有内容，建立 <g class="gm-edges">（下）与
 * <g class="gm-nodes">（上）两层，返回带空注册表的场景根。
 */
export function createScene(svg: SVGSVGElement): SceneRoot {
  while (svg.firstChild) svg.firstChild.remove();
  const edgesLayer = el('g', { class: 'gm-edges' });
  const nodesLayer = el('g', { class: 'gm-nodes' });
  svg.appendChild(edgesLayer);
  svg.appendChild(nodesLayer);
  return {
    svg,
    edgesLayer,
    nodesLayer,
    nodeEntries: new Map(),
    edgeEntries: new Map(),
  };
}

// ---------------------------------------------------------------------------
// 协调更新
// ---------------------------------------------------------------------------

/** 按需创建/移除可选子元素；wanted=false 时移除并返回 null，保持引用不变。 */
function syncOptional<T extends SVGElement>(
  current: T | null,
  wanted: boolean,
  parent: SVGGElement,
  make: () => T,
): T | null {
  if (wanted) {
    if (!current) {
      const node = make();
      parent.appendChild(node);
      return node;
    }
    return current;
  }
  current?.remove();
  return null;
}

/** 图标组按固定序拼字符（未知组忽略；无图标返回空串）。 */
function iconGlyphs(icons: Record<string, unknown> | undefined): string {
  if (!icons) return '';
  let out = '';
  for (const group of Object.keys(ICON_GLYPHS)) {
    if (group in icons) out += ICON_GLYPHS[group];
  }
  return out;
}

/** 折叠徽标位移：right→盒右、left→盒左、down→盒下（由 box.side 确定性决定）。 */
function badgeTransform(b: NodeBox): string {
  switch (b.side) {
    case 'left':
      return `translate(${fmt(-BADGE_W)}, ${fmt(b.h / 2 - BADGE_H / 2)})`;
    case 'down':
      return `translate(${fmt(b.w / 2 - BADGE_W / 2)}, ${fmt(b.h)})`;
    default:
      return `translate(${fmt(b.w)}, ${fmt(b.h / 2 - BADGE_H / 2)})`;
  }
}

/** 单节点协调：不存在则创建，存在则就地改属性（g/rect/text 引用恒定）。 */
function applyNode(
  scene: SceneRoot,
  b: NodeBox,
  style: ResolvedNodeStyle,
  visual: NodeVisual,
  theme: ThemeTokens,
  collapsedCount: number,
): void {
  let entry = scene.nodeEntries.get(b.id);
  if (!entry) {
    const g = el('g', { 'data-node-id': b.id });
    const rect = el('rect');
    const text = el('text', { class: 'gm-text' });
    g.appendChild(rect);
    g.appendChild(text);
    scene.nodesLayer.appendChild(g);
    entry = {
      g,
      rect,
      text,
      icons: null,
      noteBadge: null,
      linkBadge: null,
      image: null,
      badge: null,
      badgeText: null,
      lastText: '',
    };
    scene.nodeEntries.set(b.id, entry);
  }
  const { g, rect, text } = entry;

  g.setAttribute('transform', `translate(${fmt(b.x)}, ${fmt(b.y)})`);

  rect.setAttribute('x', '0');
  rect.setAttribute('y', '0');
  rect.setAttribute('width', fmt(b.w));
  rect.setAttribute('height', fmt(b.h));
  rect.setAttribute('rx', fmt(theme.nodeBorderRadius));
  rect.setAttribute('fill', style.fill);
  rect.setAttribute('stroke', style.border);
  rect.setAttribute('stroke-width', fmt(theme.nodeBorderWidth));

  const fontSize = style.textStyle.fontSize;
  const iconCount = visual.icons ? Object.keys(visual.icons).length : 0;
  const textX = theme.nodePaddingX + iconCount * theme.iconSlotWidth;
  text.setAttribute('x', fmt(textX));
  text.setAttribute('fill', style.textColor);
  text.setAttribute('font-size', fmt(fontSize));
  text.setAttribute('font-weight', fmt(style.textStyle.fontWeight));
  text.setAttribute('font-family', style.textStyle.fontFamily);

  const lines = visual.text.split('\n');
  if (entry.lastText !== visual.text) {
    text.replaceChildren();
    for (const line of lines) {
      const tspan = el('tspan');
      tspan.textContent = line;
      text.appendChild(tspan);
    }
    entry.lastText = visual.text;
  }
  // 文本未变也需回填基线（盒高/字号变化时 y 位移；只改属性，不重建 tspan）。
  const lineHeight = fontSize * theme.lineHeightRatio;
  const baseline = (i: number): number =>
    b.h / 2 + (i - (lines.length - 1) / 2) * lineHeight + fontSize * 0.35;
  const spans = text.children;
  for (let i = 0; i < spans.length; i += 1) {
    (spans[i] as SVGTSpanElement).setAttribute('y', fmt(baseline(i)));
  }

  // 图标层：有字符才存在。
  const glyphs = iconGlyphs(visual.icons);
  entry.icons = syncOptional(entry.icons, glyphs !== '', g, () =>
    el('text', {
      class: 'gm-icons',
      x: fmt(theme.nodePaddingX),
      y: fmt(b.h / 2 + fontSize * 0.35),
      'font-size': fmt(fontSize),
      fill: style.textColor,
    }),
  );
  if (entry.icons) {
    entry.icons.textContent = glyphs;
    // 属性回填（创建后每次更新）：跨深度复用节点时字号/文字色随 styleOf 变化。
    entry.icons.setAttribute('y', fmt(b.h / 2 + fontSize * 0.35));
    entry.icons.setAttribute('x', fmt(theme.nodePaddingX));
    entry.icons.setAttribute('font-size', fmt(fontSize));
    entry.icons.setAttribute('fill', style.textColor);
  }

  // note / link 角标：note 非空渲染 'N'，href 非空渲染 🔗；同时存在时水平错位。
  const hasLink = (visual.href ?? '') !== '';
  const hasNote = (visual.note ?? '') !== '';
  entry.linkBadge = syncOptional(entry.linkBadge, hasLink, g, () =>
    el('text', {
      class: 'gm-link-badge',
      x: fmt(b.w - CORNER_BADGE_PAD),
      y: fmt(CORNER_BADGE_BASELINE),
      'text-anchor': 'end',
      'font-size': fmt(CORNER_BADGE_FONT_SIZE),
      fill: style.textColor,
    }),
  );
  if (entry.linkBadge) {
    entry.linkBadge.textContent = '🔗';
    // 属性回填：文本编辑加宽盒子后角标随右缘移动。
    entry.linkBadge.setAttribute('x', fmt(b.w - CORNER_BADGE_PAD));
    entry.linkBadge.setAttribute('fill', style.textColor);
  }
  entry.noteBadge = syncOptional(entry.noteBadge, hasNote, g, () =>
    el('text', {
      class: 'gm-note-badge',
      x: fmt(b.w - CORNER_BADGE_PAD - (hasLink ? CORNER_BADGE_STEP : 0)),
      y: fmt(CORNER_BADGE_BASELINE),
      'text-anchor': 'end',
      'font-size': fmt(CORNER_BADGE_FONT_SIZE),
      fill: style.textColor,
    }),
  );
  if (entry.noteBadge) {
    entry.noteBadge.textContent = 'N';
    entry.noteBadge.setAttribute(
      'x',
      fmt(b.w - CORNER_BADGE_PAD - (hasLink ? CORNER_BADGE_STEP : 0)),
    );
    entry.noteBadge.setAttribute('fill', style.textColor);
  }

  // image：href 走 /api/images/{key}；宽高直用 image.w/h（页面负责 ≤200px 钳制）。
  // 属性回填：同一节点换图/换尺寸时原地更新（元素引用保持）。
  const img = visual.image ?? null;
  entry.image = syncOptional(entry.image, img !== null, g, () =>
    el('image', {
      class: 'gm-image',
      x: fmt(theme.nodePaddingX),
      y: '0',
      width: fmt(img?.w ?? 0),
      height: fmt(img?.h ?? 0),
      href: `/api/images/${img?.key ?? ''}`,
    }),
  );
  if (entry.image && img) {
    entry.image.setAttribute('href', `/api/images/${img.key}`);
    entry.image.setAttribute('width', fmt(img.w));
    entry.image.setAttribute('height', fmt(img.h));
  }

  // 折叠徽标：+N，仅 count>0；元素随有无增删（旧徽标元素移除，不保留引用）。
  if (collapsedCount > 0) {
    if (!entry.badge) {
      const badge = el('g', { class: 'gm-collapse-badge', 'data-for-id': b.id });
      badge.appendChild(
        el('rect', {
          x: 0,
          y: 0,
          width: BADGE_W,
          height: BADGE_H,
          rx: BADGE_RX,
          fill: theme.collapseBadgeBg,
        }),
      );
      const badgeText = el('text', {
        x: fmt(BADGE_W / 2),
        y: fmt(BADGE_H / 2 + 4),
        'text-anchor': 'middle',
        'font-size': fmt(BADGE_FONT_SIZE),
        fill: theme.collapseBadgeFg,
      });
      badge.appendChild(badgeText);
      g.appendChild(badge);
      entry.badge = badge;
      entry.badgeText = badgeText;
    }
    entry.badge.setAttribute('transform', badgeTransform(b));
    if (entry.badgeText) entry.badgeText.textContent = `+${collapsedCount}`;
  } else {
    entry.badge?.remove();
    entry.badge = null;
    entry.badgeText = null;
  }
}

/** 边路径 d：bezier 用 controls；elbow 走控制点折线或按两端算正交中线拐点。 */
function edgeD(route: EdgeRoute): string {
  const { from, to } = route;
  const controls = route.controls ?? [];
  if (route.kind === 'bezier') {
    const c1 = controls[0] ?? from;
    const c2 = controls[1] ?? to;
    return `M ${fmt(from.x)} ${fmt(from.y)} C ${fmt(c1.x)} ${fmt(c1.y)} ${fmt(c2.x)} ${fmt(c2.y)} ${fmt(to.x)} ${fmt(to.y)}`;
  }
  if (controls.length > 0) {
    const parts = [`M ${fmt(from.x)} ${fmt(from.y)}`];
    for (const c of controls) parts.push(`L ${fmt(c.x)} ${fmt(c.y)}`);
    parts.push(`L ${fmt(to.x)} ${fmt(to.y)}`);
    return parts.join(' ');
  }
  if (from.x === to.x) return `M ${fmt(from.x)} ${fmt(from.y)} L ${fmt(to.x)} ${fmt(to.y)}`;
  const mid = (from.y + to.y) / 2;
  return `M ${fmt(from.x)} ${fmt(from.y)} L ${fmt(from.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(mid)} L ${fmt(to.x)} ${fmt(to.y)}`;
}

/** 单边协调：不存在则创建 path，存在则重算 d（元素引用恒定）。 */
function applyEdge(scene: SceneRoot, route: EdgeRoute, theme: ThemeTokens): void {
  let entry = scene.edgeEntries.get(route.id);
  if (!entry) {
    const path = el('path', { 'data-edge-id': route.id, fill: 'none' });
    scene.edgesLayer.appendChild(path);
    entry = { path };
    scene.edgeEntries.set(route.id, entry);
  }
  entry.path.setAttribute('d', edgeD(route));
  entry.path.setAttribute('stroke', theme.edgeColor);
  entry.path.setAttribute('stroke-width', fmt(theme.edgeWidth));
}

/**
 * 按布局结果协调场景：节点/边按 id 集合差分——新增创建、消失移除、保持就地更新。
 * 既有元素引用恒定（文本 tspan 仅在文本变化时重建）。
 */
export function renderScene(scene: SceneRoot, input: SceneInput): void {
  const { layout, theme, styleOf, nodeData } = input;

  const seenNodes = new Set<string>();
  for (const b of layout.nodes) {
    seenNodes.add(b.id);
    applyNode(
      scene,
      b,
      styleOf(b.id),
      nodeData.get(b.id) ?? { text: '' },
      theme,
      layout.collapsedCounts.get(b.id) ?? 0,
    );
  }
  for (const [id, entry] of scene.nodeEntries) {
    if (!seenNodes.has(id)) {
      entry.g.remove();
      scene.nodeEntries.delete(id);
    }
  }

  const seenEdges = new Set<string>();
  for (const route of layout.edges) {
    seenEdges.add(route.id);
    applyEdge(scene, route, theme);
  }
  for (const [id, entry] of scene.edgeEntries) {
    if (!seenEdges.has(id)) {
      entry.path.remove();
      scene.edgeEntries.delete(id);
    }
  }
}
