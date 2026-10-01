/**
 * SVG 场渲染器与按 id 协调更新 — M1b Task 6。
 *
 * 绑定裁决（M1b 计划 Task 6）：
 * - createScene：在 svg 内建 <g class="gm-edges">（下）+ <g class="gm-nodes">（上）两层，
 *   创建前清空 svg 既有内容（幂等重建）。
 * - renderScene 按 id 集合差分协调：id 消失 → 元素移除；id 新增 → 创建；id 保持 →
 *   就地改属性，**既有 DOM 元素引用恒定**（焦点/事件委托稳定性）。
 *   文本 tspan 仅在行内容变化时重建（未变文本的 tspan 元素引用也不变）。
 * - 节点 <g data-node-id> 子元素：rect（圆角=theme.nodeBorderRadius、填充/描边/
 *   描边宽 = styleOf 解析结果 + theme）、<text class="gm-text">（行结构单源 = 测量
 *   断行：visual.lines（renderScene 自 box.lines 合并），无则按 '\n' 显式分行兜底；
 *   fill/字体取解析样式）、标记区（M7b-W1 八组制多值，固定组序
 *   mood→priority→number→arrow→flag→progress→other→emoji，位置不变——节点框内
 *   文字左侧）：<g class="gm-markers"> 内逐值绘制彩色徽标 <g class="gm-marker-badge"
 *   data-marker-group data-marker-value>（M7b-W3 起携带组/值锚点供页面层点击换组；
 *   MARKER_CATALOG 字形/配色，槽宽自适应徽标数；目录外值确定性忽略）、
 *   <text class="gm-note-badge">（note 非空渲染 'N'）、<text class="gm-link-badge">
 *   （href 非空渲染）、<text class="gm-comment-badge">（commentCount>0 渲染计数，
 *   FR-CMT-002；与 note/link 同一右上角错位方案，自右缘起 link→note→comment 让位）、
 *   <image class="gm-image">（href=/api/images/{key}，宽高用
 *   image.w/h——页面侧负责 ≤200px 等比钳制；盒高计入图片高度（图与文本的节点内堆叠视觉仍后置））、
 *   任务视觉（M7c-C2，只增不改；无任务信息=hasTaskInfo false 时全部不渲染，
 *   DOM 与现状一致）：<rect class="gm-task-bar">（左缘 3px 竖条，fill 按
 *   task.status 走 TASK_STATUS_COLORS 企微四色）、<g class="gm-task-row">
 *   （卡片第二行任务信息行：负责人色点头像 <circle class="gm-task-owner">
 *   （首人 colorForUser 色，多人加 <text class="gm-task-owner-plus">「+n」）、
 *   有效进度 <text class="gm-task-progress">（叶=自身、父=Σ 直属子级均值，
 *   口径=@gmind/shared effectiveProgress）、预期日期徽标 <rect class="gm-task-due-bg">
 *   + <text class="gm-task-due">（MM-DD；逾期（isOverdue 口径）红底白字否则灰底）。
 *   任务行占盒底 TASK_ROW_H 条带，主文本/标记行在其余区域垂直居中——无任务行时
 *   contentCenter 恒等于 b.h/2，既有几何逐字节不变）、
 *   <text class="gm-desc">（M7c-C1 节点描述第二行：text 下方 12px 灰 #86909c、
 *   单行省略——截断在测量期完成，直绘 box.descLine；占底部条带（任务行上方），
 *   无描述不渲染，DOM 与现状一致）、
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
import { colorForUser } from './cursors';
import { DESC_FONT_SIZE } from './measure';
import {
  TASK_AVATAR_D,
  TASK_AVATAR_PLUS_W,
  TASK_BAR_W,
  TASK_DUE_BG,
  TASK_DUE_FG,
  TASK_DUE_FONT_SIZE,
  TASK_DUE_H,
  TASK_DUE_OVERDUE_BG,
  TASK_DUE_W,
  TASK_GAP,
  TASK_META_FG,
  TASK_META_FONT_SIZE,
  TASK_PROGRESS_W,
  TASK_ROW_H,
  TASK_ROW_PAD,
  hasTaskInfo,
  taskOverdueIds,
  taskParentIds,
  taskProgressMap,
  taskRowSlotsOf,
  taskStatusColor,
  type NodeTaskVisual,
} from './taskvisual';
import { todayStr } from '@gmind/shared';
import {
  MARKER_BADGE_SIZE,
  MARKER_ROW_ORDER,
  drawMarkerBadge,
  markerCountOf,
  markerDefOf,
  markerSignatureOf,
  type MarkerGlyphDef,
} from './markers';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 折叠徽标几何（确定性常量）。 */
const BADGE_W = 28;
const BADGE_H = 18;
const BADGE_RX = 9;
const BADGE_FONT_SIZE = 12;

