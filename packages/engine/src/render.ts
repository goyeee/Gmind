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
 *   fill/字体取解析样式）、标记区（M7a-T1 三组制，固定组序 priority→icon→emoji，
 *   图标行位置不变——节点框内文字左侧）：priority '1'-'7' 渲染为彩色数字方块
 *   <g class="gm-priority-badge">（rect+text，取 mindgrid --c-priority-1..7 配色），
 *   icon 组 10 符号与 emoji 组 10 字符拼进同一 <text class="gm-icons">（icon 组按
 *   ICON_GLYPHS slug→符号；emoji 值本身即字形）；旧 progress 环/旗帜/星标组与
 *   未知组一律忽略（存量文档经 core repair 收敛，未收敛窗口期忽略即可）、
 *   <text class="gm-note-badge">（note 非空渲染 'N'）、<text class="gm-link-badge">
 *   （href 非空渲染）、<text class="gm-comment-badge">（commentCount>0 渲染计数，
 *   FR-CMT-002；与 note/link 同一右上角错位方案，自右缘起 link→note→comment 让位）、
 *   <image class="gm-image">（href=/api/images/{key}，宽高用
 *   image.w/h——页面侧负责 ≤200px 等比钳制；盒高计入图片高度（图与文本的节点内堆叠视觉仍后置））、
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
  SummaryBox,
  ThemeTokens,
} from './types';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 标记三组固定渲染序（M7a-T1）：priority 方块占第 1 槽，icon/emoji 字形随后。 */
const MARKER_ROW_ORDER = ['priority', 'icon', 'emoji'] as const;

/**
 * 优先级方块配色（M7a-T1，取 mindgrid app/src/index.css --c-priority-1..7 原值）：
 * 1 红 #d9534f / 2 橙 #d98841 / 3 黄 #d9a441 / 4 绿 #4d9960 / 5 蓝 #7aa2f7 /
 * 6 紫 #bb9af7 / 7 灰 #8a8a8a（1 最高优先级，7 最低）。
 */
export const PRIORITY_BADGE_COLORS = [
  '#d9534f',
  '#d98841',
  '#d9a441',
  '#4d9960',
  '#7aa2f7',
  '#bb9af7',
  '#8a8a8a',
] as const;

/**
 * icon 组 slug → 符号映射（M7a-T1 三组制，10 个；与 core ICON_VALUES 一一对应）：
 * done ✓ / cancel ✗ / important ★ / flag ⚑ / question ? / alert ! / idea 💡 /
 * like ♥ / link 🔗 / clock ⏰。emoji 组例外：值本身即字形，此处仅登记组名以纳入
 * 固定组序与存在性判定。
 */
export const ICON_GLYPHS: Record<string, string> = {
  done: '✓',
  cancel: '✗',
  important: '★',
  flag: '⚑',
  question: '?',
  alert: '!',
  idea: '💡',
  like: '♥',
  link: '🔗',
  clock: '⏰',
};

/** 优先级方块几何（确定性常量）：14×14 圆角方块，槽宽 iconSlotWidth 内居中。 */
const PRIORITY_BADGE_SIZE = 14;
const PRIORITY_BADGE_RX = 3;
const PRIORITY_BADGE_FONT_SIZE = 10;

/** 折叠徽标几何（确定性常量）。 */
const BADGE_W = 28;
const BADGE_H = 18;
const BADGE_RX = 9;
const BADGE_FONT_SIZE = 12;

/** 概要 bracket 几何（M6 Task 6，确定性常量）：端子上挑 6px、label 12px 居中行下。 */
const SUMMARY_TICK = 6;
const SUMMARY_FONT_SIZE = 12;
/** label 基线相对 bracket 横线的行下偏移（= bracket 视觉下缘）。导出边界外扩消费
 *  （export.ts，M6 终审修复）——引擎内单源，不再手抄。 */
export const SUMMARY_LABEL_BASELINE = 14;

