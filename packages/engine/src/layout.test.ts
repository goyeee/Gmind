import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from './layout';
import { THEMES } from './themes';
import { TASK_ROW_H, taskRowContentWidth, type NodeTaskVisual } from './taskvisual';
import type {
  DocReader,
  LayoutResult,
  MeasureAdapter,
  NodeBox,
  NodeSnapshotLike,
  StructureType,
  SummaryLike,
  ThemeTokens,
  TextStyle,
} from './types';

// ---------------------------------------------------------------------------
// 固定桩：plain object → DocReader；每字符 10px、行高 20px（fontSize 20 × ratio 1）。
// ---------------------------------------------------------------------------

interface PlainNode {
  text: string;
  children?: string[];
  collapsed?: boolean;
  deleted?: boolean;
  icons?: Record<string, unknown>;
  image?: { key: string; w: number; h: number } | null;
  task?: NodeTaskVisual;
}

function makeReader(defs: Record<string, PlainNode>, summaries?: SummaryLike[]): DocReader {
  const snap = (id: string): NodeSnapshotLike | null => {
    const def = defs[id];
    if (!def) return null;
    return {
      id,
      text: def.text,
      parentId: '',
      childIds: def.children ?? [],
      collapsed: def.collapsed ?? false,
      deleted: def.deleted ?? false,
      icons: def.icons,
      image: def.image,
      task: def.task,
    };
  };
  const reader: DocReader = {
    getMeta: () => ({ title: '测试文档', structureType: 'mindmap', themeId: 'stub' }),
    getNode: snap,
    childrenIds: (id) => snap(id)?.childIds ?? [],
  };
  if (summaries !== undefined) reader.summaries = () => summaries;
  return reader;
}

const stubAdapter: MeasureAdapter = { measureTextLine: (text) => text.length * 10 };

/** 金样绑定桩主题：几何度量沿用 T4 金样值；其余 token（颜色/字体）以默认主题补齐。 */
const theme: ThemeTokens = {
  ...THEMES['gmind-blue'],
  nodePaddingX: 12,
  iconSlotWidth: 20,
  lineHeightRatio: 1,
  maxTextWidth: 240,
  minNodeWidth: 40,
  V_GAP: 14,
  H_GAP: 40,
};

const boxStyle: TextStyle = { fontSize: 20, fontWeight: 400, fontFamily: 'stub' };
const styleOf = (): TextStyle => boxStyle;

// ---------------------------------------------------------------------------
// 5 棵固定树：wide（宽浅均衡）、deep（深窄链）、collapsed（折叠）、single（单节点）、
// mixed（多行 + 图标 + 墓碑 + 折叠无子）。
// ---------------------------------------------------------------------------

const TREE_BUILDERS: Record<string, () => DocReader> = {
  wide: () =>
    makeReader({
      root: { text: '中心', children: ['a', 'b', 'c'] },
      a: { text: '分支一', children: ['a1', 'a2'] },
      b: { text: '分支二', children: ['b1', 'b2'] },
      c: { text: '分支三', children: ['c1', 'c2'] },
      a1: { text: '叶子一' },
      a2: { text: '叶子二' },
      b1: { text: '叶子三' },
      b2: { text: '叶子四' },
      c1: { text: '叶子五' },
      c2: { text: '叶子六' },
    }),
  deep: () =>
    makeReader({
      root: { text: '根', children: ['d1'] },
      d1: { text: '二级', children: ['d2'] },
      d2: { text: '三级', children: ['d3'] },
      d3: { text: '四级', children: ['d4'] },
      d4: { text: '五级' },
    }),
  collapsed: () =>
    makeReader({
      root: { text: '根', children: ['k1', 'k2'] },
      k1: { text: '折叠', collapsed: true, children: ['x1', 'x2', 'x3'] },
      x1: { text: '藏一' },
      x2: { text: '藏二' },
      x3: { text: '藏三' },
      k2: { text: '展开', children: ['y1'] },
      y1: { text: '孙' },
    }),
  single: () => makeReader({ root: { text: '独苗' } }),
  mixed: () =>
    makeReader({
      root: { text: '根', children: ['m1', 'm2', 'm3'] },
      m1: { text: '多行\n文本' },
      m2: { text: '图标', icons: { other: ['done', 'cancel'] }, collapsed: true },
      m3: { text: '墓碑', deleted: true, children: ['m3a'] },
      m3a: { text: '不可达' },
    }),
};