/** 概要 bracket 几何（M6 Task 6，确定性常量）：端子上挑 6px、label 12px 居中行下。 */
const SUMMARY_TICK = 6;
/** 概要标签字号（单源）：layout 标签避让测量同值消费（M7b 概要标签避让）。 */
export const SUMMARY_FONT_SIZE = 12;
/** label 基线相对 bracket 横线的行下偏移（= bracket 视觉下缘）。导出边界外扩消费
 *  （export.ts，M6 终审修复）——引擎内单源，不再手抄。 */
export const SUMMARY_LABEL_BASELINE = 14;

/** 角标（note/link）基线与右内边距。 */
const CORNER_BADGE_BASELINE = 12;
const CORNER_BADGE_FONT_SIZE = 12;
const CORNER_BADGE_PAD = 6;
/** link/note/comment 角标的水平错位步长（同时存在时不重叠，自右缘依次让位）。 */
const CORNER_BADGE_STEP = 18;

/** 描述行字色（M7c-C1，企微灰；字号/字族走 DESC_FONT_SIZE + 节点字族）。 */
const DESC_COLOR = '#86909c';

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
  /** 标记行容器（M7b-W1 八组制；内含逐值 <g class="gm-marker-badge">，无标记时 null）。 */
  markers: SVGGElement | null;
  /** 上次渲染的标记行签名（不变则徽标元素引用保持）。 */
  lastMarkersSig: string;
  noteBadge: SVGTextElement | null;
  linkBadge: SVGTextElement | null;
  commentBadge: SVGTextElement | null;
  image: SVGImageElement | null;
  /** 状态色左边条（M7c-C2；无任务信息时 null）。 */
  taskBar: SVGRectElement | null;
  /** 任务信息行容器（头像/进度/日期徽标；M7c-C2；无任务信息时 null）。 */
  taskRow: SVGGElement | null;
  /** 上次渲染的任务签名（签名+几何；变化才重建行内元素，引用保持策略同标记行）。 */
  lastTaskSig: string;
  /** 描述行（M7c-C1；盒无 descLine 时 null）。 */
  descText: SVGTextElement | null;
  badge: SVGGElement | null;
  badgeText: SVGTextElement | null;
  /** 上次渲染的行内容签名（行集 join('\u0000')；tspan 仅在变化时重建）。 */
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
  /**
   * 测量断行行集（长文本溢出修复）：renderScene 自 box.lines 合并（宿主无需自填，
   * 自填值会被盒数据覆盖）；缺省按 '\n' 显式分行兜底（手工构造布局/旧宿主兼容）。
   */
  lines?: string[];
  icons?: Record<string, unknown>;
  note?: string;
  href?: string;
  image?: { key: string; w: number; h: number } | null;
  /** 未解决评论数（FR-CMT-002）：>0 渲染右上角计数角标；仅存活节点携带。 */
  commentCount?: number;
  /**
   * 任务字段（M7c-C2，只增不改）：宿主自 NodeSnapshot.task 透传（结构兼容子集）。
   * 无任务信息（hasTaskInfo=false）= 纯脑图节点，零任务视觉、几何不变。
   */
  task?: NodeTaskVisual;
}

