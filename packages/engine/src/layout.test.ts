import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout } from './layout';
import type {
  DocReader,
  LayoutResult,
  MeasureAdapter,
  NodeBox,
  NodeSnapshotLike,
  StructureType,
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
      collapsed: def.collapsed ?? false,
      deleted: def.deleted ?? false,
      icons: def.icons,
    };
  };
  return {
    getMeta: () => ({ title: '测试文档', structureType: 'mindmap', themeId: 'stub' }),
    getNode: snap,
    childrenIds: (id) => snap(id)?.childIds ?? [],
  };
}

const stubAdapter: MeasureAdapter = { measureTextLine: (text) => text.length * 10 };

const theme: ThemeTokens = {
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
      m2: { text: '图标', icons: { tag: 't', star: 's' }, collapsed: true },
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

  it('mindmap：均衡树（3 个等高一級子树）两侧均有节点，深层与一级祖先同侧', () => {
    const result = layout(TREE_BUILDERS.wide(), { structure: 'mindmap', theme, measure: stubAdapter, styleOf });
    const root = boxOf(result, 'root');
    const level1 = result.nodes.filter((n) => n.depth === 1);
    expect(level1.length).toBe(3);
    expect(level1.some((n) => n.side === 'right')).toBe(true);
    expect(level1.some((n) => n.side === 'left')).toBe(true);
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
// 确定性与金样
// ---------------------------------------------------------------------------

function serialize(result: LayoutResult): string {
  const counts = [...result.collapsedCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${JSON.stringify(
    {
      nodes: result.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, side: n.side, depth: n.depth })),
      edges: result.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, kind: e.kind, controls: e.controls ?? null })),
      collapsedCounts: Object.fromEntries(counts),
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
    ga: { text: '叶子甲', icons: { tag: 't' } },
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
});
