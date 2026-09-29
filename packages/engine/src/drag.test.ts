import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragController, type DropTarget } from './drag';
import { Viewport } from './viewport';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 固定桩：恒等视口（jsdom rect 全 0 → scene == client 坐标）
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 测试盒几何（M7c-D1 落点三分）：a=拖拽源；b/d=合法目标（根 r 的子级）；c=a 的
 * 后代（禁止目标）；r=根（无 parentId，整盒=变子级）；s=org 竖排兄弟锚（父 q）。
 */
const BOXES: NodeBox[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'b', x: 200, y: 100, w: 100, h: 40, side: 'right', depth: 2, parentId: 'r' },
  { id: 'c', x: 10, y: 60, w: 80, h: 30, side: 'right', depth: 2, parentId: 'a' },
  { id: 'd', x: 400, y: 300, w: 100, h: 40, side: 'right', depth: 2, parentId: 'r' },
  { id: 'r', x: -160, y: -120, w: 80, h: 40, side: 'right', depth: 0 },
  { id: 's', x: 200, y: 200, w: 80, h: 40, side: 'down', depth: 2, parentId: 'q' },
];
/** 文档子级序桩：childrenIdsOf 的返回（r 下 a/b/d 顺序即兄弟序判定基准）。 */
const CHILDREN: Record<string, string[]> = { r: ['a', 'b', 'd'], a: ['c'], q: ['s', 't'] };
/** 各节点的后代表：isDescendant 桩数据。 */
const DESCENDANTS: Record<string, string[]> = { a: ['c'] };

/** 各盒中心（命中检测用坐标）。 */
const CENTER: Record<string, { x: number; y: number }> = {
  a: { x: 50, y: 20 },
  b: { x: 250, y: 120 },
  c: { x: 50, y: 75 },
  d: { x: 450, y: 320 },
  r: { x: -120, y: -100 },
  s: { x: 240, y: 220 },
};
/** b 盒边缘插入带代表点：上缘带 10%（before）与下缘带 90%（after）。 */
const B_BAND = {
  before: { x: 250, y: 104 },
  after: { x: 250, y: 136 },
};
/** s 盒（org，side='down'）边缘插入带：左缘 10% / 右缘 90%。 */
const S_BAND = {
  before: { x: 208, y: 220 },
  after: { x: 272, y: 220 },
};

let svg: SVGSVGElement;
let sceneRoot: SVGGElement;
let overlay: SVGGElement;
let vp: Viewport;
let onDrop: ReturnType<typeof vi.fn>;
let controller: DragController;

beforeEach(() => {
  document.body.innerHTML = '';
  svg = document.createElementNS(SVG_NS, 'svg');
  sceneRoot = document.createElementNS(SVG_NS, 'g');
  overlay = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(sceneRoot);
  svg.appendChild(overlay);
  document.body.appendChild(svg);
  for (const b of BOXES) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-node-id', b.id);
    const rect = document.createElementNS(SVG_NS, 'rect');
    g.appendChild(rect);
    sceneRoot.appendChild(g);
  }
  vp = new Viewport(svg, sceneRoot);
  onDrop = vi.fn();
  controller = new DragController();
  controller.attach({
    svg,
    viewport: vp,
    getBoxes: () => BOXES,
    onDrop: (id, target) => onDrop(id, target),
    isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
    childrenIdsOf: (id) => CHILDREN[id] ?? [],
    overlayLayer: overlay,
  });
});

afterEach(() => {
  vi.useRealTimers();
  controller.destroy();
});

function nodeEl(id: string): SVGGElement {
  const el = svg.querySelector(`g[data-node-id="${id}"]`);
  if (!el) throw new Error(`node ${id} 不存在`);
  return el as SVGGElement;
}

function indicatorEl(): SVGLineElement | null {
  return overlay.querySelector('line.gm-drop-indicator');
}

function pe(type: string, init: PointerEventInit & { cancelable?: boolean }): PointerEvent {
  const { cancelable = true, ...rest } = init;
  return new PointerEvent(type, { bubbles: true, cancelable, ...rest });
}