/** 渲染输入：布局结果 + 主题 + 样式解析 + 文档视觉数据。 */
export interface SceneInput {
  layout: LayoutResult;
  theme: ThemeTokens;
  /** 节点最终样式（主题分级 + nodeStyle 覆盖已在页面侧闭合）。 */
  styleOf: (id: string) => ResolvedNodeStyle;
  nodeData: Map<string, NodeVisual>;
  /**
   * 逾期判定的「今天」（YYYY-MM-DD，M7c-C2）：缺省取本地今天；测试/导出传
   * 固定值保确定性（当天到期不算逾期，isOverdue 口径）。
   */
  today?: string;
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

/** 标记区徽标绘制（M7b-W1）：按固定组序展开各组值数组，逐值经 MARKER_CATALOG
 *  绘制彩色徽标；目录外值（未收敛窗口期）确定性忽略。M7b-W3 起徽标携带
 *  data-marker-group/data-marker-value（节点标记点击换组的页面层命中锚点）。 */
function markerDefsOf(icons: Record<string, unknown> | undefined): Array<{ def: MarkerGlyphDef; group: string }> {
  if (!icons) return [];
  const defs: Array<{ def: MarkerGlyphDef; group: string }> = [];
  for (const group of MARKER_ROW_ORDER) {
    const values = icons[group];
    const list = Array.isArray(values) ? values : typeof values === 'string' && values !== '' ? [values] : [];
    for (const value of list) {
      const def = markerDefOf(group, String(value));
      if (def) defs.push({ def, group });
    }
  }
  return defs;
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

/** 单节点任务上下文（renderScene 预计算，M7c-C2）：有效进度 / 是否父节点 / 是否逾期。 */
interface NodeTaskContext {
  progress: number;
  parent: boolean;
  overdue: boolean;
}

/** 单节点协调：不存在则创建，存在则就地改属性（g/rect/text 引用恒定）。 */
function applyNode(
  scene: SceneRoot,
  b: NodeBox,
  style: ResolvedNodeStyle,
  visual: NodeVisual,
  theme: ThemeTokens,
  collapsedCount: number,
  taskCtx: NodeTaskContext,
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
      markers: null,
      lastMarkersSig: '',
      noteBadge: null,
      linkBadge: null,
      commentBadge: null,
      image: null,
      taskBar: null,
      taskRow: null,
      lastTaskSig: '',
      descText: null,
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
  const iconCount = markerCountOf(visual.icons);
  const textX = theme.nodePaddingX + iconCount * theme.iconSlotWidth;
  // 底部条带（M7c-C2 任务行 + M7c-C1 描述行）各占 TASK_ROW_H：主文本/标记行在其余
  // 区域垂直居中；任务行恒最底，描述行在其上（两者并存时）或独占底部条带（仅描述）。
  // 无任务行且无描述时 contentCenter === b.h/2，基线/标记位与旧版逐字节一致（只增不改）。
  const taskSlots = taskRowSlotsOf(visual.task, taskCtx.parent);
  const descLine = b.descLine ?? '';
  const contentCenter =
    (b.h - (taskSlots ? TASK_ROW_H : 0) - (descLine !== '' ? TASK_ROW_H : 0)) / 2;
  text.setAttribute('x', fmt(textX));
  text.setAttribute('fill', style.textColor);
  text.setAttribute('font-size', fmt(fontSize));
  text.setAttribute('font-weight', fmt(style.textStyle.fontWeight));
  text.setAttribute('font-family', style.textStyle.fontFamily);

  // 行结构单源 = 测量断行（visual.lines 由 renderScene 自 box.lines 合并）：长文本
  // 盒已按贪心断行定宽高，直绘同一行集才不溢出盒右缘；无断行数据时按 '\n' 显式
  // 分行兜底（手工构造布局/旧宿主，行为与旧版一致）。
  const lines = visual.lines ?? visual.text.split('\n');
  // tspan 重建键纳入行内容签名：同 text 不同断行（如字号变化触发重排）也触发重建。
  const linesSig = lines.join('\u0000');
  if (entry.lastText !== linesSig) {
    text.replaceChildren();
    for (const line of lines) {
      const tspan = el('tspan');
      tspan.textContent = line;
      text.appendChild(tspan);
    }
    entry.lastText = linesSig;
  }
  // 文本未变也需回填基线（盒高/字号变化时 y 位移；只改属性，不重建 tspan）。
  // tspan 必须显式回填 x：无 x 的 tspan 紧接前一行内联续排（SVG 文本流语义），
  // 第二行会从上一行末尾起步横向溢出节点盒——带 y 只重定位纵向、不带 x 不开新行。
  const lineHeight = fontSize * theme.lineHeightRatio;
  const baseline = (i: number): number =>
    contentCenter + (i - (lines.length - 1) / 2) * lineHeight + fontSize * 0.35;
  const spans = text.children;
  for (let i = 0; i < spans.length; i += 1) {
    (spans[i] as SVGTSpanElement).setAttribute('x', fmt(textX));
    (spans[i] as SVGTSpanElement).setAttribute('y', fmt(baseline(i)));
  }

  // 描述行（M7c-C1）：text 下方第二行——12px 灰（企微 #86909c）、单行省略（截断在
  // 测量期完成，b.descLine 即可安全直绘）。位置 = 底部条带：任务行上方或独占底部。
  // syncOptional 增删 + 每帧回填 x/y/font-family（盒变化随行位移），引用保持。
  entry.descText = syncOptional(entry.descText, descLine !== '', g, () =>
    el('text', {
      class: 'gm-desc',
      'font-size': fmt(DESC_FONT_SIZE),
      'font-weight': '400',
      fill: DESC_COLOR,
    }),
  );
  if (entry.descText) {
    entry.descText.textContent = descLine;
    entry.descText.setAttribute('x', fmt(textX));
    entry.descText.setAttribute('font-family', style.textStyle.fontFamily);
    const descCenter = taskSlots ? b.h - TASK_ROW_H - TASK_ROW_H / 2 : b.h - TASK_ROW_H / 2;
    entry.descText.setAttribute('y', fmt(descCenter + DESC_FONT_SIZE * 0.35));
  }

  // 标记区（M7b-W1 八组制多值，固定组序，位置不变：文字左侧）。签名差分：签名
  // 不变则徽标元素引用保持；变化时整行重建（徽标为无状态绘制，重建代价极小）。
  const markersSig = markerSignatureOf(visual.icons);
  const prevMarkers = entry.markers;
  entry.markers = syncOptional(entry.markers, markersSig !== '', g, () =>
    el('g', { class: 'gm-markers' }),
  );
  if (entry.markers !== prevMarkers) {
    // 容器实例变化（首次创建/整行摘除/摘除后再加）时签名缓存必须同步失效：
    // lastMarkersSig 只描述「当前容器实例」的 DOM 真态。摘除路径 syncOptional
    // 会整容器移除 DOM，但残留的旧签名会让 remove→re-add 同值序列（如加表情→
    // 取消→再加同一表情）命中缓存跳过重建，徽章只剩无字形占位壳——归零即强制
    // re-add 走完整重建；无变化时容器实例不变，不进此支，幂等语义保持。
    entry.lastMarkersSig = '';
  }
  if (entry.markers && entry.lastMarkersSig !== markersSig) {
    const defs = markerDefsOf(visual.icons);
    const children: SVGGElement[] = [];
    defs.forEach(({ def, group }, i) => {
      const badge = drawMarkerBadge(def);
      if (!badge) return; // 未知值：确定性忽略（槽位仍由布局按值数预留）
      const bx = theme.nodePaddingX + i * theme.iconSlotWidth + (theme.iconSlotWidth - MARKER_BADGE_SIZE) / 2;
      badge.setAttribute('transform', `translate(${fmt(bx)}, ${fmt(contentCenter - MARKER_BADGE_SIZE / 2)})`);
      // 点击换组命中锚点（M7b-W3）：组/值随签名重建写入，签名不变则引用保持、
      // 属性亦不变，无需每帧回填。
      badge.setAttribute('data-marker-group', group);
      badge.setAttribute('data-marker-value', def.value);
      children.push(badge);
    });
    entry.markers.replaceChildren(...children);
    entry.lastMarkersSig = markersSig;
  }
  if (entry.markers) {
    // 属性回填（创建后每次更新）：盒高/槽宽变化时徽标随行位移。
    entry.markers
      .querySelectorAll('g.gm-marker-badge')
      .forEach((badge, i) => {
        const bx = theme.nodePaddingX + i * theme.iconSlotWidth + (theme.iconSlotWidth - MARKER_BADGE_SIZE) / 2;
        badge.setAttribute('transform', `translate(${fmt(bx)}, ${fmt(contentCenter - MARKER_BADGE_SIZE / 2)})`);
      });
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

  // —— 任务视觉（M7c-C2，只增不改）——
  // 状态色左边条：左缘 TASK_BAR_W 竖条、全盒高，fill 按 task.status 四色；
  // 无任务信息（hasTaskInfo false）不创建（syncOptional 同步移除）。
  const task = visual.task;
  const hasTask = hasTaskInfo(task);
  entry.taskBar = syncOptional(entry.taskBar, hasTask, g, () => el('rect', { class: 'gm-task-bar' }));
  if (entry.taskBar) {
    entry.taskBar.setAttribute('x', '0');
    entry.taskBar.setAttribute('y', '0');
    entry.taskBar.setAttribute('width', fmt(TASK_BAR_W));
    entry.taskBar.setAttribute('height', fmt(b.h));
    entry.taskBar.setAttribute('fill', taskStatusColor(task?.status));
  }

  // 任务信息行：盒底 TASK_ROW_H 条带，行内容自右缘向左排（日期徽标→进度→负责人，
  // mindgrid 卡片行序的右对齐镜像）。签名（任务数据+盒几何）不变则整行元素引用
  // 保持（重建为无状态绘制，代价极小——同标记行策略）。
  const taskRowSig = hasTask
    ? `${task?.status ?? 'todo'}|${(task?.owners ?? []).join(',')}|${taskCtx.progress}|${task?.dueDate ?? ''}|${taskCtx.overdue ? 1 : 0}|${fmt(b.w)}x${fmt(b.h)}`
    : '';
  const prevTaskRow = entry.taskRow;
  entry.taskRow = syncOptional(entry.taskRow, hasTask, g, () => el('g', { class: 'gm-task-row' }));
  if (entry.taskRow !== prevTaskRow) {
    // 容器实例变化（首次创建/整行摘除/摘除后再加）⇒ 签名缓存同步归零：与标记行
    // 同一不变式——lastTaskSig 只描述当前容器实例的 DOM 真态，否则 remove→re-add
    // 相同任务数据会命中残留签名跳过重建，留下空任务行（M7c-L）。
    entry.lastTaskSig = '';
  }
  if (entry.taskRow && entry.lastTaskSig !== taskRowSig) {
    entry.lastTaskSig = taskRowSig;
    const rowY = b.h - TASK_ROW_H / 2;
    const owners = (task?.owners ?? []).filter((o) => o !== '');
    const parts: SVGElement[] = [];
    let cursor = b.w - TASK_ROW_PAD;
    // 预期日期徽标（最右）：MM-DD；逾期红底白字，否则灰底灰字。
    if ((task?.dueDate ?? '') !== '') {
      cursor -= TASK_DUE_W;
      parts.push(
        el('rect', {
          class: 'gm-task-due-bg',
          x: fmt(cursor),
          y: fmt(rowY - TASK_DUE_H / 2),
          width: fmt(TASK_DUE_W),
          height: fmt(TASK_DUE_H),
          rx: fmt(TASK_DUE_H / 2),
          fill: taskCtx.overdue ? TASK_DUE_OVERDUE_BG : TASK_DUE_BG,
        }),
      );
      const dueText = el('text', {
        class: 'gm-task-due',
        x: fmt(cursor + TASK_DUE_W / 2),
        y: fmt(rowY + TASK_DUE_FONT_SIZE * 0.35),
        'text-anchor': 'middle',
        'font-size': fmt(TASK_DUE_FONT_SIZE),
        fill: taskCtx.overdue ? '#ffffff' : TASK_DUE_FG,
      });
      dueText.textContent = (task?.dueDate ?? '').slice(5); // YYYY-MM-DD → MM-DD（同 mindgrid）
      parts.push(dueText);
      cursor -= TASK_GAP;
    }
    // 有效进度：叶=自身、父=Σ 直属子级均值（taskCtx.progress 已按 shared 口径聚合）。
    if (taskSlots?.showProgress) {
      cursor -= TASK_PROGRESS_W;
      const progressText = el('text', {
        class: 'gm-task-progress',
        x: fmt(cursor + TASK_PROGRESS_W),
        y: fmt(rowY + TASK_META_FONT_SIZE * 0.35),
        'text-anchor': 'end',
        'font-size': fmt(TASK_META_FONT_SIZE),
        fill: TASK_META_FG,
      });
      progressText.textContent = `${taskCtx.progress}%`;
      parts.push(progressText);
      cursor -= TASK_GAP;
    }
    // 负责人头像（最左）：首人 colorForUser 色点；多人加「+n」小字（右对齐行尾）。
    if (owners.length > 0) {
      const ownersW = TASK_AVATAR_D + (owners.length > 1 ? TASK_GAP + TASK_AVATAR_PLUS_W : 0);
      parts.push(
        el('circle', {
          class: 'gm-task-owner',
          cx: fmt(cursor - ownersW + TASK_AVATAR_D / 2),
          cy: fmt(rowY),
          r: fmt(TASK_AVATAR_D / 2),
          fill: colorForUser(owners[0] as string),
        }),
      );
      if (owners.length > 1) {
        const plus = el('text', {
          class: 'gm-task-owner-plus',
          x: fmt(cursor),
          y: fmt(rowY + TASK_META_FONT_SIZE * 0.35),
          'text-anchor': 'end',
          'font-size': fmt(TASK_META_FONT_SIZE),
          fill: TASK_META_FG,
        });
        plus.textContent = `+${owners.length - 1}`;
        parts.push(plus);
      }
    }
    entry.taskRow.replaceChildren(...parts);
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
 * 横线贴 y=0；label 基线行下 SUMMARY_LABEL_BASELINE。
 *
 * 标签定位（M7b 概要标签避让）：布局层对同侧概要给出外置锚点 labelX + labelAnchor
 * （右列概要 → bracket 右端外侧 anchor=start，左列镜像 anchor=end），渲染层只消费；
 * 缺省（跨侧概要 / org）保持旧居中口径 x=w/2 + anchor=middle。x/anchor 每次协调
 * 重算——概要成员增删引发同侧↔跨侧互转时，标签就地跟随布局结果（元素引用不变）。
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
  label.setAttribute('x', fmt(s.labelX ?? s.w / 2));
  label.setAttribute('text-anchor', s.labelAnchor ?? 'middle');
  label.setAttribute('y', fmt(SUMMARY_LABEL_BASELINE));
  label.setAttribute('fill', theme.edgeColor);
  if (entry.lastLabel !== s.label) {
    label.textContent = s.label;
    entry.lastLabel = s.label;
  }
}

/**
 * 按布局结果协调场景：节点/边按 id 集合差分——新增创建、消失移除、保持就地更新。
 * 既有元素引用恒定（文本 tspan 仅在行内容变化时重建）；盒带测量断行（box.lines）
 * 时合并进节点视觉数据，渲染行结构与定盒口径同源（长文本不溢出节点盒）。
 */
export function renderScene(scene: SceneRoot, input: SceneInput): void {
  const { layout, theme, styleOf, nodeData } = input;
  // 任务上下文预计算（M7c-C2）：有效进度（叶=自身、父=Σ 直属子级均值，shared
  // effectiveProgress 口径）、逾期集（isOverdue 口径，today 可由宿主固定）、
  // 父节点集（layout.nodes parentId 反查，与布局侧槽位判定同源同树）。
  const today = input.today ?? todayStr();
  const progressById = taskProgressMap(nodeData, layout.nodes);
  const overdueIds = taskOverdueIds(nodeData, layout.nodes, today);
  const parentIds = taskParentIds(layout.nodes);

  const seenNodes = new Set<string>();
  for (const b of layout.nodes) {
    seenNodes.add(b.id);
    const data = nodeData.get(b.id) ?? { text: '' };
    applyNode(
      scene,
      b,
      styleOf(b.id),
      // 断行行集随盒合并（只增不改）：盒不带 lines 时透传原视觉对象，零额外展开。
      b.lines !== undefined ? { ...data, lines: b.lines } : data,
      theme,
      layout.collapsedCounts.get(b.id) ?? 0,
      {
        progress: progressById.get(b.id) ?? 0,
        parent: parentIds.has(b.id),
        overdue: overdueIds.has(b.id),
      },
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
