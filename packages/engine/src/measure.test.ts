import { describe, expect, it } from 'vitest';
import { measureNodeBox } from './measure';
import { THEMES } from './themes';
import { TASK_PROGRESS_W, TASK_ROW_H, taskRowContentWidth } from './taskvisual';
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

  // T6 carry-in 裁决（Task 12 落地）：布局盒高必须计入图片高度。
  it('图片高度计入：h = max(文本高, imageH)；无图不变', () => {
    // 文本高 21 < 图高 64 → 图高主导
    expect(measureNodeBox('你好', style, theme, { adapter: stubAdapter, imageH: 64 }).h).toBe(64);
    // 文本高 63 > 图高 10 → 文本主导
    const multi = measureNodeBox('a\nb\nc', style, theme, { adapter: stubAdapter, imageH: 10 });
    expect(multi.h).toBe(3 * 14 * 1.5);
    // 缺省（无图）行为不变
    expect(measureNodeBox('你好', style, theme, { adapter: stubAdapter }).h).toBe(21);
  });

  it('图片宽度计入：w ≥ imageW + 2×nodePaddingX；文本更宽时文本主导', () => {
    // 图宽 100 + 2×8 = 116 > 文本宽 20 + 16
    expect(measureNodeBox('ab', style, theme, { adapter: stubAdapter, imageW: 100 }).w).toBe(116);
    // 文本宽 50 + 16 > 图宽 10 + 16 → 文本主导
    expect(measureNodeBox('aaaaaaaaaa', style, theme, { adapter: stubAdapter, imageW: 10 }).w).toBe(
      5 * 10 + 2 * 8,
    );
  });

  // M7c-C2 任务信息行槽位（只增不改）：无 taskRow 选项时几何与旧版逐字节一致；
  // 有 taskRow 时盒高加一行（TASK_ROW_H）、盒宽下限容纳任务行内容。
  it('任务行槽位：无 taskRow 几何不变；有 taskRow 高度加一行、宽度保底任务行内容', () => {
    const slots = { owners: 2, showProgress: true, hasDue: true };
    // 缺省（无任务信息）：完全不参与
    const plain = measureNodeBox('ab', style, theme, { adapter: stubAdapter });
    expect(plain.h).toBe(14 * 1.5);
    expect(plain.w).toBe(2 * 10 + 2 * 8);
    // 有任务信息：h = 文本高 + TASK_ROW_H；w 下限 = 任务行内容宽（126 > 文本宽 36）
    const withRow = measureNodeBox('ab', style, theme, { adapter: stubAdapter, taskRow: slots });
    expect(withRow.h).toBe(14 * 1.5 + TASK_ROW_H);
    expect(withRow.w).toBe(taskRowContentWidth(slots));
    // 任务行内容更窄时文本主导宽度，任务行仍计高（本套主题 maxTextWidth=50 会断行，
    // 文本主导上限 5×10+16=66，故取窄槽位 owners=1）
    const narrow = { owners: 1, showProgress: false, hasDue: false };
    const wide = measureNodeBox('ab', style, theme, { adapter: stubAdapter, taskRow: narrow });
    expect(wide.w).toBe(2 * 10 + 2 * 8);
    expect(wide.h).toBe(14 * 1.5 + TASK_ROW_H);
  });

  // M7c-C1 描述行（只增不改）：无 description 选项时几何与旧版逐字节一致（金样锁定）；
  // 有描述时盒高加一行（TASK_ROW_H，与任务行同条带高度）、盒宽容纳截断后的单行。
  it('描述行：无 description 几何不变；有描述高加一行、宽度容纳单行（未超宽原样）', () => {
    const plain = measureNodeBox('ab', style, theme, { adapter: stubAdapter });
    expect('descLine' in plain).toBe(false); // 无描述：字段不出现
    expect(plain.h).toBe(14 * 1.5);
    const withDesc = measureNodeBox('ab', style, theme, { adapter: stubAdapter, description: '描述' });
    expect(withDesc.descLine).toBe('描述'); // 2 字 × 12px 字号桩（每码点 1px）= 2px ≤ 50 不截断
    expect(withDesc.h).toBe(14 * 1.5 + TASK_ROW_H);
    // 描述宽 2 + 2×8 = 18 < 文本主导宽 36：宽度仍由文本主导
    expect(withDesc.w).toBe(2 * 10 + 2 * 8);
    // 空串 = 无描述（零参与）
    const empty = measureNodeBox('ab', style, theme, { adapter: stubAdapter, description: '' });
    expect('descLine' in empty).toBe(false);
    expect(empty.h).toBe(14 * 1.5);
  });

  it('描述行单行省略：超 maxTextWidth 逐码点截断并追加省略号，截断结果计宽不超上限', () => {
    // 桩适配器每码点 10px、maxTextWidth=50：5 字描述（50px）恰不超；6 字触发截断
    const fits = measureNodeBox('ab', style, theme, { adapter: stubAdapter, description: '描'.repeat(5) });
    expect(fits.descLine).toBe('描'.repeat(5));
    const truncated = measureNodeBox('ab', style, theme, { adapter: stubAdapter, description: '描'.repeat(6) });
    expect(truncated.descLine).toBe('描'.repeat(4) + '…'); // 4 字 + 省略号 = 5 码点 = 50px 恰好容纳
    // 描述主导节点宽度：50 + 2×8 = 66（本例文本宽 36）
    expect(truncated.w).toBe(50 + 2 * 8);
  });

  // M7b 补课（mindgrid 账号级显示偏好「脑图简洁模式」）：compact=true 时节点盒
  // 收敛为「标题 + 标记 + 内联进度」紧凑盒——描述行不产出、任务行槽位不计高宽。
  describe('compact 简洁模式', () => {
    const slots = { owners: 2, showProgress: true, hasDue: true };

    it('描述行不产出、任务行槽位不计高宽：盒高只含标题行，盒宽=文本宽+内联进度槽', () => {
      const box = measureNodeBox('ab', style, theme, {
        adapter: stubAdapter,
        description: '描述',
        taskRow: slots,
        compact: true,
      });
      expect('descLine' in box).toBe(false); // 描述行恒缺省（渲染侧 gm-desc 隐藏）
      expect(box.h).toBe(14 * 1.5); // 任务行/描述行零参与（对比详细模式 +2×TASK_ROW_H）
      // 内联进度槽（TASK_PROGRESS_W）随文本计入宽度下限（长标题不与内联百分数重叠）
      expect(box.w).toBe(2 * 10 + 2 * 8 + TASK_PROGRESS_W);
    });

    it('无任务信息零内联槽：紧凑盒=纯标题盒（与缺省路径宽度一致）', () => {
      const box = measureNodeBox('ab', style, theme, {
        adapter: stubAdapter,
        description: '描述',
        compact: true,
      });
      expect('descLine' in box).toBe(false);
      expect(box.h).toBe(14 * 1.5);
      expect(box.w).toBe(2 * 10 + 2 * 8);
    });

    it('紧凑盒窄于任务行内容宽：描述/任务详情的占位让位给内联进度', () => {
      // 详细模式盒宽下限 = 任务行内容宽 126；紧凑盒 66 显著缩小（「缩小节点占位」）
      const detail = measureNodeBox('ab', style, theme, { adapter: stubAdapter, taskRow: slots });
      const compactBox = measureNodeBox('ab', style, theme, {
        adapter: stubAdapter,
        taskRow: slots,
        compact: true,
      });
      expect(detail.w).toBe(taskRowContentWidth(slots));
      expect(compactBox.w).toBe(2 * 10 + 2 * 8 + TASK_PROGRESS_W);
      expect(compactBox.h).toBe(detail.h - TASK_ROW_H);
    });

    it('缺省（非 compact）与原路径逐字节一致：不传 compact 零差异', () => {
      const plain = measureNodeBox('ab', style, theme, {
        adapter: stubAdapter,
        description: '描述',
        taskRow: slots,
      });
      const explicit = measureNodeBox('ab', style, theme, {
        adapter: stubAdapter,
        description: '描述',
        taskRow: slots,
        compact: false,
      });
      expect(explicit).toEqual(plain);
      expect(explicit.descLine).toBe('描述');
    });
  });
});