/** 完整拖拽序列：down 于 a 中心 → 一步 move 到 (x,y) → 推进 holdMs → up 于同点。 */
function dragTo(x: number, y: number, holdMs: number): void {
  nodeEl('a').dispatchEvent(
    pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
  );
  svg.dispatchEvent(pe('pointermove', { clientX: x, clientY: y, pointerId: 1 }));
  vi.advanceTimersByTime(holdMs);
  svg.dispatchEvent(pe('pointerup', { clientX: x, clientY: y, pointerId: 1 }));
}

/** 兄弟顺序结算模拟：按引擎回报的 (parentId,index) 对桩数组做「先移除 a 再插入」。 */
function applyTarget(target: DropTarget, children: Record<string, string[]>): void {
  if (!target || target.kind !== 'sibling') return;
  const arr = children[target.parentId];
  const from = arr.indexOf('a');
  if (from !== -1) arr.splice(from, 1);
  arr.splice(target.index, 0, 'a');
}

// ---------------------------------------------------------------------------
// 落点分类与释放结算（M7c-D1 spec P0-2 三分语义）
// ---------------------------------------------------------------------------

describe('DragController 落点分类与释放结算（M7c-D1）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('本体中线释放 → {kind:"child", nodeId:"b"}（变其子级，追加末尾）', () => {
    dragTo(CENTER.b.x, CENTER.b.y, 150);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', { kind: 'child', nodeId: 'b' });
  });

  it('快速释放（未满 100ms）同样按几何落点结算（根治旧「未满时长→浮动到根」陷阱）', () => {
    dragTo(CENTER.b.x, CENTER.b.y, 0);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', { kind: 'child', nodeId: 'b' });
  });

  it('上缘插入带 → sibling before b：同父移除修正后 index=0（a 本就在 b 前，顺序不变）', () => {
    dragTo(B_BAND.before.x, B_BAND.before.y, 150);
    expect(onDrop).toHaveBeenCalledWith('a', {
      kind: 'sibling',
      parentId: 'r',
      index: 0,
      anchorId: 'b',
      position: 'before',
    });
    const children: Record<string, string[]> = { r: ['a', 'b', 'd'], a: ['c'], q: ['s', 't'] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.r).toEqual(['a', 'b', 'd']); // 前插：兄弟顺序不变
  });

  it('下缘插入带 → sibling after b：同父移除修正后 index=1（a 落到 b 后）', () => {
    dragTo(B_BAND.after.x, B_BAND.after.y, 150);
    expect(onDrop).toHaveBeenCalledWith('a', {
      kind: 'sibling',
      parentId: 'r',
      index: 1,
      anchorId: 'b',
      position: 'after',
    });
    const children: Record<string, string[]> = { r: ['a', 'b', 'd'], a: ['c'], q: ['s', 't'] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.r).toEqual(['b', 'a', 'd']); // 后插：a 越过 b
  });

  it('拖到末尾兄弟之后 → sibling after d：index=2，释放后 a 排最后', () => {
    dragTo(CENTER.d.x, 336, 150); // d 下缘带（d: y=300,h=40 → 336 = 90% 位）
    expect(onDrop).toHaveBeenCalledWith('a', {
      kind: 'sibling',
      parentId: 'r',
      index: 2,
      anchorId: 'd',
      position: 'after',
    });
    const children: Record<string, string[]> = { r: ['a', 'b', 'd'], a: ['c'], q: ['s', 't'] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.r).toEqual(['b', 'd', 'a']);
  });

  it('跨父插入不做同父修正：org 盒 s（父 q）右缘带 → sibling after s，index=1', () => {
    dragTo(S_BAND.after.x, S_BAND.after.y, 150);
    expect(onDrop).toHaveBeenCalledWith('a', {
      kind: 'sibling',
      parentId: 'q',
      index: 1,
      anchorId: 's',
      position: 'after',
    });
  });

  it('根盒（无 parentId）任意位置（含上缘带）→ 整盒=变其子级', () => {
    dragTo(CENTER.r.x, -116, 150); // 根盒上缘带（r: y=-120 → -116 = 10% 位）也判 child
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', { kind: 'child', nodeId: 'r' });
  });

  it('空白释放 → onDrop(id, null)（浮动主题，页面层 moveNode(id, "root")）', () => {
    dragTo(650, 480, 500);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null);
  });

  it('后代目标（本体/边缘带均禁止）：加 drop-forbidden、释放不回调、抬起后高亮清除', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: CENTER.c.x, clientY: CENTER.c.y + 12, pointerId: 1 }), // c 上缘带位
    );
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('c').classList.contains('drop-target')).toBe(false);
    expect(indicatorEl()).toBeNull(); // 禁止目标不出指示线
    vi.advanceTimersByTime(400);
    svg.dispatchEvent(
      pe('pointerup', { clientX: CENTER.c.x, clientY: CENTER.c.y + 12, pointerId: 1 }),
    );
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(false);
  });

  it('自命中（自身盒）：drop-forbidden 反馈、释放静默取消不回调', () => {
    // fix round 1：自身释放若落入 null 分支会把整枝浮动成根主题（破坏性），
    // 裁决改为与后代同待遇——静默取消。
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 80, clientY: 30, pointerId: 1 })); // 仍在 a 盒内
    expect(nodeEl('a').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('a').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(400); // 即便悬停再久也不允许
    svg.dispatchEvent(pe('pointerup', { clientX: 80, clientY: 30, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('a').classList.contains('drop-forbidden')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 插入指示线（gm-drop-indicator）
// ---------------------------------------------------------------------------

describe('DragController 插入指示线（gm-drop-indicator）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('进入横排盒上缘带 100ms → 悬浮层出现横线，y=盒顶、两端外伸 8px', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 1 }),
    );
    expect(indicatorEl()).toBeNull(); // 未满 100ms 不出现
    vi.advanceTimersByTime(100);
    const line = indicatorEl();
    expect(line).not.toBeNull();
    expect(line!.getAttribute('y1')).toBe('100'); // b.y
    expect(line!.getAttribute('y2')).toBe('100');
    expect(line!.getAttribute('x1')).toBe('192'); // b.x - 8
    expect(line!.getAttribute('x2')).toBe('308'); // b.x + b.w + 8
  });

  it('切到下缘带 → 指示线随动到盒底（y=140）；切回本体 → 移除指示线、点亮 drop-target', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: B_BAND.after.x, clientY: B_BAND.after.y, pointerId: 1 }),
    );
    vi.advanceTimersByTime(100);
    expect(indicatorEl()!.getAttribute('y1')).toBe('140'); // b.y + b.h
    // 同一节点带→本体互切也重置反馈：先摘线，满 100ms 后点亮高亮
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(indicatorEl()).toBeNull();
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
  });

  it('移开到空白/释放/pointercancel/destroy → 指示线移除', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 1 }),
    );
    vi.advanceTimersByTime(100);
    expect(indicatorEl()).not.toBeNull();
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 })); // 空白
    expect(indicatorEl()).toBeNull();
    svg.dispatchEvent(pe('pointerup', { clientX: 650, clientY: 480, pointerId: 1 })); // 结束第一段拖拽
    // 释放路径
    nodeEl('a').dispatchEvent(pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 2 }));
    svg.dispatchEvent(pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 2 }));
    vi.advanceTimersByTime(100);
    expect(indicatorEl()).not.toBeNull();
    svg.dispatchEvent(
      pe('pointerup', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 2 }),
    );
    expect(indicatorEl()).toBeNull();
    // pointercancel 路径
    nodeEl('a').dispatchEvent(pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 3 }));
    svg.dispatchEvent(pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 3 }));
    vi.advanceTimersByTime(100);
    expect(indicatorEl()).not.toBeNull();
    svg.dispatchEvent(pe('pointercancel', { pointerId: 3 }));
    expect(indicatorEl()).toBeNull();
    // destroy 路径
    nodeEl('a').dispatchEvent(pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 4 }));
    svg.dispatchEvent(pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 4 }));
    vi.advanceTimersByTime(100);
    expect(indicatorEl()).not.toBeNull();
    controller.destroy();
    expect(indicatorEl()).toBeNull();
  });

  it('org（side=down）盒边缘带 → 竖线贴左/右缘、上下外伸 8px', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: S_BAND.after.x, clientY: S_BAND.after.y, pointerId: 1 }),
    );
    vi.advanceTimersByTime(100);
    const line = indicatorEl();
    expect(line).not.toBeNull();
    expect(line!.getAttribute('x1')).toBe('280'); // s.x + s.w
    expect(line!.getAttribute('x2')).toBe('280');
    expect(line!.getAttribute('y1')).toBe('192'); // s.y - 8
    expect(line!.getAttribute('y2')).toBe('248'); // s.y + s.h + 8
  });
});

