import type { MeasureAdapter, TextStyle, ThemeTokens } from './types';

export interface MeasureNodeBoxOptions {
  /** 测量适配器（宽度来源）；不传时按每字符 1px 退化估算。 */
  adapter?: MeasureAdapter;
  /** 左侧图标数，宽度累加 iconCount × theme.iconSlotWidth。 */
  iconCount?: number;
}

export interface NodeBoxMeasure {
  w: number;
  h: number;
  lines: string[];
}

/**
 * 计算节点盒尺寸与最终文本行：
 * - 按 '\n' 分行；单行超 theme.maxTextWidth 时逐字符贪心断行（中英文通用），
 *   在即将溢出的字符前断开，绝不产生空尾行（空文本除外）。
 * - 行高 = fontSize × theme.lineHeightRatio，h = 行数 × 行高。
 * - w = max(最宽行宽 + 2×nodePaddingX + iconCount×iconSlotWidth, minNodeWidth)。
 * 纯函数、确定性：同一输入恒得同一输出。
 */
export function measureNodeBox(
  text: string,
  style: TextStyle,
  theme: ThemeTokens,
  options: MeasureNodeBoxOptions = {},
): NodeBoxMeasure {
  const adapter: MeasureAdapter = options.adapter ?? defaultAdapter;
  const iconCount = options.iconCount ?? 0;
  const physicalLines = text.split('\n');
  const lines = physicalLines.flatMap((line) => wrapLine(line, adapter, style, theme.maxTextWidth));
  const lineHeight = style.fontSize * theme.lineHeightRatio;
  const h = lines.length * lineHeight;

  let maxLineW = 0;
  for (const line of lines) {
    const w = adapter.measureTextLine(line, style);
    if (w > maxLineW) maxLineW = w;
  }
  const w = Math.max(
    maxLineW + theme.nodePaddingX * 2 + iconCount * theme.iconSlotWidth,
    theme.minNodeWidth,
  );
  return { w, h, lines };
}

/** 单行 → 若超 maxTextWidth 则逐字符贪心断行；空行原样保留为一行。 */
function wrapLine(
  line: string,
  adapter: MeasureAdapter,
  style: TextStyle,
  maxTextWidth: number,
): string[] {
  if (line === '') return [''];
  const out: string[] = [];
  let current = '';
  // 按码点迭代，代理对（emoji 等）不被拆断。
  for (const ch of line) {
    const candidate = current + ch;
    if (current !== '' && adapter.measureTextLine(candidate, style) > maxTextWidth) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

/** 退化适配器：每码点 1px。仅作无适配器时的确定性兜底，宿主应传入真实测量。 */
const defaultAdapter: MeasureAdapter = {
  measureTextLine: (text) => [...text].length,
};
