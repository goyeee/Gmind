import { describe, expect, it } from 'vitest';
import { SelectionModel, navigate, siblingEnd } from './selection';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 手工精构 NodeBox[]（场景坐标，几何对应 T4 金样的 mindmap 形态：H_GAP 40 逐层外扩）。
// ---------------------------------------------------------------------------

function box(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  side: NodeBox['side'],
  depth: number,
  parentId?: string,
): NodeBox {
  return { id, x, y, w, h, side, depth, parentId };
}

/**
 * mindmap 手工布局（中心均标注）：
 *   root  (0,0)                    [-32,-10,64,20]
 *   r1    (99,-40)  右一级          [72,-50,54,20]
 *   r2    (99, 40)  右一级          [72, 30,54,20]
 *   l1    (-99, 0)  左一级          [-126,-10,54,20]
 *   r1a   (193,-57) r1 之子         [166,-67,54,20]
 *   r1b   (193,-23) r1 之子         [166,-33,54,20]
 *   r2a   (193, 40) r2 之子         [166, 30,54,20]
 *   rr    (99, 90)  右一级（跨侧诱饵）
 */
const MINDMAP: NodeBox[] = [
  box('root', -32, -10, 64, 20, 'right', 0),
  box('r1', 72, -50, 54, 20, 'right', 1, 'root'),
  box('r2', 72, 30, 54, 20, 'right', 1, 'root'),
  box('l1', -126, -10, 54, 20, 'left', 1, 'root'),
  box('r1a', 166, -67, 54, 20, 'right', 2, 'r1'),
  box('r1b', 166, -33, 54, 20, 'right', 2, 'r1'),
  box('r2a', 166, 30, 54, 20, 'right', 2, 'r2'),
  box('rr', 72, 80, 54, 20, 'right', 1, 'root'),
];

/**
 * org 手工布局（root 下一层两兄弟，各一子；层间纵向、兄弟横向）：
 *   root (0,0)     [-40,-15,80,30]
 *   o1   (-60,44)  [-90,29,60,30]
 *   o2   (60,44)   [ 30,29,60,30]
 *   o1a  (-60,88)  [-90,73,60,30]
 *   o2a  (60,88)   [ 30,73,60,30]
 */
const ORG: NodeBox[] = [
  box('root', -40, -15, 80, 30, 'down', 0),
  box('o1', -90, 29, 60, 30, 'down', 1, 'root'),
  box('o2', 30, 29, 60, 30, 'down', 1, 'root'),
  box('o1a', -90, 73, 60, 30, 'down', 2, 'o1'),
  box('o2a', 30, 73, 60, 30, 'down', 2, 'o2'),
];

// ---------------------------------------------------------------------------
// SelectionModel：加减选 / onChange 副本 / clear / selectOnly
// ---------------------------------------------------------------------------

describe('SelectionModel 基础加减选', () => {
  it('toggle 加选与减选互不影响他人', () => {
    const m = new SelectionModel();
    m.toggle('a');
    m.toggle('b');
    expect([...m.selected].sort()).toEqual(['a', 'b']);
    m.toggle('a'); // 减选 a，b 不受影响
    expect([...m.selected]).toEqual(['b']);
    m.toggle('b');
    expect(m.selected.size).toBe(0);
  });

  it('onChange 每次实际变化触发一次，参数是副本（外部改动不回灌模型）', () => {
    const m = new SelectionModel();
    const seen: Set<string>[] = [];
    m.onChange = (s) => seen.push(s);
    m.toggle('a');
    m.toggle('a'); // 减选，同样触发
    m.toggle('a');
    expect(seen).toHaveLength(3);
    expect([...seen[1]]).toEqual([]);
    // 外部修改回调收到的副本不影响模型内部状态。
    seen[2]?.add('ghost');
    expect(m.selected.has('ghost')).toBe(false);
    expect(m.selected.size).toBe(1);
  });

  it('set 整体替换；内容未变时不触发 onChange', () => {
    const m = new SelectionModel();
    let fired = 0;
    m.onChange = () => {
      fired += 1;
    };
    m.set(['a', 'b']);
    expect(fired).toBe(1);
    m.set(['b', 'a']); // 同内容（顺序无关）→ 不触发
    expect(fired).toBe(1);
    m.set(['c']); // 替换
    expect(fired).toBe(2);
    expect([...m.selected]).toEqual(['c']);
  });

  it('clear 清空并触发；selectOnly 单选替换', () => {
    const m = new SelectionModel();
    const seen: number[] = [];
    m.onChange = (s) => seen.push(s.size);
    m.set(['a', 'b']);
    m.selectOnly('c');
    expect([...m.selected]).toEqual(['c']);
    m.clear();
    expect(m.selected.size).toBe(0);
    m.clear(); // 空上清空 → 无变化不触发
    expect(seen).toEqual([2, 1, 0]);
  });
});

