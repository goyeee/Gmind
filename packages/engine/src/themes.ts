/**
 * 主题系统：三套预置主题 + 节点样式解析 — M1b Task 5（FR-EDT-014）。
 *
 * 绑定裁决（M1b 计划）：
 * - THEMES 恰三套：'gmind-blue'（默认经典蓝 #3370ff）、'gmind-warm'（暖橙 #ff8800 系）、
 *   'gmind-accessible'（WCAG AA 正文对比度 ≥4.5:1；色盲友好：蓝 #1a5fb4 / 橙 #e66100
 *   双色系，避开红绿对比）。
 * - core meta `themeId` 的历史默认 'gmind-light' 不改库：resolveThemeId 解析时视作
 *   'gmind-blue' 别名；其余未知值一律兜底 'gmind-blue'。
 * - resolveNodeStyle：depth 0=root / 1=level1 / ≥2=level2 级联取主题默认，再按
 *   nodeStyle 的 fill/border/color(→textColor)/fontSize/fontFamily 逐 key 覆盖；
 *   fontSize 经 Number() 归一，NaN（或空串/非正数）回退主题值。颜色值的合法性
 *   不在此校验——非法颜色由渲染层回退主题值（与 core setStyle 不校验一致）。
 * - contrastRatio：WCAG 2.x 相对亮度对比度公式纯函数，供测试与未来校验复用。
 */
import type { ResolvedNodeStyle, ThemeId, ThemeTokens, TextStyle } from './types';

// ---------------------------------------------------------------------------
// WCAG 对比度（纯函数）
// ---------------------------------------------------------------------------

/** '#rgb' / '#rrggbb'（'#' 可省）→ [r,g,b] 0-255；非法值抛错。 */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`contrastRatio: 非法颜色值 ${JSON.stringify(hex)}`);
  const n = parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** WCAG 2.x 相对亮度。 */
function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度（(L亮+0.05)/(L暗+0.05)），黑对白恰为 21。 */
export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ---------------------------------------------------------------------------
// 三套预置主题
// ---------------------------------------------------------------------------

/** 三主题共享的布局度量（与 T4 金样桩同值：布局行为跨主题一致，主题只分化颜色/字体）。 */
const SHARED_METRICS = {
  nodePaddingX: 12,
  iconSlotWidth: 20,
  lineHeightRatio: 1.4,
  maxTextWidth: 240,
  minNodeWidth: 40,
  V_GAP: 14,
  H_GAP: 40,
} as const;

/** 系统字体栈（跨平台中文回退；三主题共用，主题分化在颜色/字号/字重）。 */
const SYSTEM_FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif";

/**
 * 默认经典蓝：主色 #3370ff，浅蓝画布，根实心蓝、一级淡蓝底、二级白底细边。
 */
const GMIND_BLUE: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#3370ff',
  rootBorderColor: '#2b5fd9',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#e6efff',
  level1BorderColor: '#6690f5',
  level1TextColor: '#1f2a44',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#c4d3ec',
  level2TextColor: '#3d4757',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f5f7fa',
  edgeColor: '#8fb3f2',
  edgeWidth: 2,
  nodeBorderRadius: 8,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#3370ff',
  collapseBadgeFg: '#ffffff',
};

/**
 * 暖橙：主色 #ff8800 系，暖白画布，一级淡橙底深棕字、二级白底。
 */
const GMIND_WARM: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#ff8800',
  rootBorderColor: '#e67a00',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#ffefd9',
  level1BorderColor: '#ffa940',
  level1TextColor: '#5a3a10',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#e8cfa8',
  level2TextColor: '#4a4034',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#faf6f0',
  edgeColor: '#f0b26b',
  edgeWidth: 2,
  nodeBorderRadius: 10,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#ff8800',
  collapseBadgeFg: '#ffffff',
};

/**
 * 无障碍：WCAG AA 正文对比度 ≥4.5:1（白/蓝 6.29、黑/橙 6.07、黑/白 21），
 * 色盲友好——蓝 #1a5fb4 / 橙 #e66100 双色系，避开红绿对比；黑字白底高对比。
 */
