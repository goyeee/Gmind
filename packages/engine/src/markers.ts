/**
 * 标记目录与彩色徽标绘制（M7b-W1 企微全量对标）。
 *
 * MARKER_CATALOG 是**渲染层数据单源**（组→值→label/字形种类/主色/chip 文本）：
 * - engine render.ts 按它画 SVG 彩色徽标（圆徽/方块/三角/饼图/箭头/旗帜/心情脸等，
 *   取企微截图同色系；复杂实物形——曲别针/赞/踩/钱袋/打印机——以本色 emoji 字符
 *   近似，近似清单登记于 W1 转录回报）；
 * - web MarkerPanel/TaskTable 消费同一份数据渲染 CSS chip（单一来源防漂移）。
 * 值目录（合法值集合）的单源在 @gmind/core constants.ts（校验口径），本模块的字形
 * 表按组完整覆盖该目录——两组数据以常量并置对齐（drawMarker 对未知值确定性忽略）。
 *
 * 徽标几何：全部在 14×14 槽内绘制（与 M7a PRIORITY_BADGE_SIZE 同尺寸），坐标
 * 确定性输出（两位小数去尾零）。
 */

/** 标记渲染固定组序（M7b-W1 八组制）：心情→优先级→数字→箭头→旗帜→进程→其他→表情。 */
export const MARKER_ROW_ORDER = [
  'mood',
  'priority',
  'number',
  'arrow',
  'flag',
  'progress',
  'other',
  'emoji',
] as const;

export type MarkerBadgeKind =
  | 'circleText' // 彩色圆徽 + 白字（优先级/数字/✓✕/i/?）
  | 'squareText' // 彩色圆角方块 + 白字（日历 31）
  | 'triangle' // 彩色三角 + 白字（注意 !）
  | 'text' // 彩色字符（箭头/+/⚑/★/♥/emoji 本色字符）
  | 'pie' // 绿色饼图（进程 1/8-7/8；done=满圆+白✓）
  | 'pieIcon' // 其他组的饼图（3/4 饼 + 分离象限）
  | 'star' // 五角星
  | 'heart' // 心（heartbroken 加白裂纹）
  | 'flag' // 旗帜（0 波浪 / 1 方旗 / 2 三角旗）
  | 'arrow' // 箭头（0 ← / 1 → / 2 ↑ / 3 ↓ / 4 ↔）
  | 'mood' // 橙底白脸（0 微笑 / 1 难过 / 2 哭 / 3 爱心眼 / 4 飞吻）
  | 'clock' // 蓝底闹钟
  | 'lock' // 锁（0 闭合 / 1 开启）
  | 'person' // 单人
  | 'group' // 三人群组
  | 'screen' // 设备圆角矩形（0 手机绿 / 1 平板黄）
  | 'nut' // 六角螺母
  | 'bulb' // 灯泡
  | 'key' // 钥匙
  | 'pen'; // 钢笔

/** 单个标记值的渲染定义（color=主色；text=badge/chip 文本；fg=文本色缺省白）。 */
export interface MarkerGlyphDef {
  value: string;
  label: string;
  kind: MarkerBadgeKind;
  color: string;
  text?: string;
  /** pie 填充比例 / 同 kind 细分序号（flag/arrow/mood/lock/screen）。 */
  fraction?: number;
  variant?: number;
  /** chip 备用文本（web 侧 CSS chip 用；缺省取 text）。 */
  chipText?: string;
  /** chip 文本色（缺省 #fff；'color'=用主色描字）。 */
  chipFg?: 'white' | 'color';
}

/** 企微截图同色系（W1 转录取色）。 */
const C = {
  red: '#e34d4d',
  orange: '#ef8e3e',
  yellow: '#edc440',
  amber: '#f7c948',
  starOrange: '#f5a623',
  green: '#47a26b',
  blue: '#3d7bff',
  skyBlue: '#54a9f2',
  arrowBlue: '#4a9df8',
  dark: '#3f4550',
  moodOrange: '#ed9334',
} as const;

