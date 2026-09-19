import { describe, expect, it } from 'vitest';
import { measureNodeBox } from './measure';
import { THEMES } from './themes';
import type { MeasureAdapter, TextStyle, ThemeTokens } from './types';

// 桩测量适配器：每个字符固定 10px 宽（行高由引擎按 theme 自算，不经过适配器）。
const stubAdapter: MeasureAdapter = {
  measureTextLine: (text: string) => text.length * 10,
};

const style: TextStyle = { fontSize: 14, fontWeight: 400, fontFamily: 'sans-serif' };

// 桩主题：几何度量为本套测试自有值；其余 token（颜色/字体）以默认主题补齐。
const theme: ThemeTokens = {
  ...THEMES['gmind-blue'],
  nodePaddingX: 8,
  iconSlotWidth: 18,
  lineHeightRatio: 1.5,
  maxTextWidth: 50,
  minNodeWidth: 20,
  V_GAP: 14,
  H_GAP: 40,
};

describe('measureNodeBox', () => {
  it('单行文本：宽度 = 行宽 + 2×nodePaddingX，高度 = fontSize × lineHeightRatio', () => {
    // '你好' → 2 字 × 10px = 20；w = 20 + 2×8 = 36；h = 14 × 1.5 = 21
    const box = measureNodeBox('你好', style, theme, { adapter: stubAdapter });
    expect(box.lines).toEqual(['你好']);
    expect(box.w).toBe(36);
    expect(box.h).toBe(21);
  });

  it('多行（\\n 分行）：行高逐行累计，宽度取最宽行', () => {
    const box = measureNodeBox('ab\ncd', style, theme, { adapter: stubAdapter });
    expect(box.lines).toEqual(['ab', 'cd']);
    expect(box.w).toBe(2 * 10 + 2 * 8);
    expect(box.h).toBe(2 * 14 * 1.5);
  });

  it('超宽逐字符贪心断行：10 字 × 10px、maxTextWidth=50 → ["aaaaa","aaaaa"] 两行', () => {
    const box = measureNodeBox('aaaaaaaaaa', style, theme, { adapter: stubAdapter });
    expect(box.lines).toEqual(['aaaaa', 'aaaaa']);
    expect(box.h).toBe(2 * 14 * 1.5);
    expect(box.w).toBe(5 * 10 + 2 * 8);
  });

  it('图标槽累加：iconCount × iconSlotWidth 计入宽度', () => {
    const box = measureNodeBox('ab', style, theme, { adapter: stubAdapter, iconCount: 2 });
    expect(box.w).toBe(2 * 10 + 2 * 8 + 2 * 18);
    expect(box.h).toBe(14 * 1.5);
  });

  it('空文本：宽度收敛到 theme.minNodeWidth，仍占一行高度', () => {
    const box = measureNodeBox('', style, theme, { adapter: stubAdapter });
    expect(box.w).toBe(theme.minNodeWidth);
    expect(box.h).toBe(14 * 1.5);
  });
});