// ---------------------------------------------------------------------------
// 框选（FR-EDT-008：bbox 相交即入选，含边界；拖动过程不触发 onChange）
// ---------------------------------------------------------------------------

describe('SelectionModel 框选', () => {
  const boxes: NodeBox[] = [
    box('m1', 0, 0, 40, 20, 'right', 1),
    box('m2', 50, 10, 40, 20, 'right', 1),
    box('m3', 100, 40, 40, 20, 'right', 1),
    box('m4', 140, 80, 40, 20, 'right', 1), // 仅部分相交
    box('m5', 200, 0, 40, 20, 'right', 1), // 框外
  ];

  it('endMarquee 选出相交节点：3 个全中 + 1 个部分相交，框外不选', () => {
    const m = new SelectionModel();
    m.beginMarquee(10, -10);
    m.updateMarquee(150, 90);
    const hits = m.endMarquee(boxes);
    expect(hits).toEqual(['m1', 'm2', 'm3', 'm4']); // 文档（boxes）序
    expect([...m.selected]).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(m.selected.has('m5')).toBe(false);
  });

  it('反向拖拽归一化矩形；marqueeRect 跟踪 update；结束后为 null', () => {
    const m = new SelectionModel();
    expect(m.marqueeRect()).toBeNull();
    m.beginMarquee(150, 90);
    m.updateMarquee(10, -10);
    expect(m.marqueeRect()).toEqual({ x: 10, y: -10, w: 140, h: 100 });
    m.updateMarquee(20, 0);
    expect(m.marqueeRect()).toEqual({ x: 20, y: 0, w: 130, h: 90 });
    m.endMarquee(boxes);
    expect(m.marqueeRect()).toBeNull();
    expect(m.isMarquee).toBe(false);
  });

  it('拖动过程不触发 onChange，endMarquee 恰好触发一次并整体替换旧选区', () => {
    const m = new SelectionModel();
    m.selectOnly('m5');
    const sizes: number[] = [];
    m.onChange = (s) => sizes.push(s.size);
    m.beginMarquee(10, -10);
    m.updateMarquee(60, 20);
    m.updateMarquee(150, 90);
    expect(sizes).toEqual([]); // 拖动中页面自绘矩形，模型不广播
    m.endMarquee(boxes);
    expect(sizes).toEqual([4]);
    expect(m.selected.has('m5')).toBe(false);
  });

  it('相接即相交（含边界）：矩形右缘恰好贴住盒子左缘仍入选', () => {
    const m = new SelectionModel();
    m.beginMarquee(0, 0);
    m.updateMarquee(40, 20);
    expect(m.endMarquee([box('edge', 40, 0, 20, 10, 'right', 1)])).toEqual(['edge']);
  });

  it('未 begin 直接 endMarquee 是无操作：返回当前选区且不触发', () => {
    const m = new SelectionModel();
    m.set(['m1']);
    let fired = 0;
    m.onChange = () => {
      fired += 1;
    };
    expect(m.endMarquee(boxes)).toEqual(['m1']);
    expect(fired).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// navigate（FR-EDT-006：结构几何方向匹配的最近节点；无匹配不动）
// ---------------------------------------------------------------------------

describe('navigate：null 焦点与防御', () => {
  const directions = ['up', 'down', 'left', 'right'] as const;

  it('null 焦点 → 任意方向回 root', () => {
    for (const d of directions) {
      expect(navigate(null, d, MINDMAP, 'mindmap')).toBe('root');
    }
  });

  it('焦点不在盒集 → null；无候选 → null（无匹配不动）', () => {
    expect(navigate('ghost', 'left', MINDMAP, 'mindmap')).toBeNull();
    // rr 之下再无节点。
    expect(navigate('rr', 'down', MINDMAP, 'mindmap')).toBeNull();
    // 只有根：任何方向都无候选。
    const onlyRoot = [box('root', -32, -10, 64, 20, 'right', 0)];
    for (const d of directions) {
      expect(navigate('root', d, onlyRoot, 'mindmap')).toBeNull();
    }
  });
});

describe('navigate：mindmap 水平方向（左→父侧、右→子侧，几何自然涌现）', () => {
  it('root 向右 → 最近一级右子（同距取 lateral 小者、文档序稳定）', () => {
    expect(navigate('root', 'right', MINDMAP, 'mindmap')).toBe('r1');
  });

  it('右一级向左 → root（同带兄弟因横向重叠被排除）', () => {
    expect(navigate('r1', 'left', MINDMAP, 'mindmap')).toBe('root');
  });

  it('右一级向右 → 其子（同距取 lateral 小者、文档序稳定）', () => {
    expect(navigate('r1', 'right', MINDMAP, 'mindmap')).toBe('r1a');
  });

  it('左侧节点向左 → 更左侧（左侧子树随深度向左生长）', () => {
    const left = [
      box('root', -32, -10, 64, 20, 'right', 0),
      box('l1', -126, -10, 54, 20, 'left', 1, 'root'),
      box('l1a', -220, -27, 54, 20, 'left', 2, 'l1'),
      box('l1b', -220, 7, 54, 20, 'left', 2, 'l1'),
    ];
    // l1 向左：l1a/l1b 同距 94 → lateral 相同 → 文档序取 l1a。
    expect(navigate('l1', 'left', left, 'mindmap')).toBe('l1a');
    // l1a 向右 → l1（父侧）；root 在更右但更远。
    expect(navigate('l1a', 'right', left, 'mindmap')).toBe('l1');
  });
});

describe('navigate：mindmap 垂直方向（同侧内取纵向最近；跨侧不动）', () => {
  it('向上取同侧纵向最近者', () => {
    // r2a (193,40) 上方候选（同侧、纵向完全让位）：root 40、r1b 63、r1 80、r1a 97 → root 最近。
    expect(navigate('r2a', 'up', MINDMAP, 'mindmap')).toBe('root');
  });

  it('向下取同侧纵向最近者', () => {
    // r1b (193,-23) 下方候选：root 23、r2 63、r2a 63、rr 113 → root 最近。
    expect(navigate('r1b', 'down', MINDMAP, 'mindmap')).toBe('root');
  });

  it('跨侧诱饵不选：l1 向下，几何上更近的右侧节点因分侧限制被排除 → null', () => {
    // 下方候选 r2(30)/r2a(30)/rr(90) 全在右侧；l1 在左侧 → mindmap 无匹配。
    expect(navigate('l1', 'down', MINDMAP, 'mindmap')).toBeNull();
    // 同一几何在 logic（不分侧）下正常命中 → 限制确为 mindmap 专属。
    expect(navigate('l1', 'down', MINDMAP, 'logic')).toBe('r2');
  });
});

describe('navigate：org（上下沿层级轴、左右限兄弟带）', () => {
  it('父向下 → 子；同距两子取 lateral 小者（父对齐中间子带）', () => {
    expect(navigate('root', 'down', ORG, 'org')).toBe('o1');
  });

  it('子向上 → 父（同距候选中 lateral 最小；跨带更远者被横向惩罚）', () => {
    // o1a (−60,88) 上方：o1 44/lateral 0、o2 44/lateral 120、root 88/lateral 60 → o1。
    expect(navigate('o1a', 'up', ORG, 'org')).toBe('o1');
  });

  it('左右在兄弟带内移动：右→右兄弟；无兄弟侧→ null', () => {
    expect(navigate('o1', 'right', ORG, 'org')).toBe('o2');
    expect(navigate('o1', 'left', ORG, 'org')).toBeNull(); // 左无兄弟，父/子不同层不算
    expect(navigate('o2', 'right', ORG, 'org')).toBeNull();
    expect(navigate('o1a', 'right', ORG, 'org')).toBe('o2a');
  });

  it('顶端向上、底端向下均无匹配 → null', () => {
    expect(navigate('root', 'up', ORG, 'org')).toBeNull();
    expect(navigate('o1a', 'down', ORG, 'org')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// siblingEnd（Home/End 同级首末；boxes 文档序即同级序）
// ---------------------------------------------------------------------------

describe('siblingEnd', () => {
  it('mindmap：同级首末按文档序（即纵向序）', () => {
    expect(siblingEnd('r1', MINDMAP, 'first')).toBe('r1');
    expect(siblingEnd('r1', MINDMAP, 'last')).toBe('rr'); // root 之子（文档序）：r1, r2, l1, rr
    expect(siblingEnd('r1a', MINDMAP, 'first')).toBe('r1a');
    expect(siblingEnd('r1a', MINDMAP, 'last')).toBe('r1b');
    expect(siblingEnd('r1b', MINDMAP, 'first')).toBe('r1a');
  });

  it('org：同级首末按文档序（即横向序）', () => {
    expect(siblingEnd('o1', ORG, 'first')).toBe('o1');
    expect(siblingEnd('o1', ORG, 'last')).toBe('o2');
    expect(siblingEnd('o1a', ORG, 'first')).toBe('o1a'); // 独子：首末皆己
    expect(siblingEnd('o1a', ORG, 'last')).toBe('o1a');
    expect(siblingEnd('o2a', ORG, 'first')).toBe('o2a');
  });

  it('根（无 parentId）与未知 id → null', () => {
    expect(siblingEnd('root', MINDMAP, 'first')).toBeNull();
    expect(siblingEnd('ghost', MINDMAP, 'last')).toBeNull();
  });
});
