/**
 * 三套预置主题 + 九套扩容主题 — M6 Task 4（企微对标）。
 *
 * M1b 原始裁决（保留）：
 * - THEMES 原三套：'gmind-blue'（默认经典蓝 #3370ff）、'gmind-warm'（暖橙 #ff8800 系）、
 *   'gmind-accessible'（WCAG AA 正文对比度 ≥4.5:1；色盲友好：蓝 #1a5fb4 / 橙 #e66100
 *   双色系，避开红绿对比）。
 * - core meta `themeId` 的历史默认 'gmind-light' 不改库：resolveThemeId 解析时视作
 *   'gmind-blue' 别名；其余未知值一律兜底 'gmind-blue'。
 *
 * M6 Task 4 扩容裁决：新增九套（每套三级 text-vs-fill 对比度 ≥4.5:1，a11y 用例守卫
 * 全 12 套跑 contrastRatio）：deep-blue 深蓝商务 / forest 森绿 / sakura 樱粉 /
 * graphite 石墨（三级浅色文字但非暗色模式）/ violet 紫罗兰 / amber 琥珀 /
 * celadon 青瓷 / ink-wash 水墨 / peach 蜜桃。布局度量与字体栈沿用共享常量
 * （跨主题布局一致），主题只分化颜色/圆角/线宽。
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
// 预置主题（M1b 三套 + M6 Task 4 扩容九套）
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

// ---------------------------------------------------------------------------
// M6 Task 4 扩容九套（企微对标）
// ---------------------------------------------------------------------------

/**
 * 深蓝商务：深海军蓝根 #1f3a5f 白字，一级浅蓝灰底、二级白底，冷峻正式。
 */
const DEEP_BLUE: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#1f3a5f',
  rootBorderColor: '#152a47',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#d8e4f2',
  level1BorderColor: '#5a7ea6',
  level1TextColor: '#1a2733',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#b9c8dc',
  level2TextColor: '#33404f',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#eef2f7',
  edgeColor: '#5a7ea6',
  edgeWidth: 2,
  nodeBorderRadius: 6,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#1f3a5f',
  collapseBadgeFg: '#ffffff',
};

/**
 * 森绿：森林绿根 #2d6a4f 白字，一级淡绿底深绿字、二级白底，自然沉稳。
 */
const FOREST: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#2d6a4f',
  rootBorderColor: '#1f4a37',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#d7eadd',
  level1BorderColor: '#6b9b7f',
  level1TextColor: '#1b3a2a',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#bcd8c6',
  level2TextColor: '#2f4638',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f2f7f3',
  edgeColor: '#6b9b7f',
  edgeWidth: 2,
  nodeBorderRadius: 8,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#2d6a4f',
  collapseBadgeFg: '#ffffff',
};

/**
 * 樱粉：玫瑰粉根 #b83b5e 白字（≥4.5:1），一级淡粉底酒红字、二级白底，柔和明快。
 */
const SAKURA: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#b83b5e',
  rootBorderColor: '#932a49',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#fde4ec',
  level1BorderColor: '#e08aa5',
  level1TextColor: '#5c1a31',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#eec3d1',
  level2TextColor: '#4a3540',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#fdf4f7',
  edgeColor: '#e08aa5',
  edgeWidth: 2,
  nodeBorderRadius: 12,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#b83b5e',
  collapseBadgeFg: '#ffffff',
};

/**
 * 石墨：石墨灰根 #3d434c 白字、一级中灰底 #67707c 白字（浅色文字但非暗色模式：
 * 画布仍浅色 #f4f5f7，仅节点盒走灰阶）、二级白底深灰字。
 */
const GRAPHITE: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#3d434c',
  rootBorderColor: '#2a2f36',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#67707c',
  level1BorderColor: '#4d545e',
  level1TextColor: '#ffffff',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#c3c8cf',
  level2TextColor: '#3b4048',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f4f5f7',
  edgeColor: '#9aa1ab',
  edgeWidth: 2,
  nodeBorderRadius: 4,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#3d434c',
  collapseBadgeFg: '#ffffff',
};

/**
 * 紫罗兰：深紫根 #5e3a99 白字，一级淡紫底深紫字、二级白底，优雅内敛。
 */
const VIOLET: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#5e3a99',
  rootBorderColor: '#472b75',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#e8e1f4',
  level1BorderColor: '#9a86c9',
  level1TextColor: '#322153',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#cfc4e6',
  level2TextColor: '#443a5c',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f6f3fa',
  edgeColor: '#9a86c9',
  edgeWidth: 2,
  nodeBorderRadius: 10,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#5e3a99',
  collapseBadgeFg: '#ffffff',
};