/** 优先级九档（P0 红 P1 橙 P2 黄 P3 绿 P4 浅蓝 / 急 红 / 高 橙 / 中 绿 / 低 深灰）。 */
const PRIORITY_DEFS: MarkerGlyphDef[] = [
  { value: 'p0', label: '优先级 P0', kind: 'circleText', color: C.red, text: 'P0' },
  { value: 'p1', label: '优先级 P1', kind: 'circleText', color: C.orange, text: 'P1' },
  { value: 'p2', label: '优先级 P2', kind: 'circleText', color: C.yellow, text: 'P2' },
  { value: 'p3', label: '优先级 P3', kind: 'circleText', color: C.green, text: 'P3' },
  { value: 'p4', label: '优先级 P4', kind: 'circleText', color: C.skyBlue, text: 'P4' },
  { value: 'urgent', label: '优先级 急', kind: 'circleText', color: C.red, text: '急' },
  { value: 'high', label: '优先级 高', kind: 'circleText', color: C.orange, text: '高' },
  { value: 'mid', label: '优先级 中', kind: 'circleText', color: C.green, text: '中' },
  { value: 'low', label: '优先级 低', kind: 'circleText', color: C.dark, text: '低' },
];

/** 数字十枚（蓝色圆徽 1-9、0）。 */
const NUMBER_DEFS: MarkerGlyphDef[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].map(
  (d) => ({ value: d, label: `数字 ${d}`, kind: 'circleText' as const, color: C.blue, text: d }),
);

/** 箭头五枚（蓝色字符徽）。 */
const ARROW_DEFS: MarkerGlyphDef[] = [
  { value: 'left', label: '箭头 向左', kind: 'arrow', color: C.arrowBlue, variant: 0, text: '←', chipFg: 'color' },
  { value: 'right', label: '箭头 向右', kind: 'arrow', color: C.arrowBlue, variant: 1, text: '→', chipFg: 'color' },
  { value: 'up', label: '箭头 向上', kind: 'arrow', color: C.arrowBlue, variant: 2, text: '↑', chipFg: 'color' },
  { value: 'down', label: '箭头 向下', kind: 'arrow', color: C.arrowBlue, variant: 3, text: '↓', chipFg: 'color' },
  { value: 'leftright', label: '箭头 左右', kind: 'arrow', color: C.arrowBlue, variant: 4, text: '↔', chipFg: 'color' },
];

/** 进程八档（绿色饼图 1/8→7/8 + 完成）。 */
const PROGRESS_FRACTIONS: Array<[string, number, string]> = [
  ['p12', 0.125, '进程 1/8'],
  ['p25', 0.25, '进程 1/4'],
  ['p37', 0.375, '进程 3/8'],
  ['p50', 0.5, '进程 1/2'],
  ['p62', 0.625, '进程 5/8'],
  ['p75', 0.75, '进程 3/4'],
  ['p87', 0.875, '进程 7/8'],
];
const PROGRESS_DEFS: MarkerGlyphDef[] = [
  ...PROGRESS_FRACTIONS.map(([value, fraction, label]) => ({
    value,
    label,
    kind: 'pie' as const,
    color: C.green,
    fraction,
  })),
  { value: 'done', label: '进程 完成', kind: 'pie', color: C.green, fraction: 1, text: '✓' },
];