/** 角标（note/link）基线与右内边距。 */
const CORNER_BADGE_BASELINE = 12;
const CORNER_BADGE_FONT_SIZE = 12;
const CORNER_BADGE_PAD = 6;
/** link/note/comment 角标的水平错位步长（同时存在时不重叠，自右缘依次让位）。 */
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
  /** 优先级彩色数字方块（M7a-T1；g 内含 rect+text，无优先级时为 null）。 */
  priorityBadge: SVGGElement | null;
  priorityRect: SVGRectElement | null;
  priorityText: SVGTextElement | null;
  icons: SVGTextElement | null;
  noteBadge: SVGTextElement | null;
  linkBadge: SVGTextElement | null;
  commentBadge: SVGTextElement | null;
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

/** 概要协调条目（M6 Task 6）：g + 下括弧 path + 居中 label。 */
export interface SummaryEntry {
  g: SVGGElement;
  path: SVGPathElement;
  label: SVGTextElement;
  /** 上次渲染的 label（textContent 仅在变化时回写）。 */
  lastLabel: string;
}

/**
 * 场景根：三层 <g>（边/概要/节点）+ 按 id 的协调注册表（plain Map，非 WeakMap——
 * 供宿主/测试直接检视；renderScene 全权维护其内容）。
 */
export interface SceneRoot {
  readonly svg: SVGSVGElement;
  readonly edgesLayer: SVGGElement;
  readonly summariesLayer: SVGGElement;
  readonly nodesLayer: SVGGElement;
  readonly nodeEntries: Map<string, NodeEntry>;
  readonly edgeEntries: Map<string, EdgeEntry>;
  readonly summaryEntries: Map<string, SummaryEntry>;
}