/**
 * 琥珀：深琥珀根 #8a4b00 白字（亮黄底白字不达 AA，故取深琥珀）、一级米黄底
 * 深棕字、二级白底。
 */
const AMBER: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#8a4b00',
  rootBorderColor: '#6d3b00',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#ffe9c7',
  level1BorderColor: '#d9a441',
  level1TextColor: '#4a2e00',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#ecd9ae',
  level2TextColor: '#4d4335',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#fdf8ee',
  edgeColor: '#d9a441',
  edgeWidth: 2,
  nodeBorderRadius: 10,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#8a4b00',
  collapseBadgeFg: '#ffffff',
};

/**
 * 青瓷：青瓷绿根 #3d6b6d 白字，一级淡青底深青字、二级白底，温润素雅。
 */
const CELADON: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#3d6b6d',
  rootBorderColor: '#2c5052',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#dcebe9',
  level1BorderColor: '#7fabab',
  level1TextColor: '#1f3b3c',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#c2d9d8',
  level2TextColor: '#35494a',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f1f6f5',
  edgeColor: '#7fabab',
  edgeWidth: 2,
  nodeBorderRadius: 14,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#3d6b6d',
  collapseBadgeFg: '#ffffff',
};

/**
 * 水墨：墨黑根 #2f2f2c 米白字（宣纸感）、一级宣纸灰底墨字、二级白底，东方素净。
 */
const INK_WASH: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#2f2f2c',
  rootBorderColor: '#1d1d1b',
  rootTextColor: '#f5f4f0',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#e6e5df',
  level1BorderColor: '#83837c',
  level1TextColor: '#33322d',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#c9c8c1',
  level2TextColor: '#3a3936',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#f7f6f2',
  edgeColor: '#83837c',
  edgeWidth: 2,
  nodeBorderRadius: 2,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#2f2f2c',
  collapseBadgeFg: '#f5f4f0',
};

/**
 * 蜜桃：蜜桃红根 #b14859 白字（≥4.5:1）、一级淡桃底深桃字、二级白底，甜暖亲和。
 */
const PEACH: ThemeTokens = {
  ...SHARED_METRICS,
  rootFill: '#b14859',
  rootBorderColor: '#8e3745',
  rootTextColor: '#ffffff',
  rootFontSize: 20,
  rootFontWeight: 600,
  rootFontFamily: SYSTEM_FONT_STACK,
  level1Fill: '#fce7e4',
  level1BorderColor: '#dfa096',
  level1TextColor: '#5c2b2e',
  level1FontSize: 16,
  level1FontWeight: 500,
  level1FontFamily: SYSTEM_FONT_STACK,
  level2Fill: '#ffffff',
  level2BorderColor: '#eccfc7',
  level2TextColor: '#5a4245',
  level2FontSize: 14,
  level2FontWeight: 400,
  level2FontFamily: SYSTEM_FONT_STACK,
  canvasBackground: '#fdf5f2',
  edgeColor: '#dfa096',
  edgeWidth: 2,
  nodeBorderRadius: 12,
  nodeBorderWidth: 1,
  collapseBadgeBg: '#b14859',
  collapseBadgeFg: '#ffffff',
};

/** 十二套预置主题（键域即 ThemeId；M1b 三套 + M6 Task 4 九套）。 */
export const THEMES: Record<ThemeId, ThemeTokens> = {
  'gmind-blue': GMIND_BLUE,
  'gmind-warm': GMIND_WARM,
  'gmind-accessible': GMIND_ACCESSIBLE,
  'deep-blue': DEEP_BLUE,
  forest: FOREST,
  sakura: SAKURA,
  graphite: GRAPHITE,
  violet: VIOLET,
  amber: AMBER,
  celadon: CELADON,
  'ink-wash': INK_WASH,
  peach: PEACH,
};

// ---------------------------------------------------------------------------
// 主题标识解析与节点样式解析
// ---------------------------------------------------------------------------

/**
 * meta.themeId（任意历史字符串）→ 合法 ThemeId：
 * 'gmind-light'（M0 迁移历史默认）视作 'gmind-blue' 别名；未知值兜底 'gmind-blue'。
 * 合法值域 = THEMES 键（M1b 三套 + M6 扩容九套，共十二套）。
 */
const THEME_ID_SET: ReadonlySet<string> = new Set(Object.keys(THEMES));

export function resolveThemeId(id: string): ThemeId {
  return THEME_ID_SET.has(id) ? (id as ThemeId) : 'gmind-blue';
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