/** 其他组 27 枚（复杂实物形以 emoji 字符近似：link/like/unlike/money/printer）。 */
const OTHER_DEFS: MarkerGlyphDef[] = [
  { value: 'done', label: '完成', kind: 'circleText', color: C.green, text: '✓' },
  { value: 'cancel', label: '取消', kind: 'circleText', color: C.red, text: '✕' },
  { value: 'calendar', label: '日期', kind: 'squareText', color: C.blue, text: '31' },
  { value: 'clock', label: '闹钟提醒', kind: 'clock', color: C.blue },
  { value: 'alert', label: '注意', kind: 'triangle', color: C.yellow, text: '!' },
  { value: 'info', label: '信息', kind: 'circleText', color: C.skyBlue, text: 'i' },
  { value: 'question', label: '疑问', kind: 'circleText', color: C.orange, text: '?' },
  { value: 'important', label: '重要', kind: 'star', color: C.starOrange, text: '★', chipFg: 'color' },
  { value: 'idea', label: '想法', kind: 'bulb', color: C.amber },
  { value: 'pie', label: '统计', kind: 'pieIcon', color: C.green },
  { value: 'group', label: '群组', kind: 'group', color: C.blue },
  { value: 'lock', label: '私密', kind: 'lock', color: C.skyBlue, variant: 0 },
  { value: 'unlock', label: '公开', kind: 'lock', color: C.skyBlue, variant: 1 },
  { value: 'plus', label: '新增', kind: 'text', color: C.blue, text: '+', chipFg: 'color' },
  { value: 'link', label: '附件关联', kind: 'text', color: C.blue, text: '📎' },
  { value: 'nut', label: '设置', kind: 'nut', color: C.skyBlue },
  { value: 'person', label: '人员', kind: 'person', color: C.blue },
  { value: 'phone', label: '手机', kind: 'screen', color: C.green, variant: 0 },
  { value: 'tablet', label: '平板', kind: 'screen', color: C.amber, variant: 1 },
  { value: 'like', label: '点赞', kind: 'text', color: C.orange, text: '👍' },
  { value: 'unlike', label: '点踩', kind: 'text', color: C.blue, text: '👎' },
  { value: 'key', label: '钥匙', kind: 'key', color: C.green },
  { value: 'heart', label: '喜欢', kind: 'heart', color: C.red, text: '♥', chipFg: 'color' },
  { value: 'heartbroken', label: '心碎', kind: 'heart', color: C.red, variant: 1, text: '💔' },
  { value: 'money', label: '费用', kind: 'text', color: C.orange, text: '💰' },
  { value: 'pen', label: '记录', kind: 'pen', color: C.blue },
  { value: 'printer', label: '打印', kind: 'text', color: C.amber, text: '🖨️' },
];

/** 心情五枚（橙底白脸）。 */
const MOOD_DEFS: MarkerGlyphDef[] = [
  { value: 'smile', label: '心情 微笑', kind: 'mood', color: C.moodOrange, variant: 0 },
  { value: 'sad', label: '心情 难过', kind: 'mood', color: C.moodOrange, variant: 1 },
  { value: 'cry', label: '心情 哭', kind: 'mood', color: C.moodOrange, variant: 2 },
  { value: 'love', label: '心情 爱心眼', kind: 'mood', color: C.moodOrange, variant: 3 },
  { value: 'kiss', label: '心情 飞吻', kind: 'mood', color: C.moodOrange, variant: 4 },
];

/** 旗帜三枚（红：波浪旗/方旗/三角旗）。 */
const FLAG_DEFS: MarkerGlyphDef[] = [
  { value: 'flag', label: '旗帜', kind: 'flag', color: C.red, variant: 0, text: '⚑', chipFg: 'color' },
  { value: 'flagRect', label: '旗帜 方旗', kind: 'flag', color: C.red, variant: 1, text: '⚑', chipFg: 'color' },
  { value: 'flagPennant', label: '旗帜 三角旗', kind: 'flag', color: C.red, variant: 2, text: '⚐', chipFg: 'color' },
];

/**
 * 渲染目录（组→值定义表）：chip 文本缺省取 text；emoji 组值本身即字形
 * （chipText=value）。组顺序 = MARKER_ROW_ORDER。
 */
export const MARKER_CATALOG: Record<(typeof MARKER_ROW_ORDER)[number], MarkerGlyphDef[]> = {
  mood: MOOD_DEFS,
  priority: PRIORITY_DEFS,
  number: NUMBER_DEFS,
  arrow: ARROW_DEFS,
  flag: FLAG_DEFS,
  progress: PROGRESS_DEFS,
  other: OTHER_DEFS,
  emoji: [
    '😊',
    '😌',
    '😙',
    '😓',
    '😰',
    '😝',
    '😄',
    '😜',
    '😀',
    '😍',
    '😔',
    '😁',
    '😏',
    '😑',
    '😳',
    '😘',
    '😭',
    '😱',
    '🤣',
    '💪',
    '👊',
    '👍',
    '👏',
    '👎',
    '🙏',
    '👌',
    '☝️',
    '👀',
  ].map((ch) => ({
    value: ch,
    label: `表情 ${ch}`,
    kind: 'text' as const,
    color: '#ffffff',
    text: ch,
    chipFg: 'color' as const,
  })),
};

/** 组中文名（面板/表格 title 用）。 */
export const MARKER_GROUP_LABELS: Record<(typeof MARKER_ROW_ORDER)[number], string> = {
  mood: '心情',
  priority: '优先级',
  number: '数字',
  arrow: '箭头',
  flag: '旗帜',
  progress: '进程',
  other: '其他',
  emoji: '表情',
};

