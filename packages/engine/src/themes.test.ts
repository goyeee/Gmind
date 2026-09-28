import { describe, expect, it } from 'vitest';
import { layout } from './layout';
import { THEMES, contrastRatio, resolveNodeStyle, resolveThemeId } from './themes';
import type {
  DocReader,
  NodeSnapshotLike,
  ThemeId,
  ThemeTokens,
} from './types';

// ---------------------------------------------------------------------------
// 桩：与 layout.test 同构的最小 DocReader（仅用于主题 × 布局集成冒烟）。
// ---------------------------------------------------------------------------

interface PlainNode {
  text: string;
  children?: string[];
}

function makeReader(defs: Record<string, PlainNode>): DocReader {
  const snap = (id: string): NodeSnapshotLike | null => {
    const def = defs[id];
    if (!def) return null;
    return {
      id,
      text: def.text,
      parentId: '',
      childIds: def.children ?? [],
      collapsed: false,
      deleted: false,
    };
  };
  return {
    getMeta: () => ({ title: '主题测试', structureType: 'mindmap', themeId: 'gmind-blue' }),
    getNode: snap,
    childrenIds: (id) => snap(id)?.childIds ?? [],
  };
}

const stubAdapter = { measureTextLine: (text: string) => text.length * 10 };

/** 金样同构的 3 层固定树（不比对金样——金样绑定测试自有主题桩）。 */
function goldenLikeReader(): DocReader {
  return makeReader({
    root: { text: '中心主题', children: ['g1', 'g2', 'g3'] },
    g1: { text: '分支一', children: ['ga'] },
    g2: { text: '分支二' },
    g3: { text: '分支三', children: ['gc'] },
    ga: { text: '叶子甲' },
    gc: { text: '叶子丙' },
  });
}

// ---------------------------------------------------------------------------
// 1. token 键完整性：三主题逐 key 存在、类型正确、无多余键
// ---------------------------------------------------------------------------

/** 必备 token 及其类型（Task 5 绑定裁决定义；Task 6 渲染器逐个消费）。 */
const TOKEN_SPEC: Record<keyof ThemeTokens, 'string' | 'number'> = {
  // 布局度量（Task 3/4 既有键，沿用）
  nodePaddingX: 'number',
  iconSlotWidth: 'number',
  lineHeightRatio: 'number',
  maxTextWidth: 'number',
  minNodeWidth: 'number',
  V_GAP: 'number',
  H_GAP: 'number',
  // root 级
  rootFill: 'string',
  rootBorderColor: 'string',
  rootTextColor: 'string',
  rootFontSize: 'number',
  rootFontWeight: 'number',
  rootFontFamily: 'string',
  // level1 级
  level1Fill: 'string',
  level1BorderColor: 'string',
  level1TextColor: 'string',
  level1FontSize: 'number',
  level1FontWeight: 'number',
  level1FontFamily: 'string',
  // level2+ 级
  level2Fill: 'string',
  level2BorderColor: 'string',
  level2TextColor: 'string',
  level2FontSize: 'number',
  level2FontWeight: 'number',
  level2FontFamily: 'string',
  // 画布 / 连接线
  canvasBackground: 'string',
  edgeColor: 'string',
  edgeWidth: 'number',
  // 节点盒外观
  nodeBorderRadius: 'number',
  nodeBorderWidth: 'number',
  // 折叠徽标
  collapseBadgeBg: 'string',
  collapseBadgeFg: 'string',
};

/** M1b 三套 + M6 Task 4 扩容九套（企微对标）＝ 12 套全量。 */
const NEW_THEME_IDS: ThemeId[] = [
  'deep-blue',
  'forest',
  'sakura',
  'graphite',
  'violet',
  'amber',
  'celadon',
  'ink-wash',
  'peach',
];

const THEME_IDS: ThemeId[] = ['gmind-blue', 'gmind-warm', 'gmind-accessible', ...NEW_THEME_IDS];