const TREE_NAMES = ['wide', 'deep', 'collapsed', 'single', 'mixed'] as const;

/** 树级期望：盒数 / 边数 / collapsedCounts。 */
const TREE_EXPECT: Record<string, { nodeCount: number; edgeCount: number; collapsedCounts: Record<string, number> }> = {
  wide: { nodeCount: 10, edgeCount: 9, collapsedCounts: {} },
  deep: { nodeCount: 5, edgeCount: 4, collapsedCounts: {} },
  collapsed: { nodeCount: 4, edgeCount: 3, collapsedCounts: { k1: 3 } },
  single: { nodeCount: 1, edgeCount: 0, collapsedCounts: {} },
  mixed: { nodeCount: 3, edgeCount: 2, collapsedCounts: { m2: 0 } },
};

const STRUCTURES: StructureType[] = ['mindmap', 'logic', 'org'];

// ---------------------------------------------------------------------------
// 不变量断言工具
// ---------------------------------------------------------------------------

function boxOf(result: LayoutResult, id: string): NodeBox {
  const box = result.nodes.find((n) => n.id === id);
  expect(box, `节点 ${id} 应有盒`).toBeDefined();
  return box as NodeBox;
}

function assertNoOverlap(nodes: NodeBox[]): void {
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i] as NodeBox;
      const b = nodes[j] as NodeBox;
      const intersects =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(intersects, `节点盒相交：${a.id} 与 ${b.id}`).toBe(false);
    }
  }
}

function assertBbox(result: LayoutResult): void {
  const xs = result.nodes.map((n) => n.x);
  const xs2 = result.nodes.map((n) => n.x + n.w);
  const ys = result.nodes.map((n) => n.y);
  const ys2 = result.nodes.map((n) => n.y + n.h);
  const minX = Math.min(...xs, ...xs2);
  const maxX = Math.max(...xs, ...xs2);
  const minY = Math.min(...ys, ...ys2);
  const maxY = Math.max(...ys, ...ys2);
  expect(result.width).toBe(maxX - minX);
  expect(result.height).toBe(maxY - minY);
  expect(result.width).toBeGreaterThan(0);
  expect(result.height).toBeGreaterThan(0);
}

function splitEdge(id: string): [string, string] {
  const idx = id.indexOf('->');
  return [id.slice(0, idx), id.slice(idx + 2)];
}

/** 全结构不变量：无重叠、bbox 恰为极差、根居 (0,0)、计数、边存在性。 */
function expectCommonInvariants(result: LayoutResult, treeName: string): void {
  const expect0 = TREE_EXPECT[treeName] as { nodeCount: number; edgeCount: number; collapsedCounts: Record<string, number> };
  expect(result.nodes).toHaveLength(expect0.nodeCount);
  expect(result.edges).toHaveLength(expect0.edgeCount);

  assertNoOverlap(result.nodes);
  assertBbox(result);

  const root = boxOf(result, 'root');
  expect(root.x + root.w / 2).toBe(0);
  expect(root.y + root.h / 2).toBe(0);

  const counts = Object.fromEntries(result.collapsedCounts.entries());
  expect(counts).toEqual(expect0.collapsedCounts);

  const ids = new Set(result.nodes.map((n) => n.id));
  for (const edge of result.edges) {
    const [p, c] = splitEdge(edge.id);
    expect(ids.has(p), `边 ${edge.id} 父节点应在盒集`).toBe(true);
    expect(ids.has(c), `边 ${edge.id} 子节点应在盒集`).toBe(true);
  }
}