/** 组内取值定义（未知值返回 null——未收敛窗口期确定性忽略）。 */
export function markerDefOf(group: string, value: string): MarkerGlyphDef | null {
  const defs = (MARKER_CATALOG as Record<string, MarkerGlyphDef[]>)[group];
  if (!defs) return null;
  return defs.find((d) => d.value === value) ?? null;
}

/** 组值 chip 文本（MarkerPanel/TaskTable 单源；未知值返回 null）。 */
export function markerChipText(group: string, value: string): { text: string; color: string; fg: 'white' | 'color'; kind: MarkerBadgeKind; fraction?: number } | null {
  const def = markerDefOf(group, value);
  if (!def) return null;
  return {
    text: def.chipText ?? def.text ?? '',
    color: def.color,
    fg: def.chipFg ?? 'white',
    kind: def.kind,
    fraction: def.fraction,
  };
}

// ─────────────────────────── SVG 徽标绘制 ───────────────────────────

const SVG_NS = 'http://www.w3.org/2000/svg';
/** 徽标槽尺寸（与 layout 的 iconSlotWidth 槽位配合；M7a 方块同尺寸 14×14）。 */
export const MARKER_BADGE_SIZE = 14;

/** 数值 → 属性串：两位小数去尾零（与 render.ts fmt 同口径，输出确定）。 */
function f(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) node.setAttribute(key, String(attrs[key]));
  return node;
}

/** 饼图扇形路径（12 点方向起、顺时针 frac 圈）。 */
function pieWedgePath(cx: number, cy: number, r: number, frac: number): string {
  const a0 = -Math.PI / 2;
  const a1 = a0 + frac * 2 * Math.PI;
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const large = frac > 0.5 ? 1 : 0;
  return `M ${f(cx)} ${f(cy)} L ${f(x0)} ${f(y0)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)} Z`;
}