const GMIND_ACCESSIBLE: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#1a5fb4',
  rootBorderColor: '#0f3d75',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#e66100',
  level1BorderColor: '#8f4a00',
  level1TextColor: '#000000',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#3d3846',
  level2TextColor: '#000000',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#ffffff',
  edgeColor: '#1a5fb4',
  edgeWidth: 2,
  nodeBorderRadius: 6,
  nodeBorderWidth: 1.5,
  collapseBadgeBg: '#1a5fb4',
  collapseBadgeFg: '#ffffff',
};

/** 三套预置主题（键域即 ThemeId）。 */
export const THEMES: Record<ThemeId, ThemeTokens> = {
  'gmind-blue': GMIND_BLUE,
  'gmind-warm': GMIND_WARM,
  'gmind-accessible': GMIND_ACCESSIBLE,
};

// ---------------------------------------------------------------------------
// 主题标识解析与节点样式解析
// ---------------------------------------------------------------------------

/**
 * meta.themeId（任意历史字符串）→ 合法 ThemeId：
 * 'gmind-light'（M0 迁移历史默认）视作 'gmind-blue' 别名；未知值兜底 'gmind-blue'。
 */
export function resolveThemeId(id: string): ThemeId {
  if (id === 'gmind-blue' || id === 'gmind-warm' || id === 'gmind-accessible') return id;
  return 'gmind-blue';
}

/** depth → 分级 token 视图：0=root、1=level1、≥2=level2。 */
function tierOf(theme: ThemeTokens, depth: number): {
  fill: string;
  border: string;
  textColor: string;
  fontSize: number;
  fontWeight: number;
  fontFamily: string;
} {
  if (depth <= 0) {
    return {
      fill: theme.rootFill,
      border: theme.rootBorderColor,
      textColor: theme.rootTextColor,
      fontSize: theme.rootFontSize,
      fontWeight: theme.rootFontWeight,
      fontFamily: theme.rootFontFamily,
    };
  }
  if (depth === 1) {
    return {
      fill: theme.level1Fill,
      border: theme.level1BorderColor,
      textColor: theme.level1TextColor,
      fontSize: theme.level1FontSize,
      fontWeight: theme.level1FontWeight,
      fontFamily: theme.level1FontFamily,
    };
  }
  return {
    fill: theme.level2Fill,
    border: theme.level2BorderColor,
    textColor: theme.level2TextColor,
    fontSize: theme.level2FontSize,
    fontWeight: theme.level2FontWeight,
    fontFamily: theme.level2FontFamily,
  };
}

/**
 * 按深度取主题派生 TextStyle（layout 缺省 styleOf 的底座；
 * fontSize/fontWeight/fontFamily 全部来自主题 token）。
 */
export function themeTextStyleOf(theme: ThemeTokens, depth: number): TextStyle {
  const tier = tierOf(theme, depth);
  return { fontSize: tier.fontSize, fontWeight: tier.fontWeight, fontFamily: tier.fontFamily };
}

/**
 * fontSize 覆盖归一：Number() 归一，NaN / 空串 / 非正数 → null（回退主题值）。
 */
function normalizeFontSize(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 节点最终样式：主题分级派生（depth 0=root / 1=level1 / ≥2=level2）+ 节点级覆盖。
 * 覆盖 key：fill / border / color(→textColor) / fontSize / fontFamily；
 * fontSize 非法（NaN、空串、非正数）回退主题值；颜色不做合法性校验（渲染层兜底）。
 */
export function resolveNodeStyle(
  theme: ThemeTokens,
  depth: number,
  nodeStyle: Record<string, string>,
): ResolvedNodeStyle {
  const overrides = nodeStyle ?? {};
  const tier = tierOf(theme, depth);
  const fontSize = normalizeFontSize(overrides.fontSize) ?? tier.fontSize;
  const fontFamily = overrides.fontFamily ?? tier.fontFamily;
  return {
    fill: overrides.fill ?? tier.fill,
    border: overrides.border ?? tier.border,
    textColor: overrides.color ?? tier.textColor,
    textStyle: { fontSize, fontWeight: tier.fontWeight, fontFamily },
    fontSize,
    fontFamily,
  };
}