/** 有亲子边的几何关系：mindmap/logic 横向 H_GAP；org 纵向 V_GAP + 父居子带中点。 */
function expectEdgeGeometry(result: LayoutResult, structure: StructureType): void {
  for (const edge of result.edges) {
    const [pid, cid] = splitEdge(edge.id);
    const parent = boxOf(result, pid);
    const child = boxOf(result, cid);
    if (structure === 'org') {
      // 子整体位于父下方，层间恰隔 V_GAP。
      expect(child.y).toBeCloseTo(parent.y + parent.h + theme.V_GAP, 9);
      expect(child.y).toBeGreaterThan(parent.y);
    } else {
      // 子与父同侧延伸，层级间恰隔 H_GAP。
      if (child.side === 'left') {
        expect(parent.x - (child.x + child.w)).toBeCloseTo(theme.H_GAP, 9);
        expect(child.x + child.w).toBeLessThan(parent.x);
      } else {
        expect(child.x - (parent.x + parent.w)).toBeCloseTo(theme.H_GAP, 9);
        expect(child.x).toBeGreaterThan(parent.x);
      }
    }
  }
  if (structure === 'org') {
    // 父居子带中点上方：brief 以子树带宽（Σ子带宽 + H_GAP×(n-1)）定义居中基准，
    // 盒级可观测等价形式——子全为叶时带即盒极差（精确相等）；否则父中线必落在子盒跨度内。
    const byParent = new Map<string, NodeBox[]>();
    for (const edge of result.edges) {
      const [pid, cid] = splitEdge(edge.id);
      const list = byParent.get(pid) ?? [];
      list.push(boxOf(result, cid));
      byParent.set(pid, list);
    }
    const inner = new Set([...byParent.keys()]);
    for (const [pid, children] of byParent) {
      const parent = boxOf(result, pid);
      const bandMin = Math.min(...children.map((c) => c.x));
      const bandMax = Math.max(...children.map((c) => c.x + c.w));
      const centerX = parent.x + parent.w / 2;
      const allLeaves = children.every((c) => !inner.has(c.id));
      if (allLeaves) expect(centerX).toBeCloseTo((bandMin + bandMax) / 2, 9);
      else {
        expect(centerX).toBeGreaterThan(bandMin);
        expect(centerX).toBeLessThan(bandMax);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 不变量：5 棵固定树 × 3 结构
// ---------------------------------------------------------------------------

describe('layout 不变量（5 树 × 3 结构）', () => {
  for (const treeName of TREE_NAMES) {
    for (const structure of STRUCTURES) {
      it(`${treeName} / ${structure}`, () => {
        const reader = (TREE_BUILDERS[treeName] as () => DocReader)();
        const result = layout(reader, { structure, theme, measure: stubAdapter, styleOf });
        expectCommonInvariants(result, treeName);
        expectEdgeGeometry(result, structure);

        const root = boxOf(result, 'root');
        if (structure === 'mindmap') {
          for (const edge of result.edges) expect(edge.kind).toBe('bezier');
          for (const node of result.nodes) {
            if (node.id === 'root') continue;
            if (node.side === 'left') expect(node.x + node.w).toBeLessThan(root.x);
            else expect(node.x).toBeGreaterThan(root.x + root.w);
          }
        }
        if (structure === 'logic') {
          for (const edge of result.edges) expect(edge.kind).toBe('bezier');
          for (const node of result.nodes) {
            if (node.id !== 'root') expect(node.x).toBeGreaterThan(root.x + root.w);
          }
        }
        if (structure === 'org') {
          for (const edge of result.edges) expect(edge.kind).toBe('elbow');
          for (const node of result.nodes) expect(node.side).toBe('down');
        }
      });
    }
  }

  it('mindmap：预检查分侧——3 个等高一級子树得 1 右 2 左，深层与一级祖先同侧', () => {
    const result = layout(TREE_BUILDERS.wide(), { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    const root = boxOf(result, 'root');
    const level1 = result.nodes.filter((n) => n.depth === 1);
    expect(level1.length).toBe(3);
    // 预检查/断行语义：a 装入右（0+54 ≤ 95），b 起累计 108 > 95 切左。
    expect(level1.filter((n) => n.side === 'right')).toHaveLength(1);
    expect(level1.filter((n) => n.side === 'left')).toHaveLength(2);
    expect(boxOf(result, 'a').side).toBe('right');
    expect(boxOf(result, 'b').side).toBe('left');
    for (const node of level1) {
      if (node.side === 'left') expect(node.x + node.w).toBeLessThan(root.x);
      else expect(node.x).toBeGreaterThan(root.x + root.w);
    }
    // 深层后代与一级祖先同侧：左子树的叶子在更左侧，右子树的叶子在更右侧。
    const ancestorSide = new Map<string, 'left' | 'right'>();
    for (const edge of result.edges) {
      const [p, c] = splitEdge(edge.id);
      const parentSide = p === 'root' ? (boxOf(result, c).side as 'left' | 'right') : (ancestorSide.get(p) as 'left' | 'right');
      ancestorSide.set(c, parentSide);
      expect(boxOf(result, c).side).toBe(parentSide);
    }
    const leftLeaf = boxOf(result, 'c1');
    expect(leftLeaf.side).toBe('left');
    expect(leftLeaf.x + leftLeaf.w).toBeLessThan(root.x);
    const rightLeaf = boxOf(result, 'a1');
    expect(rightLeaf.side).toBe('right');
    expect(rightLeaf.x).toBeGreaterThan(root.x + root.w);
  });

  it('mindmap：两等高一級子树恰一左一右（分侧规则钉定）', () => {
    const reader = makeReader({
      root: { text: '根', children: ['p1', 'p2'] },
      p1: { text: '支一', children: ['pa'] },
      pa: { text: '叶甲' },
      p2: { text: '支二', children: ['pb'] },
      pb: { text: '叶乙' },
    });
    const result = layout(reader, { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    const root = boxOf(result, 'root');
    const level1 = result.nodes.filter((n) => n.depth === 1);
    expect(level1).toHaveLength(2);
    expect(level1.filter((n) => n.side === 'right')).toHaveLength(1);
    expect(level1.filter((n) => n.side === 'left')).toHaveLength(1);
    for (const node of level1) {
      if (node.side === 'left') expect(node.x + node.w).toBeLessThan(root.x);
      else expect(node.x).toBeGreaterThan(root.x + root.w);
    }
  });

  it('mindmap：父侧边锚点沿父边向子扇出（2026-09-27 连线修复钉定）', () => {
    const reader = makeReader({
      root: { text: '根', children: ['p'] },
      p: { text: '父节点', children: ['c1', 'c2', 'c3', 'c4'] },
      c1: { text: '子上' },
      c2: { text: '子中上' },
      c3: { text: '子中下' },
      c4: { text: '子下' },
    });
    const result = layout(reader, { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    const p = boxOf(result, 'p');
    const pMid = p.y + p.h / 2;
    const anchors = new Map<string, number>();
    for (const edge of result.edges) {
      const [pid, cid] = splitEdge(edge.id);
      if (pid !== 'p') continue;
      // 锚点恒在父盒侧边内（clamp ±(h/2 - 2)）
      expect(edge.from.y).toBeGreaterThanOrEqual(p.y + 2);
      expect(edge.from.y).toBeLessThanOrEqual(p.y + p.h - 2);
      // 锚点向子方向偏移：与子中线同侧（子距父中线超 epsilon 时）
      const cMid = boxOf(result, cid).y + boxOf(result, cid).h / 2;
      if (Math.abs(cMid - pMid) > 1) {
        expect(Math.sign(edge.from.y - pMid)).toBe(Math.sign(cMid - pMid));
      }
      anchors.set(cid, edge.from.y);
    }
    // 锚点随子中线单调（clamp 饱和可共享角点，但绝不回折）——兄弟曲线无交叉的
    // 充分条件；扇出取代旧的「共用父中心横线」（重叠/穿插的根源）
    expect(anchors.size).toBe(4);
    const ordered = [...anchors.entries()].sort(
      (a, b) => boxOf(result, a[0]).y - boxOf(result, b[0]).y,
    );
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i][1]).toBeGreaterThanOrEqual(ordered[i - 1][1]);
    }
  });

  it('bezier 控制点不越过对端（连线交叉修复钉定）', () => {
    // 旧实现 max(60, dx×0.5) 在列距 <120 时控制点互相越过对端端点，曲线 x 折返
    // 成涡流交叉；现恒取 dx×0.5，控制点 x 必落在 [from.x, to.x] 闭区间内。
    for (const structure of ['mindmap', 'logic'] as const) {
      const result = layout(TREE_BUILDERS.wide(), { structure, theme, measure: stubAdapter, styleOf });
      for (const edge of result.edges) {
        if (edge.kind !== 'bezier') continue;
        const lo = Math.min(edge.from.x, edge.to.x);
        const hi = Math.max(edge.from.x, edge.to.x);
        for (const c of edge.controls ?? []) {
          expect(c.x).toBeGreaterThanOrEqual(lo - 1e-9);
          expect(c.x).toBeLessThanOrEqual(hi + 1e-9);
        }
      }
    }
  });

  it('collapsed：折叠节点按叶子渲染，隐藏后代无盒，collapsedCounts 记 "+3"', () => {
    for (const structure of STRUCTURES) {
      const result = layout(TREE_BUILDERS.collapsed(), { structure, theme, measure: stubAdapter, styleOf });
      const ids = new Set(result.nodes.map((n) => n.id));
      expect(ids.has('x1')).toBe(false);
      expect(ids.has('x2')).toBe(false);
      expect(ids.has('x3')).toBe(false);
      expect(result.collapsedCounts.get('k1')).toBe(3);
      // 折叠节点无出边。
      expect(result.edges.some((e) => splitEdge(e.id)[0] === 'k1')).toBe(false);
    }
  });

  it('mixed：墓碑子树整体不出盒；图标槽计入宽度；多行高度翻倍', () => {
    for (const structure of STRUCTURES) {
      const result = layout(TREE_BUILDERS.mixed(), { structure, theme, measure: stubAdapter, styleOf });
      const ids = new Set(result.nodes.map((n) => n.id));
      expect(ids.has('m3')).toBe(false);
      expect(ids.has('m3a')).toBe(false);
      // '图标' 2 字 + 2 图标槽：w = 20 + 2×12 + 2×20 = 84。
      const m2 = boxOf(result, 'm2');
      expect(m2.w).toBe(84);
      // '多行\n文本' 两行：h = 2 × 20 = 40。
      const m1 = boxOf(result, 'm1');
      expect(m1.h).toBe(40);
    }
  });

  it('single：仅根盒居中于原点，无边，bbox 即根盒', () => {
    for (const structure of STRUCTURES) {
      const result = layout(TREE_BUILDERS.single(), { structure, theme, measure: stubAdapter, styleOf });
      expect(result.nodes).toHaveLength(1);
      expect(result.edges).toHaveLength(0);
      const root = result.nodes[0] as NodeBox;
      expect(root.x + root.w / 2).toBe(0);
      expect(root.y + root.h / 2).toBe(0);
      expect(result.width).toBe(root.w);
      expect(result.height).toBe(root.h);
    }
  });
});

// ---------------------------------------------------------------------------
// 概要 bracket 几何（M6 Task 6，企微对标）：只增不改——无概要时 summaries=[]
// ---------------------------------------------------------------------------

describe('layout 概要 bracket（M6 Task 6）', () => {
  /** 固定片段树：root → [s1, s2, s3, s4]（叶）。 */
  const SEG_DEFS: Record<string, PlainNode> = {
    root: { text: '根', children: ['s1', 's2', 's3', 's4'] },
    s1: { text: '周一' },
    s2: { text: '周三' },
    s3: { text: '周五' },
    s4: { text: '周日' },
  };

  it('三节点片段：y=片段底+12、x=片段左-8、w=片段宽+16、label 原样透传', () => {
    for (const structure of STRUCTURES) {
      const reader = makeReader(SEG_DEFS, [
        { id: 'sm1', nodeIds: ['s1', 's2', 's3'], label: '上半周' },
      ]);
      const result = layout(reader, { structure, theme, measure: stubAdapter, styleOf });
      expect(result.summaries).toHaveLength(1);
      const sum = result.summaries[0] as { id: string; x: number; y: number; w: number; label: string };
      expect(sum.id).toBe('sm1');
      expect(sum.label).toBe('上半周');
      const boxes = ['s1', 's2', 's3'].map((id) => boxOf(result, id));
      const minX = Math.min(...boxes.map((b) => b.x));
      const maxR = Math.max(...boxes.map((b) => b.x + b.w));
      const maxB = Math.max(...boxes.map((b) => b.y + b.h));
      expect(sum.x).toBe(minX - 8); // 每侧外扩 8
      expect(sum.w).toBe(maxR - minX + 16); // 片段宽 + 16
      expect(sum.y).toBe(maxB + 12); // 片段底 + 12
    }
  });

  it('成员盒缺失（墓碑/折叠隐藏）→ 以现存盒收敛；全缺 → 概要不出盒', () => {
    // s2 删除（core repair 后 nodeIds 已收敛，此处钉引擎对缺盒成员的确定性处理）
    const defs = { ...SEG_DEFS, s2: { text: '周三', deleted: true } };
    const partial = layout(makeReader(defs, [{ id: 'sm1', nodeIds: ['s1', 's3'], label: 'L' }]), {
      structure: 'logic',
      theme,
      measure: stubAdapter,
      styleOf,
    });
    expect(partial.summaries).toHaveLength(1);
    const b1 = boxOf(partial, 's1');
    const b3 = boxOf(partial, 's3');
    expect(partial.summaries[0]?.x).toBe(Math.min(b1.x, b3.x) - 8);
    // 全部成员无盒 → 不输出该概要
    const gone = layout(
      makeReader(
        { root: { text: '根', children: ['s1'] } },
        [{ id: 'sm2', nodeIds: ['s9', 's10'], label: 'L' }],
      ),
      { structure: 'logic', theme, measure: stubAdapter, styleOf },
    );
    expect(gone.summaries).toHaveLength(0);
  });

  it('无概要（reader 不带 summaries 方法或空数组）→ summaries=[]；多概要按 id 升序输出', () => {
    const noMethod = layout(makeReader(SEG_DEFS), {
      structure: 'mindmap',
      theme,
      measure: stubAdapter,
      styleOf,
    });
    expect(noMethod.summaries).toEqual([]);
    const empty = layout(makeReader(SEG_DEFS, []), { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    expect(empty.summaries).toEqual([]);
    const multi = layout(
      makeReader(SEG_DEFS, [
        { id: 'smB', nodeIds: ['s3'], label: 'b' },
        { id: 'smA', nodeIds: ['s1'], label: 'a' },
      ]),
      { structure: 'mindmap', theme, measure: stubAdapter, styleOf },
    );
    expect(multi.summaries.map((s) => s.id)).toEqual(['smA', 'smB']);
  });

  it('概要不改既有输出：nodes/edges/collapsedCounts/bbox 与无概要时逐项一致（只增不改）', () => {
    for (const structure of STRUCTURES) {
      const plain = layout(makeReader(SEG_DEFS), { structure, theme, measure: stubAdapter, styleOf });
      const withSum = layout(makeReader(SEG_DEFS, [{ id: 'sm1', nodeIds: ['s1', 's2'], label: 'L' }]), {
        structure,
        theme,
        measure: stubAdapter,
        styleOf,
      });
      expect(withSum.nodes).toEqual(plain.nodes);
      expect(withSum.edges).toEqual(plain.edges);
      expect(withSum.collapsedCounts).toEqual(plain.collapsedCounts);
      expect(withSum.width).toBe(plain.width);
      expect(withSum.height).toBe(plain.height);
    }
  });
});

// ---------------------------------------------------------------------------
// 确定性与金样
// ---------------------------------------------------------------------------

function serialize(result: LayoutResult): string {
  const counts = [...result.collapsedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${JSON.stringify(
    {
      nodes: result.nodes.map((n) => ({
        id: n.id,
        x: n.x,
        y: n.y,
        w: n.w,
        h: n.h,
        side: n.side,
        depth: n.depth,
        parentId: n.parentId ?? null, // Task 8 起金样含 parentId（根为 null）
      })),
      edges: result.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, controls: e.controls ?? null })),
      collapsedCounts: Object.fromEntries(counts),
      summaries: result.summaries.map((s) => ({ id: s.id, x: s.x, y: s.y, w: s.w, label: s.label })), // M6 T6 起金样含概要
      width: result.width,
      height: result.height,
    },
    null,
    2,
  )}\n`;
}

/** 金样树：固定 3 层（根 → 3 分支 → 叶），覆盖图标槽与 7 字长文本。 */
function goldenReader(): DocReader {
  return makeReader({
    root: { text: '中心主题', children: ['g1', 'g2', 'g3'] },
    g1: { text: '分支一', children: ['ga', 'gb'] },
    ga: { text: '叶子甲', icons: { other: ['done'] } },
    gb: { text: '叶子乙' },
    g2: { text: '分支二', children: ['gc'] },
    gc: { text: '长文本节点内容' },
    g3: { text: '分支三' },
  });
}

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), 'goldens');

describe('layout 确定性与金样', () => {
  it('同一输入两次布局（含独立 reader 实例）逐字节一致', () => {
    for (const structure of STRUCTURES) {
      for (const treeName of TREE_NAMES) {
        const a = layout((TREE_BUILDERS[treeName] as () => DocReader)(), { structure, theme, measure: stubAdapter, styleOf });
        const b = layout((TREE_BUILDERS[treeName] as () => DocReader)(), { structure, theme, measure: stubAdapter, styleOf });
        expect(serialize(a)).toBe(serialize(b));
      }
    }
  });

  it('缺省 styleOf：主题派生样式（根 20px）可用且确定', () => {
    const a = layout(goldenReader(), { structure: 'mindmap', theme, measure: stubAdapter });
    const b = layout(goldenReader(), { structure: 'mindmap', theme, measure: stubAdapter });
    expect(serialize(a)).toBe(serialize(b));
    expect(a.nodes).toHaveLength(7);
    const root = boxOf(a, 'root');
    expect(root.h).toBe(20); // 缺省根样式 fontSize 20 × lineHeightRatio 1
  });

  for (const structure of STRUCTURES) {
    it(`金样 ${structure}.json${process.env.UPDATE_GOLDENS === '1' ? '（更新模式）' : ''}`, () => {
      const result = layout(goldenReader(), { structure, theme, measure: stubAdapter, styleOf });
      const json = serialize(result);
      const file = join(GOLDEN_DIR, `${structure}.json`);
      if (process.env.UPDATE_GOLDENS === '1') {
        mkdirSync(GOLDEN_DIR, { recursive: true });
        writeFileSync(file, json, 'utf8');
        return;
      }
      expect(json, `金样不一致：${file}（UPDATE_GOLDENS=1 重新生成）`).toBe(readFileSync(file, 'utf8'));
    });
  }

  // Task 12（T6 carry-in 裁决）：布局盒高必须计入图片高度。金样树不含图片（金样不变），
  // 此不变量用例钉死含图节点：盒高 ≥ 图高、盒宽 ≥ 图宽 + 2×内边距。
  it('图片节点：盒高计入图片高度（h = max(文本高, 图高)）', () => {
    const reader = makeReader({
      root: { text: '根', children: ['img'] },
      img: { text: '图', image: { key: 'files/f/x.png', w: 16, h: 64 } },
    });
    const result = layout(reader, { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    const box = boxOf(result, 'img');
    expect(box.h).toBe(64); // 文本高 20（fontSize 20 × ratio 1）< 图高 64 → 图高主导
    expect(box.w).toBeGreaterThanOrEqual(16 + theme.nodePaddingX * 2); // 图自左内边距起绘制
    // 无图文本节点不受影响（文本高主导）
    const plain = boxOf(result, 'root');
    expect(plain.h).toBe(20);
  });

  // M7c-C2 任务信息行槽位（只增不改）：有任务信息的节点盒高加任务行、宽保底任务行
  // 内容；无任务信息节点（含 todo 全缺省）几何与旧版逐字节一致（金样树无 task 数据）。
  it('任务节点：盒高加任务行、宽保底任务行；无任务信息节点几何不变', () => {
    const result = layout(
      makeReader({
        root: { text: '根', children: ['t', 'p', 'q'] },
        t: { text: '叶', task: { status: 'doing', progress: 40 } },
        p: { text: '父', children: ['c1', 'c2'], task: { owners: ['u1', 'u2'] } },
        c1: { text: '甲', task: { progress: 30 } },
        c2: { text: '乙', task: { progress: 50 } },
        q: { text: '纯', task: { status: 'todo' } }, // 全缺省 = 无任务信息
      }),
      { structure: 'mindmap', theme, measure: stubAdapter, styleOf },
    );
    // 叶（有任务信息）：h = 20 + TASK_ROW_H
    expect(boxOf(result, 't').h).toBe(20 + TASK_ROW_H);
    // 父（有任务信息）：恒预留 Σ 进度槽 → 宽保底 owners 2 + 进度（无日期）
    const pRow = { owners: 2, showProgress: true, hasDue: false };
    expect(boxOf(result, 'p').h).toBe(20 + TASK_ROW_H);
    expect(boxOf(result, 'p').w).toBeGreaterThanOrEqual(taskRowContentWidth(pRow));
    // todo 全缺省：零槽位，几何不变（'纯' 10px + 2×12 = 34，被 minNodeWidth 40 抬底）
    expect(boxOf(result, 'q').h).toBe(20);
    expect(boxOf(result, 'q').w).toBe(Math.max(10 + theme.nodePaddingX * 2, theme.minNodeWidth));
    expect(boxOf(result, 'root').h).toBe(20);
  });
});