/** 五角星路径（外接圆中心 7,7.4；确定性三角计算）。 */
const STAR_PATH = (() => {
  const cx = 7;
  const cy = 7.4;
  const outer = 6.6;
  const inner = 2.75;
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`);
  }
  return `M ${pts.join(' L ')} Z`;
})();

/** 心形路径（中心 7,7）。 */
const HEART_PATH =
  'M 7 12.4 C 2.4 9.2 0.9 6.5 0.9 4.7 C 0.9 2.5 2.6 1.1 4.4 1.1 C 5.6 1.1 6.6 1.8 7 2.7 ' +
  'C 7.4 1.8 8.4 1.1 9.6 1.1 C 11.4 1.1 13.1 2.5 13.1 4.7 C 13.1 6.5 11.6 9.2 7 12.4 Z';

/** 箭头多边形（0 ← 1 → 2 ↑ 3 ↓ 4 ↔）。 */
const ARROW_PATHS = [
  'M 13 5.4 L 13 8.6 L 4.6 8.6 L 4.6 11.6 L 1 7 L 4.6 2.4 L 4.6 5.4 Z',
  'M 1 5.4 L 1 8.6 L 9.4 8.6 L 9.4 11.6 L 13 7 L 9.4 2.4 L 9.4 5.4 Z',
  'M 5.4 13 L 8.6 13 L 8.6 4.6 L 11.6 4.6 L 7 1 L 2.4 4.6 L 5.4 4.6 Z',
  'M 5.4 1 L 8.6 1 L 8.6 9.4 L 11.6 9.4 L 7 13 L 2.4 9.4 L 5.4 9.4 Z',
  'M 4.6 5.4 L 4.6 2.4 L 1 7 L 4.6 11.6 L 4.6 8.6 L 9.4 8.6 L 9.4 11.6 L 13 7 L 9.4 2.4 L 9.4 5.4 Z',
];

/** 旗帜三形（0 波浪 / 1 方旗 / 2 三角旗；旗杆共用）。 */
const FLAG_PATHS = [
  'M 3.4 2.2 C 5 1.2 6.2 3 8 2.2 C 9.2 1.7 10.4 1.9 11.2 2.4 L 11.2 7.4 C 10.4 6.9 9.2 6.7 8 7.2 C 6.2 8 5 6.2 3.4 7.2 Z',
  'M 3.4 2 L 11.4 2 L 11.4 7.4 L 3.4 7.4 Z',
  'M 3.4 1.8 L 11.8 4.8 L 3.4 7.8 Z',
];

/** 六角螺母外形（平顶朝上）。 */
const NUT_PATH = 'M 7 0.6 L 12.5 3.8 L 12.5 10.2 L 7 13.4 L 1.5 10.2 L 1.5 3.8 Z';

/**
 * 单枚徽标绘制：在 14×14 局部坐标内构建 <g class="gm-marker-badge">（未知值返回
 * null——未收敛窗口期确定性忽略）。所有形状取企微截图同色系；复杂实物形
 * （link/like/unlike/money/printer/heartbroken/heart）以字符或简化形近似并在
 * W1 转录回报登记。
 */
export function drawMarkerBadge(def: MarkerGlyphDef): SVGGElement | null {
  const g = el('g', { class: 'gm-marker-badge' }) as SVGGElement;
  const text = (content: string, attrs: Record<string, string | number>): void => {
    const t = el('text', { 'text-anchor': 'middle', ...attrs });
    t.textContent = content;
    g.appendChild(t);
  };
  switch (def.kind) {
    case 'circleText': {
      g.appendChild(el('circle', { cx: 7, cy: 7, r: 7, fill: def.color }));
      const fs = (def.text?.length ?? 1) > 1 ? 6.4 : 8.6;
      text(def.text ?? '', { x: 7, y: 7 + fs * 0.36, 'font-size': fs, 'font-weight': 600, fill: '#ffffff' });
      break;
    }
    case 'squareText': {
      g.appendChild(el('rect', { x: 0.9, y: 1.9, width: 12.2, height: 10.4, rx: 2.4, fill: def.color }));
      text(def.text ?? '', { x: 7, y: 9.6, 'font-size': 6.4, 'font-weight': 700, fill: '#ffffff' });
      break;
    }
    case 'triangle': {
      g.appendChild(el('path', { d: 'M 7 1.2 L 13.4 12.4 L 0.6 12.4 Z', fill: def.color }));
      text(def.text ?? '', { x: 7, y: 10.8, 'font-size': 7.6, 'font-weight': 700, fill: '#ffffff' });
      break;
    }
    case 'text': {
      text(def.text ?? '', { x: 7, y: 11.1, 'font-size': 12, fill: def.color });
      break;
    }
    case 'pie': {
      const frac = def.fraction ?? 1;
      if (frac >= 1) {
        g.appendChild(el('circle', { cx: 7, cy: 7, r: 6.6, fill: def.color }));
        text(def.text ?? '✓', { x: 7, y: 10.1, 'font-size': 7.6, 'font-weight': 700, fill: '#ffffff' });
      } else {
        g.appendChild(el('circle', { cx: 7, cy: 7, r: 6.1, fill: 'none', stroke: def.color, 'stroke-width': 1.1 }));
        g.appendChild(el('path', { d: pieWedgePath(7, 7, 6.1, frac), fill: def.color }));
      }
      break;
    }
    case 'pieIcon': {
      g.appendChild(el('path', { d: pieWedgePath(6.4, 7.6, 6, 0.75), fill: def.color }));
      g.appendChild(el('path', { d: pieWedgePath(7.8, 5.6, 3.4, 0.25), fill: def.color }));
      break;
    }
    case 'star': {
      g.appendChild(el('path', { d: STAR_PATH, fill: def.color }));
      break;
    }
    case 'heart': {
      g.appendChild(el('path', { d: HEART_PATH, fill: def.color }));
      if (def.variant === 1) {
        g.appendChild(
          el('path', { d: 'M 7 2.9 L 6 5 L 8 7 L 6.6 9.4', fill: 'none', stroke: '#ffffff', 'stroke-width': 1.1 }),
        );
      }
      break;
    }
    case 'flag': {
      g.appendChild(el('path', { d: 'M 3.4 1.4 L 3.4 13', stroke: def.color, 'stroke-width': 1.4 }));
      g.appendChild(el('path', { d: FLAG_PATHS[def.variant ?? 0] as string, fill: def.color }));
      break;
    }
    case 'arrow': {
      g.appendChild(el('path', { d: ARROW_PATHS[def.variant ?? 1] as string, fill: def.color }));
      break;
    }
    case 'mood': {
      g.appendChild(el('circle', { cx: 7, cy: 7, r: 7, fill: def.color }));
      const v = def.variant ?? 0;
      const stroke = { stroke: '#ffffff', 'stroke-width': 1.1, 'stroke-linecap': 'round', fill: 'none' };
      if (v === 0 || v === 3) {
        if (v === 0) {
          g.appendChild(el('circle', { cx: 4.7, cy: 5.4, r: 0.95, fill: '#ffffff' }));
          g.appendChild(el('circle', { cx: 9.3, cy: 5.4, r: 0.95, fill: '#ffffff' }));
        } else {
          g.appendChild(el('path', { d: 'M 3.9 5.1 C 3.9 4.3 4.9 4.2 5.1 4.9 C 5.3 4.2 6.3 4.3 6.3 5.1 C 6.3 5.8 5.1 6.6 5.1 6.6 C 5.1 6.6 3.9 5.8 3.9 5.1 Z', fill: '#ffffff' }));
          g.appendChild(el('path', { d: 'M 7.9 5.1 C 7.9 4.3 8.9 4.2 9.1 4.9 C 9.3 4.2 10.3 4.3 10.3 5.1 C 10.3 5.8 9.1 6.6 9.1 6.6 C 9.1 6.6 7.9 5.8 7.9 5.1 Z', fill: '#ffffff' }));
        }
        g.appendChild(el('path', { d: 'M 4.4 8.4 Q 7 10.9 9.6 8.4', ...stroke }));
      } else if (v === 1) {
        g.appendChild(el('circle', { cx: 4.7, cy: 5.6, r: 0.95, fill: '#ffffff' }));
        g.appendChild(el('circle', { cx: 9.3, cy: 5.6, r: 0.95, fill: '#ffffff' }));
        g.appendChild(el('path', { d: 'M 4.6 10.4 Q 7 8.2 9.4 10.4', ...stroke }));
      } else if (v === 2) {
        g.appendChild(el('path', { d: 'M 4.5 3.9 L 4.5 6.1', ...stroke }));
        g.appendChild(el('path', { d: 'M 9.5 3.9 L 9.5 6.1', ...stroke }));
        g.appendChild(el('path', { d: 'M 5.8 10.2 L 8.2 10.2', ...stroke }));
      } else {
        g.appendChild(el('path', { d: 'M 3.7 5.2 L 5.5 5.8 L 3.7 6.4', ...stroke }));
        g.appendChild(el('path', { d: 'M 7.9 5.2 L 9.7 5.8 L 7.9 6.4', ...stroke }));
        g.appendChild(el('circle', { cx: 6.4, cy: 9.3, r: 0.9, fill: '#ffffff' }));
        g.appendChild(el('path', { d: 'M 9.7 8.6 C 9.7 8 10.4 7.9 10.5 8.4 C 10.6 7.9 11.3 8 11.3 8.6 C 11.3 9.1 10.5 9.6 10.5 9.6 C 10.5 9.6 9.7 9.1 9.7 8.6 Z', fill: '#ffffff' }));
      }
      break;
    }
    case 'clock': {
      g.appendChild(el('circle', { cx: 7, cy: 7, r: 6.6, fill: def.color }));
      g.appendChild(el('circle', { cx: 7, cy: 7.4, r: 4.4, fill: '#ffffff' }));
      g.appendChild(el('path', { d: 'M 7 4.9 L 7 7.4 L 9 8.4', fill: 'none', stroke: def.color, 'stroke-width': 1.2, 'stroke-linecap': 'round' }));
      g.appendChild(el('circle', { cx: 2.2, cy: 3, r: 1.1, fill: def.color }));
      g.appendChild(el('circle', { cx: 11.8, cy: 3, r: 1.1, fill: def.color }));
      break;
    }
    case 'lock': {
      const open = (def.variant ?? 0) === 1;
      g.appendChild(el('rect', { x: 2.6, y: 6.2, width: 8.8, height: 6.4, rx: 1.4, fill: def.color }));
      g.appendChild(
        el('path', {
          d: open ? 'M 9.4 6 L 9.4 4 A 2.4 2.4 0 0 0 4.8 3.6' : 'M 4.6 6 L 4.6 4.2 A 2.4 2.4 0 0 1 9.4 4.2 L 9.4 6',
          fill: 'none',
          stroke: def.color,
          'stroke-width': 1.5,
        }),
      );
      g.appendChild(el('circle', { cx: 7, cy: 9.4, r: 1, fill: '#ffffff' }));
      break;
    }
    case 'person': {
      g.appendChild(el('circle', { cx: 7, cy: 4.6, r: 2.6, fill: def.color }));
      g.appendChild(el('path', { d: 'M 2.6 12.6 C 2.6 9.4 4.5 8 7 8 C 9.5 8 11.4 9.4 11.4 12.6 Z', fill: def.color }));
      break;
    }
    case 'group': {
      g.appendChild(el('circle', { cx: 3.9, cy: 4.9, r: 1.8, fill: def.color }));
      g.appendChild(el('circle', { cx: 10.1, cy: 4.9, r: 1.8, fill: def.color }));
      g.appendChild(el('circle', { cx: 7, cy: 5.6, r: 2.2, fill: def.color }));
      g.appendChild(el('path', { d: 'M 1.8 12.4 C 1.8 9.8 3.6 8.6 5.6 8.6 L 8.4 8.6 C 10.4 8.6 12.2 9.8 12.2 12.4 Z', fill: def.color }));
      break;
    }
    case 'screen': {
      g.appendChild(
        el('rect', { x: 3.4, y: 1.2, width: 7.2, height: 11.6, rx: 1.6, fill: 'none', stroke: def.color, 'stroke-width': 1.5 }),
      );
      g.appendChild(el('circle', { cx: 7, cy: 10.9, r: 0.75, fill: def.color }));
      break;
    }
    case 'nut': {
      g.appendChild(el('path', { d: NUT_PATH, fill: def.color }));
      g.appendChild(el('circle', { cx: 7, cy: 7, r: 2.3, fill: '#ffffff' }));
      break;
    }
    case 'bulb': {
      g.appendChild(el('circle', { cx: 7, cy: 5.9, r: 4.3, fill: def.color }));
      g.appendChild(el('rect', { x: 5.2, y: 10.4, width: 3.6, height: 2.4, rx: 0.9, fill: def.color }));
      break;
    }
    case 'key': {
      g.appendChild(el('circle', { cx: 4.7, cy: 4.7, r: 2.6, fill: 'none', stroke: def.color, 'stroke-width': 1.7 }));
      g.appendChild(el('path', { d: 'M 6.5 6.5 L 11.8 11.8', stroke: def.color, 'stroke-width': 1.7, 'stroke-linecap': 'round' }));
      g.appendChild(el('path', { d: 'M 9.6 9.6 L 11.2 8', stroke: def.color, 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
      g.appendChild(el('path', { d: 'M 11.3 11.3 L 12.7 9.9', stroke: def.color, 'stroke-width': 1.5, 'stroke-linecap': 'round' }));
      break;
    }
    case 'pen': {
      g.appendChild(el('path', { d: 'M 10.9 2.1 L 11.9 3.1 L 5.2 9.8 L 3.4 10.6 L 4.2 8.8 Z', fill: def.color }));
      g.appendChild(el('path', { d: 'M 3.4 10.6 L 2.2 11.8', stroke: def.color, 'stroke-width': 1.2, 'stroke-linecap': 'round' }));
      break;
    }
    default:
      return null;
  }
  return g;
}

/** 标记行徽标总数（布局槽位口径：各组值数组的元素数求和；防御非数组形状）。 */
export function markerCountOf(icons: Record<string, unknown> | undefined): number {
  if (!icons) return 0;
  let n = 0;
  for (const group of MARKER_ROW_ORDER) {
    const values = icons[group];
    if (Array.isArray(values)) n += values.length;
    else if (typeof values === 'string' && values !== '') n += 1;
  }
  return n;
}

/** 标记行签名（协调差分用：组序 + 逐值拼接；不变则徽标元素引用保持）。 */
export function markerSignatureOf(icons: Record<string, unknown> | undefined): string {
  if (!icons) return '';
  const parts: string[] = [];
  for (const group of MARKER_ROW_ORDER) {
    const values = icons[group];
    if (Array.isArray(values)) for (const v of values) parts.push(`${group}:${String(v)}`);
    else if (typeof values === 'string' && values !== '') parts.push(`${group}:${values}`);
  }
  return parts.join('|');
}