// ---------------------------------------------------------------------------
// 反馈时机（300ms → 100ms，spec P0-2）
// ---------------------------------------------------------------------------

describe('DragController 反馈时机（100ms）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('drop-target 满 100ms 才点亮：50ms 未亮、100ms 翻转、移开即灭、切换重置', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false); // 刚进入不亮
    vi.advanceTimersByTime(50);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(50); // 累计 100ms
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.d.x, clientY: CENTER.d.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false); // 移开/切换立即灭
    expect(nodeEl('d').classList.contains('drop-target')).toBe(false); // 新目标重新计时
    vi.advanceTimersByTime(100);
    expect(nodeEl('d').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 })); // 空白
    expect(nodeEl('d').classList.contains('drop-target')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 被拖节点视觉反馈（gm-dragging）
// ---------------------------------------------------------------------------

describe('DragController 被拖节点视觉反馈（gm-dragging）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** 激活拖拽：down 于 a 中心 → 一步 move 到 b 中心（过阈值即 activate）。 */
  function activateDrag(pointerId: number): void {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId }));
  }

  it('候选期（未过 4px 阈值）不挂类；过阈值激活即给被拖节点挂 gm-dragging', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 52, clientY: 21, pointerId: 1 })); // ≈2.2px
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
  });

  it('正常释放 → 摘除 gm-dragging，且任何节点不残留', () => {
    activateDrag(1);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    for (const b of BOXES) {
      expect(nodeEl(b.id).classList.contains('gm-dragging')).toBe(false);
    }
  });

  it('禁止落点静默取消 / pointercancel / svg 外释放（window 兜底）→ 均摘除', () => {
    // 自身盒 = 禁止目标：释放走静默取消路径
    activateDrag(1);
    svg.dispatchEvent(pe('pointermove', { clientX: 80, clientY: 30, pointerId: 1 })); // a 盒内
    svg.dispatchEvent(pe('pointerup', { clientX: 80, clientY: 30, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    // pointercancel 路径
    activateDrag(2);
    svg.dispatchEvent(pe('pointercancel', { pointerId: 2 }));
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    // svg 外释放（window pointerup 兜底）路径
    activateDrag(3);
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 3 }));
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
  });

  it('destroy 中途打断 → gm-dragging 摘除（不回调 onDrop）', () => {
    activateDrag(1);
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
    controller.destroy();
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('gm-dragging 与落点反馈（drop-target/drop-forbidden）互不干扰、可共存', () => {
    activateDrag(1);
    vi.advanceTimersByTime(100); // b 本体悬停满 100ms 点亮
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
    expect(nodeEl('a').classList.contains('drop-target')).toBe(false);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 原生文字拖选抑制（M7c-D1）
// ---------------------------------------------------------------------------

describe('DragController 原生拖选抑制（preventDefault）', () => {
  it('节点上 pointerdown（cancelable）→ defaultPrevented=true（文本选择不起锚）', () => {
    const e = pe('pointerdown', {
      button: 0,
      clientX: CENTER.a.x,
      clientY: CENTER.a.y,
      pointerId: 1,
    });
    nodeEl('a').dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('过阈值激活的 pointermove → defaultPrevented=true；空白 pointerdown 不抑制', () => {
    const blank = pe('pointerdown', { button: 0, clientX: 650, clientY: 480, pointerId: 1 });
    svg.dispatchEvent(blank);
    expect(blank.defaultPrevented).toBe(false);
    const down = pe('pointerdown', {
      button: 0,
      clientX: CENTER.a.x,
      clientY: CENTER.a.y,
      pointerId: 1,
    });
    nodeEl('a').dispatchEvent(down);
    const move = pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 });
    svg.dispatchEvent(move);
    expect(move.defaultPrevented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 激活阈值与生命周期
// ---------------------------------------------------------------------------

describe('DragController 激活阈值', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('位移 < 4px 即释放 → 不激活、不回调（仍是 click）', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: 50, clientY: 20, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 52, clientY: 21, pointerId: 1 })); // ≈2.2px
    svg.dispatchEvent(pe('pointerup', { clientX: 52, clientY: 21, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('DragController 边界与生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('折叠徽标 [data-for-id] 上的 pointerdown 不启动拖拽（徽标点击归页面层）', () => {
    const badge = document.createElementNS(SVG_NS, 'g');
    badge.setAttribute('data-for-id', 'a');
    const badgeRect = document.createElementNS(SVG_NS, 'rect');
    badge.appendChild(badgeRect);
    nodeEl('a').appendChild(badge); // render.ts 中徽标嵌在节点 g 内
    badgeRect.dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    vi.advanceTimersByTime(400);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('非主键（button=2）不启动拖拽', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 2, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    vi.advanceTimersByTime(400);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('pointercancel 中止拖拽：清高亮、不回调', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    vi.advanceTimersByTime(100); // 反馈满 100ms 点亮
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointercancel', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('destroy 中止进行中的拖拽：不回调且监听已移除', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    controller.destroy();
    vi.advanceTimersByTime(400);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    // 监听已移除：destroy 后再来一整段序列依旧安静
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 2 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 2 }));
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 2 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('attach 幂等：attach 两次行为如一次（onDrop 恰一次）', () => {
    controller.attach({
      svg,
      viewport: vp,
      getBoxes: () => BOXES,
      onDrop: (id, target) => onDrop(id, target),
      isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
      childrenIdsOf: (id) => CHILDREN[id] ?? [],
      overlayLayer: overlay,
    });
    dragTo(CENTER.b.x, CENTER.b.y, 150);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', { kind: 'child', nodeId: 'b' });
  });

  it('未 attach 直接 destroy 不抛错', () => {
    expect(() => new DragController().destroy()).not.toThrow();
  });

  it('svg 外释放（window pointerup）清候选不卡死：后续拖拽照常（fix round 1）', () => {
    // 候选期未捕获指针，拖出窗口后 svg 收不到 pointerup → candidate 卡死。
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 1 }));
    expect(controller.dragging).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
    // 卡死修复后：下一次 pointerdown + 拖拽照常换父。
    dragTo(CENTER.b.x, CENTER.b.y, 150);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', { kind: 'child', nodeId: 'b' });
  });

  it('拖拽激活后 svg 外释放：走同一结束逻辑（空白 → null），且不卡死', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null); // 释放点在空白 → null
    expect(controller.dragging).toBeNull();
    dragTo(CENTER.b.x, CENTER.b.y, 150);
    expect(onDrop).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenLastCalledWith('a', { kind: 'child', nodeId: 'b' });
  });

  it('destroy 释放已持有的指针捕获', () => {
    const captured: number[] = [];
    const released: number[] = [];
    Object.defineProperty(svg, 'setPointerCapture', {
      value: (id: number) => captured.push(id),
      configurable: true,
    });
    Object.defineProperty(svg, 'releasePointerCapture', {
      value: (id: number) => released.push(id),
      configurable: true,
    });
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 7 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 7 }));
    expect(captured).toEqual([7]); // 激活时捕获
    controller.destroy();
    expect(released).toEqual([7]); // destroy 释放（fix round 1 minor）
  });
});