describe('THEMES token 完整性', () => {
  it('THEMES 恰有十二个键：M1b 三套 + M6 扩容九套', () => {
    expect(Object.keys(THEMES).sort()).toEqual([...THEME_IDS].sort());
  });

  it('主题 id 唯一（12 套无重复键）', () => {
    expect(new Set(Object.keys(THEMES)).size).toBe(12);
  });

  for (const id of THEME_IDS) {
    it(`${id}：必备键齐全、类型正确、无多余键`, () => {
      const theme = THEMES[id];
      const specKeys = Object.keys(TOKEN_SPEC).sort();
      const themeKeys = Object.keys(theme).sort();
      expect(themeKeys).toEqual(specKeys);

      for (const [key, type] of Object.entries(TOKEN_SPEC)) {
        const value = (theme as unknown as Record<string, unknown>)[key];
        expect(value, `${id}.${key} 应有值`).toBeDefined();
        expect(typeof value, `${id}.${key} 类型`).toBe(type);
        if (type === 'number') {
          expect(Number.isFinite(value), `${id}.${key} 应为有限数`).toBe(true);
        }
      }
    });

    it(`${id}：颜色 token 均为 #rrggbb 十六进制，字体/字号分级完整`, () => {
      const theme = THEMES[id];
      for (const key of Object.keys(TOKEN_SPEC)) {
        if (!/(Fill|Color|Background|Bg|Fg)$/.test(key)) continue;
        const value = (theme as unknown as Record<string, string>)[key];
        expect(value, `${id}.${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(theme.rootFontSize).toBe(20);
      expect(theme.level1FontSize).toBe(16);
      expect(theme.level2FontSize).toBe(14);
      expect(theme.rootFontFamily.length).toBeGreaterThan(0);
      expect(theme.level1FontFamily.length).toBeGreaterThan(0);
      expect(theme.level2FontFamily.length).toBeGreaterThan(0);
    });
  }

  it('blue/warm 字重分级沿用既有缺省：root 600 / level1 500 / level2 400', () => {
    for (const id of ['gmind-blue', 'gmind-warm'] as ThemeId[]) {
      const theme = THEMES[id];
      expect(theme.rootFontWeight).toBe(600);
      expect(theme.level1FontWeight).toBe(500);
      expect(theme.level2FontWeight).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 三套色板真的不同（绑定主色钉定）
// ---------------------------------------------------------------------------

describe('主题色板', () => {
  it('主色钉定：blue #3370ff / warm #ff8800 / accessible #1a5fb4（+ #e66100 橙）', () => {
    expect(THEMES['gmind-blue'].rootFill).toBe('#3370ff');
    expect(THEMES['gmind-warm'].rootFill).toBe('#ff8800');
    expect(THEMES['gmind-accessible'].rootFill).toBe('#1a5fb4');
    expect(THEMES['gmind-accessible'].level1Fill).toBe('#e66100');
  });

  it('十二主题的标识性 token（主色/一级底/画布/连线）两两不同', () => {
    // level2Fill 等共用中性值（三级白底）不算色板趋同；主题身份由下列 token 区分。
    for (const key of ['rootFill', 'level1Fill', 'canvasBackground', 'edgeColor'] as const) {
      const values = THEME_IDS.map((id) => THEMES[id][key]);
      expect(new Set(values).size, `${key} 十二主题应互不相同`).toBe(12);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. contrastRatio（WCAG 公式纯函数）
// ---------------------------------------------------------------------------

describe('contrastRatio', () => {
  it('黑白对比度恰为 21，同色为 1', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBe(21);
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
    expect(contrastRatio('#3370ff', '#3370ff')).toBe(1);
  });

  it('accessible root：白字对蓝底约 6.29（≥4.5 且 <7）', () => {
    const ratio = contrastRatio(THEMES['gmind-accessible'].rootTextColor, THEMES['gmind-accessible'].rootFill);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratio).toBeLessThan(7);
  });
});

// ---------------------------------------------------------------------------
// 4. 全主题 WCAG AA（M6 Task 4）：正文对比度守卫
//    裁定：正文（level1 / level2）对全部 12 套跑 ≥4.5:1；root（标题级、20px 半粗
//    大字号）对 M6 扩容九套跑 ≥4.5:1。M1b 既有两套 blue/warm 的 root 主色
//    （#3370ff / #ff8800）是 M1b 绑定钉定值（见下方「主色钉定」用例），当时仅
//    a11y 主题承诺 AA（blue root 4.28、warm root 2.39 均不达 4.5）；T4 扩容不
//    改 M1b 钉定（零回归），遗留差距由本注释与任务报告显式记录。
// ---------------------------------------------------------------------------

describe('全主题 WCAG AA（12 套扩容守卫）', () => {
  it.each(THEME_IDS)('%s：level1 / level2 正文 text vs fill 均 ≥ 4.5:1', (id) => {
    const theme = THEMES[id];
    expect(contrastRatio(theme.level1TextColor, theme.level1Fill), `${id} level1`).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(theme.level2TextColor, theme.level2Fill), `${id} level2`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NEW_THEME_IDS)('%s：root 标题 text vs fill ≥ 4.5:1（扩容新主题全级达标）', (id) => {
    const theme = THEMES[id];
    expect(contrastRatio(theme.rootTextColor, theme.rootFill), `${id} root`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(NEW_THEME_IDS)('%s：折叠徽标 fg vs bg ≥ 4.5:1', (id) => {
    const theme = THEMES[id];
    expect(contrastRatio(theme.collapseBadgeFg, theme.collapseBadgeBg)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// 4b. accessible 主题 WCAG AA：三级正文 text vs fill ≥ 4.5:1
// ---------------------------------------------------------------------------

describe('accessible 主题 WCAG AA', () => {
  const accessible = THEMES['gmind-accessible'];

  it('root / level1 / level2 的 text vs fill 均 ≥ 4.5:1', () => {
    expect(contrastRatio(accessible.rootTextColor, accessible.rootFill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accessible.level1TextColor, accessible.level1Fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(accessible.level2TextColor, accessible.level2Fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('折叠徽标 fg vs bg ≥ 4.5:1', () => {
    expect(contrastRatio(accessible.collapseBadgeFg, accessible.collapseBadgeBg)).toBeGreaterThanOrEqual(4.5);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveNodeStyle：主题派生 + 节点覆盖
// ---------------------------------------------------------------------------

describe('resolveNodeStyle', () => {
  const blue = THEMES['gmind-blue'];

  it('depth 级联：0=root、1=level1、2 及更深=level2', () => {
    for (const depth of [0, 1, 2, 7]) {
      const s = resolveNodeStyle(blue, depth, {});
      const tier = depth <= 0 ? 'root' : depth === 1 ? 'level1' : 'level2';
      expect(s.fill, `depth=${depth} fill`).toBe(blue[`${tier}Fill`]);
      expect(s.border, `depth=${depth} border`).toBe(blue[`${tier}BorderColor`]);
      expect(s.textColor, `depth=${depth} textColor`).toBe(blue[`${tier}TextColor`]);
      expect(s.fontSize, `depth=${depth} fontSize`).toBe(blue[`${tier}FontSize`]);
      expect(s.fontFamily, `depth=${depth} fontFamily`).toBe(blue[`${tier}FontFamily`]);
    }
  });

  it('textStyle 与解析出的字号/字族/主题字重一致', () => {
    const root = resolveNodeStyle(blue, 0, {});
    expect(root.textStyle).toEqual({
      fontSize: blue.rootFontSize,
      fontWeight: blue.rootFontWeight,
      fontFamily: blue.rootFontFamily,
    });
    const leaf = resolveNodeStyle(blue, 3, {});
    expect(leaf.textStyle.fontWeight).toBe(blue.level2FontWeight);
  });

  it('nodeStyle 覆盖优先：fill/border/color/fontSize/fontFamily 逐 key 生效', () => {
    const s = resolveNodeStyle(blue, 1, {
      fill: '#00ff00',
      border: '#123456',
      color: '#ff0000',
      fontSize: '18',
      fontFamily: 'Georgia, serif',
    });
    expect(s.fill).toBe('#00ff00');
    expect(s.border).toBe('#123456');
    expect(s.textColor).toBe('#ff0000');
    expect(s.fontSize).toBe(18);
    expect(s.fontFamily).toBe('Georgia, serif');
    expect(s.textStyle.fontSize).toBe(18);
    expect(s.textStyle.fontFamily).toBe('Georgia, serif');
    // 未覆盖的 key 仍取主题值。
    expect(s.textStyle.fontWeight).toBe(blue.level1FontWeight);
  });

  it('非法 fontSize（NaN）回退主题值；空串同样回退', () => {
    const bad = resolveNodeStyle(blue, 2, { fontSize: 'abc' });
    expect(bad.fontSize).toBe(blue.level2FontSize);
    expect(bad.textStyle.fontSize).toBe(blue.level2FontSize);
    const empty = resolveNodeStyle(blue, 2, { fontSize: '' });
    expect(empty.fontSize).toBe(blue.level2FontSize);
  });

  it('空覆盖对象返回与纯主题派生一致的结果（浅拷贝，不共享引用）', () => {
    const a = resolveNodeStyle(blue, 0, {});
    const b = resolveNodeStyle(blue, 0, {});
    expect(a).toEqual(b);
    expect(a.textStyle).not.toBe(b.textStyle);
  });

  it('M1b 既有三套主题解析结果钉定（扩容零回归）', () => {
    // 三套 × 三级：fill / textColor / fontSize 全取主题 token 本值（M1b 裁定的
    // 既有输出），任何扩容引起的级联/兜底改动都会在此暴露。
    for (const id of ['gmind-blue', 'gmind-warm', 'gmind-accessible'] as ThemeId[]) {
      const theme = THEMES[id];
      for (const [depth, tier] of [[0, 'root'], [1, 'level1'], [2, 'level2']] as const) {
        const s = resolveNodeStyle(theme, depth, {});
        expect(s.fill, `${id} depth=${depth} fill`).toBe(theme[`${tier}Fill`]);
        expect(s.textColor, `${id} depth=${depth} textColor`).toBe(theme[`${tier}TextColor`]);
        expect(s.fontSize, `${id} depth=${depth} fontSize`).toBe(theme[`${tier}FontSize`]);
        expect(s.textStyle.fontWeight, `${id} depth=${depth} fontWeight`).toBe(theme[`${tier}FontWeight`]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. resolveThemeId：'gmind-light' 别名 + 未知兜底
// ---------------------------------------------------------------------------

describe('resolveThemeId', () => {
  it("'gmind-light'（M0 迁移历史默认）解析为 'gmind-blue' 别名", () => {
    expect(resolveThemeId('gmind-light')).toBe('gmind-blue');
  });

  it('十二枚合法键原样透传（M1b 三套 + M6 扩容九套）', () => {
    for (const id of THEME_IDS) {
      expect(resolveThemeId(id)).toBe(id);
    }
  });

  it('未知值（含空串、大小写不符）兜底 gmind-blue', () => {
    expect(resolveThemeId('gmind-dark')).toBe('gmind-blue');
    expect(resolveThemeId('')).toBe('gmind-blue');
    expect(resolveThemeId('GMIND-BLUE')).toBe('gmind-blue');
  });
});

// ---------------------------------------------------------------------------
// 7. layout 集成：accessible 主题驱动缺省样式跑金样同构树（不比对金样）
// ---------------------------------------------------------------------------

describe('layout × THEMES 集成', () => {
  it('三结构以 accessible 主题缺省样式布局：根居原点、坐标全有限、缺省根样式取主题字号×行高', () => {
    for (const structure of ['mindmap', 'logic', 'org'] as const) {
      const result = layout(goldenLikeReader(), {
        structure,
        theme: THEMES['gmind-accessible'],
        measure: stubAdapter,
      });
      expect(result.nodes).toHaveLength(6);
      const root = result.nodes.find((n) => n.id === 'root');
      if (!root) throw new Error('root 盒缺失');
      // 缺省 styleOf 主题驱动：根字号 20 × lineHeightRatio 1.4 → 高 28。
      expect(root.h).toBe(20 * THEMES['gmind-accessible'].lineHeightRatio);
      expect(root.x + root.w / 2).toBe(0);
      expect(root.y + root.h / 2).toBe(0);
      for (const node of result.nodes) {
        expect(Number.isFinite(node.x)).toBe(true);
        expect(Number.isFinite(node.y)).toBe(true);
        expect(Number.isFinite(node.w)).toBe(true);
        expect(Number.isFinite(node.h)).toBe(true);
      }
      expect(Number.isFinite(result.width)).toBe(true);
      expect(Number.isFinite(result.height)).toBe(true);
    }
  });

  it('同一主题两次布局逐字段确定', () => {
    const run = () => layout(goldenLikeReader(), { structure: 'mindmap', theme: THEMES['gmind-warm'], measure: stubAdapter });
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});