/** 节点视觉数据（布局盒子之外的渲染输入；collapsed 计数走 layout.collapsedCounts）。 */
export interface NodeVisual {
  text: string;
  icons?: Record<string, unknown>;
  note?: string;
  href?: string;
  image?: { key: string; w: number; h: number } | null;
  /** 未解决评论数（FR-CMT-002）：>0 渲染右上角计数角标；仅存活节点携带。 */
  commentCount?: number;
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
 * 创建场景：清空 svg 既有内容，建立 <g class="gm-edges">（下）、
 * <g class="gm-summaries">（中，M6 Task 6）与 <g class="gm-nodes">（上）三层，
 * 返回带空注册表的场景根。
 */
export function createScene(svg: SVGSVGElement): SceneRoot {
  while (svg.firstChild) svg.firstChild.remove();
  const edgesLayer = el('g', { class: 'gm-edges' });
  const summariesLayer = el('g', { class: 'gm-summaries' });
  const nodesLayer = el('g', { class: 'gm-nodes' });
  svg.appendChild(edgesLayer);
  svg.appendChild(summariesLayer);
  svg.appendChild(nodesLayer);
  return {
    svg,
    edgesLayer,
    summariesLayer,
    nodesLayer,
    nodeEntries: new Map(),
    edgeEntries: new Map(),
    summaryEntries: new Map(),
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

/** 优先级值 '1'-'7' → 方块渲染序号（null = 值不在目录，防御忽略——槽位仍保留给布局）。 */
function priorityLevelOf(value: unknown): number | null {
  const s = typeof value === 'string' ? value : null;
  return s !== null && /^[1-7]$/.test(s) ? Number(s) : null;
}

/** 标记区 glyph 文本（M7a-T1）：icon 组 slug→符号 + emoji 值本身，固定组序
 *  icon→emoji（priority 由独立方块渲染，不占 glyph 文本）；未知组忽略。
 *  返回 [字形串, 是否有优先级方块]。 */
function markerGlyphs(icons: Record<string, unknown> | undefined): [string, boolean] {
  if (!icons) return ['', false];
  const hasPriority = priorityLevelOf(icons.priority) !== null;
  let out = '';
  for (const group of MARKER_ROW_ORDER) {
    if (group === 'priority') continue;
    if (group in icons) out += group === 'emoji' ? String(icons[group]) : ICON_GLYPHS[String(icons[group])] ?? '';
  }
  return [out, hasPriority];
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

/** 评论角标 x：自右缘起被 link/note 各让一位（同 render 的确定性槽位公式）。 */
function commentBadgeX(b: NodeBox, hasLink: boolean, hasNote: boolean): number {
  return (
    b.w - CORNER_BADGE_PAD - (hasLink ? CORNER_BADGE_STEP : 0) - (hasNote ? CORNER_BADGE_STEP : 0)
  );
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
      priorityBadge: null,
      priorityRect: null,
      priorityText: null,
      icons: null,
      noteBadge: null,
      linkBadge: null,
      commentBadge: null,
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

  // 标记区（M7a-T1 三组制，固定组序 priority→icon→emoji，位置不变：文字左侧）。
  const [glyphs, hasPriority] = markerGlyphs(visual.icons);
  const level = priorityLevelOf(visual.icons?.priority);

  // 优先级彩色数字方块：占标记区第 1 槽（iconSlotWidth 内 14×14 居中）。
  entry.priorityBadge = syncOptional(entry.priorityBadge, level !== null, g, () => {
    const badge = el('g', { class: 'gm-priority-badge' });
    badge.appendChild(el('rect', { rx: PRIORITY_BADGE_RX }));
    badge.appendChild(
      el('text', {
        'text-anchor': 'middle',
        'font-size': PRIORITY_BADGE_FONT_SIZE,
        'font-weight': 600,
        fill: '#ffffff',
      }),
    );
    return badge;
  });
  if (entry.priorityBadge && level !== null) {
    entry.priorityRect = entry.priorityBadge.children[0] as SVGRectElement;
    entry.priorityText = entry.priorityBadge.children[1] as SVGTextElement;
    const bx = theme.nodePaddingX + (theme.iconSlotWidth - PRIORITY_BADGE_SIZE) / 2;
    const by = b.h / 2 - PRIORITY_BADGE_SIZE / 2;
    entry.priorityRect.setAttribute('x', fmt(bx));
    entry.priorityRect.setAttribute('y', fmt(by));
    entry.priorityRect.setAttribute('width', String(PRIORITY_BADGE_SIZE));
    entry.priorityRect.setAttribute('height', String(PRIORITY_BADGE_SIZE));
    entry.priorityRect.setAttribute('fill', PRIORITY_BADGE_COLORS[level - 1] as string);
    entry.priorityText.setAttribute('x', fmt(bx + PRIORITY_BADGE_SIZE / 2));
    entry.priorityText.setAttribute('y', fmt(b.h / 2 + PRIORITY_BADGE_FONT_SIZE * 0.36));
    if (entry.priorityText.textContent !== String(level)) {
      entry.priorityText.textContent = String(level);
    }
  } else {
    entry.priorityRect = null;
    entry.priorityText = null;
  }

  // icon/emoji 字形文本：有字符才存在；priority 方块占位时右移一个槽。
  const glyphsX = theme.nodePaddingX + (hasPriority ? theme.iconSlotWidth : 0);
  entry.icons = syncOptional(entry.icons, glyphs !== '', g, () =>
    el('text', {
      class: 'gm-icons',
      x: fmt(glyphsX),
      y: fmt(b.h / 2 + fontSize * 0.35),
      'font-size': fmt(fontSize),
      fill: style.textColor,
    }),
  );
  if (entry.icons) {
    entry.icons.textContent = glyphs;
    // 属性回填（创建后每次更新）：跨深度复用节点时字号/文字色随 styleOf 变化。
    entry.icons.setAttribute('y', fmt(b.h / 2 + fontSize * 0.35));
    entry.icons.setAttribute('x', fmt(glyphsX));
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
    // 悬停预览前 200 字（FR-EDT-018）：SVG <title> 子元素是标准的原生 tooltip
    // 机制——SVG 元素上的 HTML title 属性多数浏览器不渲染提示（M1 验收修复轮
    // 改造）。textContent 赋值会清空子元素，故每次渲染后回填 <title> 子元素。
    const preview = (visual.note ?? '').slice(0, 200);
    const titleEl = el('title');
    titleEl.textContent = preview;
    entry.noteBadge.appendChild(titleEl);
  }

  // 评论角标（FR-CMT-002）：commentCount>0 渲染计数字符，与 note/link 同一右上角
  // CORNER_BADGE 方案——槽位自右缘起 link→note→comment 依次让位一步（确定性不重叠）。
  // 镜像 note 角标纪律：syncOptional 增删 + 每次渲染回填 x/fill（元素引用保持）。
  const commentCount = visual.commentCount ?? 0;
  entry.commentBadge = syncOptional(
    entry.commentBadge,
    commentCount > 0,
    g,
    () =>
      el('text', {
        class: 'gm-comment-badge',
        x: fmt(commentBadgeX(b, hasLink, hasNote)),
        y: fmt(CORNER_BADGE_BASELINE),
        'text-anchor': 'end',
        'font-size': fmt(CORNER_BADGE_FONT_SIZE),
        fill: style.textColor,
      }),
  );
  if (entry.commentBadge) {
    entry.commentBadge.textContent = String(commentCount);
    entry.commentBadge.setAttribute('x', fmt(commentBadgeX(b, hasLink, hasNote)));
    entry.commentBadge.setAttribute('fill', style.textColor);
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
 * 单概要协调（M6 Task 6）：不存在则创建 <g data-summary-id class="gm-summary">，
 * 存在则就地改属性（引用恒定）。下括弧 path（局部坐标）：端子上挑 SUMMARY_TICK、
 * 横线贴 y=0；label 居中于 w/2、基线行下 SUMMARY_LABEL_BASELINE。
 */
function applySummary(scene: SceneRoot, s: SummaryBox, theme: ThemeTokens): void {
  let entry = scene.summaryEntries.get(s.id);
  if (!entry) {
    const g = el('g', { 'data-summary-id': s.id, class: 'gm-summary' });
    const path = el('path', { class: 'gm-summary-bracket', fill: 'none' });
    const label = el('text', {
      class: 'gm-summary-label',
      'text-anchor': 'middle',
      'font-size': fmt(SUMMARY_FONT_SIZE),
    });
    g.appendChild(path);
    g.appendChild(label);
    scene.summariesLayer.appendChild(g);
    entry = { g, path, label, lastLabel: '' };
    scene.summaryEntries.set(s.id, entry);
  }
  const { g, path, label } = entry;
  g.setAttribute('transform', `translate(${fmt(s.x)}, ${fmt(s.y)})`);
  path.setAttribute('d', `M 0 ${fmt(-SUMMARY_TICK)} L 0 0 L ${fmt(s.w)} 0 L ${fmt(s.w)} ${fmt(-SUMMARY_TICK)}`);
  path.setAttribute('stroke', theme.edgeColor);
  path.setAttribute('stroke-width', fmt(theme.edgeWidth));
  label.setAttribute('x', fmt(s.w / 2));
  label.setAttribute('y', fmt(SUMMARY_LABEL_BASELINE));
  label.setAttribute('fill', theme.edgeColor);
  if (entry.lastLabel !== s.label) {
    label.textContent = s.label;
    entry.lastLabel = s.label;
  }
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

  // 概要 bracket（M6 Task 6，只增不改）：同款按 id 集合差分协调。
  const seenSummaries = new Set<string>();
  for (const s of layout.summaries) {
    seenSummaries.add(s.id);
    applySummary(scene, s, theme);
  }
  for (const [id, entry] of scene.summaryEntries) {
    if (!seenSummaries.has(id)) {
      entry.g.remove();
      scene.summaryEntries.delete(id);
    }
  }
}
