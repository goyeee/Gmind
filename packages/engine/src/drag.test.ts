import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragController, resolveDropSlot, type DropTarget } from './drag';
import { Viewport } from './viewport';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 固定桩：恒等视口（jsdom rect 全 0 → scene == client 坐标）
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 测试盒几何（M7c-D1 落点三分）：a=拖拽源；b/d=合法目标（根 r 的子级）；c=a 的
 * 后代（禁止目标）；r=根（无 parentId，整盒=变子级）；s=org 竖排兄弟锚（父 q，
 * M7c-D3 起补 q 盒供落位槽/预览边结算）；q=org 父盒（side down）。
 */
const BOXES: NodeBox[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'b', x: 200, y: 100, w: 100, h: 40, side: 'right', depth: 2, parentId: 'r' },
  { id: 'c', x: 10, y: 60, w: 80, h: 30, side: 'right', depth: 2, parentId: 'a' },
  { id: 'd', x: 400, y: 300, w: 100, h: 40, side: 'right', depth: 2, parentId: 'r' },
  { id: 'r', x: -160, y: -120, w: 80, h: 40, side: 'right', depth: 0 },
  { id: 's', x: 200, y: 200, w: 80, h: 40, side: 'down', depth: 2, parentId: 'q' },
  { id: 'q', x: 200, y: 150, w: 80, h: 40, side: 'down', depth: 1 },
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
  q: { x: 240, y: 170 },
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

/**
 * 根级侧别仿真桩（M7c-D3 测试②）：3 个等高 root 子级 右右左分布（r 右缘 0、
 * 右列 x=60、左列 x=-240；带高均 40、带间距均 20 → 半分阈值 80，x1/x2 右、x3 左，
 * 与布局 assignMindmapSides 对真实几何的判定一致）。
 */
const SIM_BOXES: NodeBox[] = [
  { id: 'x1', x: 60, y: -70, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'x2', x: 60, y: -10, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'x3', x: -240, y: 50, w: 100, h: 40, side: 'left', depth: 1, parentId: 'r' },
  { id: 'r', x: -80, y: -30, w: 80, h: 60, side: 'right', depth: 0 },
];
const SIM_CHILDREN: Record<string, string[]> = { r: ['x1', 'x2', 'x3'] };

interface Harness {
  svg: SVGSVGElement;
  overlay: SVGGElement;
  vp: Viewport;
  onDrop: ReturnType<typeof vi.fn>;
  controller: DragController;
}

/** 装配测试场景：节点 g（含 rect + gm-text 文字）+ 既有连线（供预览边取主题边色）。 */
function buildHarness(
  boxes: NodeBox[],
  children: Record<string, string[]>,
  descendants: Record<string, string[]>,
): Harness {
  document.body.innerHTML = '';
  const svg = document.createElementNS(SVG_NS, 'svg');
  const edgesLayer = document.createElementNS(SVG_NS, 'g');
  const canvasEdge = document.createElementNS(SVG_NS, 'path');
  canvasEdge.setAttribute('data-edge-id', `${boxes[boxes.length - 1]!.id}->probe`);
  canvasEdge.setAttribute('stroke', '#7c8496');
  edgesLayer.appendChild(canvasEdge);
  svg.appendChild(edgesLayer);
  const sceneRoot = document.createElementNS(SVG_NS, 'g');
  const overlay = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(sceneRoot);
  svg.appendChild(overlay);
  document.body.appendChild(svg);
  for (const b of boxes) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-node-id', b.id);
    const rect = document.createElementNS(SVG_NS, 'rect');
    g.appendChild(rect);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('class', 'gm-text');
    text.textContent = b.id;
    g.appendChild(text);
    sceneRoot.appendChild(g);
  }
  const vp = new Viewport(svg, sceneRoot);
  const onDrop = vi.fn();
  const controller = new DragController();
  controller.attach({
    svg,
    viewport: vp,
    getBoxes: () => boxes,
    onDrop: (id, target) => onDrop(id, target),
    isDescendant: (id, candidateId) => (descendants[id] ?? []).includes(candidateId),
    childrenIdsOf: (id) => children[id] ?? [],
    overlayLayer: overlay,
  });
  return { svg, overlay, vp, onDrop, controller };
}

let svg: SVGSVGElement;
let overlay: SVGGElement;
let vp: Viewport;
let onDrop: ReturnType<typeof vi.fn>;
let controller: DragController;

beforeEach(() => {
  ({ svg, overlay, vp, onDrop, controller } = buildHarness(BOXES, CHILDREN, DESCENDANTS));
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

/** 落位预览边/槽/芯片（M7c-D3：悬浮层内临时元素）。 */
function edgeEl(): SVGPathElement | null {
  return overlay.querySelector('path.gm-drop-edge');
}
function slotEl(): SVGRectElement | null {
  return overlay.querySelector('rect.gm-drop-slot');
}
function ghostEl(): SVGGElement | null {
  return overlay.querySelector('g.gm-drag-ghost');
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

  it('空白悬停 → 预览（root 边缘→对应侧末尾槽）+ 释放解析为 root 右侧末尾 sibling（M7c-F 复验问题4）', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 })); // 空白（650 在 r 中线 -120 右半）
    vi.advanceTimersByTime(100);
    expect(edgeEl()).not.toBeNull(); // 空白悬停不再零预览
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('200'); // 右列（与 b/d 同列）
    expect(slotEl()!.getAttribute('y')).toBe('420'); // d 底 340 + 带间距 160/2 − a.h/2 20
    // 边 = root 右缘中点 → 槽左边中点（render 同款 bezier）
    expect(edgeEl()!.getAttribute('d')).toBe('M -80 -100 C 60 -100 60 440 200 440');
    svg.dispatchEvent(pe('pointerup', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', {
      kind: 'sibling',
      parentId: 'r',
      index: 2, // 右侧（=文档序前缀）末尾：post-removal 子级 [b, d] 全右 → 2
      anchorId: 'd',
      position: 'after',
    });
  });

  it('后代目标（本体/边缘带均禁止）：加 drop-forbidden、释放不回调、无预览、抬起后高亮清除', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: CENTER.c.x, clientY: CENTER.c.y + 12, pointerId: 1 }), // c 上缘带位
    );
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('c').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(400);
    expect(edgeEl()).toBeNull(); // 禁止目标无边/槽预览
    expect(slotEl()).toBeNull();
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
// 落位预览：真实边 + 落位槽（M7c-D3，取代旧 gm-drop-indicator 横向指示线）
// ---------------------------------------------------------------------------

describe('DragController 落位预览（gm-drop-edge / gm-drop-slot）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('进入上缘带满 100ms → 真实边 + 槽出现：槽=首盒上方同列，边=父盒边中点到槽边中点的同款 bezier', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 1 }),
    );
    expect(edgeEl()).toBeNull(); // 未满 100ms 不出现
    expect(slotEl()).toBeNull();
    vi.advanceTimersByTime(100);
    const slot = slotEl();
    const edge = edgeEl();
    expect(slot).not.toBeNull();
    expect(edge).not.toBeNull();
    // 槽列 x = r 右缘(-80) + 列距 280（= b.x − r 右缘）→ 与现有子级同列 200；
    // 槽 y = b.y(100) − 带间距/2(80) − a.h/2(20) = 0（首位空隙，几何直出）。
    expect(slot!.getAttribute('x')).toBe('200');
    expect(slot!.getAttribute('y')).toBe('0');
    expect(slot!.getAttribute('width')).toBe('100');
    expect(slot!.getAttribute('height')).toBe('40');
    // 与画布普通连线同形：M 父右缘中点(-80,-100) C 水平控制点(60,±) 槽左边中点(200,20)。
    expect(edge!.getAttribute('d')).toBe('M -80 -100 C 60 -100 60 20 200 20');
    expect(edge!.getAttribute('stroke')).toBe('#7c8496'); // 与画布既有连线同色
  });

  it('切到下缘带 → 槽随动到相邻盒垂直中点（y=200）；切回本体 → 边/槽移除、点亮 drop-target', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: B_BAND.after.x, clientY: B_BAND.after.y, pointerId: 1 }),
    );
    vi.advanceTimersByTime(100);
    expect(slotEl()!.getAttribute('y')).toBe('200'); // (b 底 140 + d 顶 300)/2 = 220 − a.h/2
    // 同一节点带→本体互切也重置反馈：先摘边/槽，满 100ms 后点亮高亮
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(edgeEl()).toBeNull();
    expect(slotEl()).toBeNull();
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(100);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
  });

  it('移开到空白/释放/pointercancel/destroy → 芯片/边/槽全部移除（预览元素存在性）', () => {
    const startDrag = (pointerId: number): void => {
      nodeEl('a').dispatchEvent(
        pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId }),
      );
      svg.dispatchEvent(
        pe('pointermove', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId }),
      );
      vi.advanceTimersByTime(100);
      expect(ghostEl()).not.toBeNull();
      expect(edgeEl()).not.toBeNull();
      expect(slotEl()).not.toBeNull();
    };
    // 空白：边/槽摘除，芯片仍在（拖拽未结束）
    startDrag(1);
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(edgeEl()).toBeNull();
    expect(slotEl()).toBeNull();
    expect(ghostEl()).not.toBeNull();
    svg.dispatchEvent(pe('pointerup', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(ghostEl()).toBeNull();
    // 释放路径
    startDrag(2);
    svg.dispatchEvent(
      pe('pointerup', { clientX: B_BAND.before.x, clientY: B_BAND.before.y, pointerId: 2 }),
    );
    expect(ghostEl()).toBeNull();
    expect(edgeEl()).toBeNull();
    expect(slotEl()).toBeNull();
    // pointercancel 路径
    startDrag(3);
    svg.dispatchEvent(pe('pointercancel', { pointerId: 3 }));
    expect(ghostEl()).toBeNull();
    expect(edgeEl()).toBeNull();
    expect(slotEl()).toBeNull();
    // destroy 路径
    startDrag(4);
    controller.destroy();
    expect(ghostEl()).toBeNull();
    expect(edgeEl()).toBeNull();
    expect(slotEl()).toBeNull();
  });

  it('org（side=down）盒边缘带 → 槽在水平插入位、边为竖直 elbow（与真实 org 连线同形）', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(
      pe('pointermove', { clientX: S_BAND.after.x, clientY: S_BAND.after.y, pointerId: 1 }),
    );
    vi.advanceTimersByTime(100);
    const slot = slotEl();
    const edge = edgeEl();
    expect(slot).not.toBeNull();
    expect(edge).not.toBeNull();
    // 尾部追加：cx = s 右缘(280) + 间距/2(10) + a.w/2(50) → 槽 x 290；y = q 底(190) + 层距(10)。
    expect(slot!.getAttribute('x')).toBe('290');
    expect(slot!.getAttribute('y')).toBe('200');
    // elbow：父下中点(240,190) → 槽顶中(340,200)，正交中线拐点（render 同公式）。
    expect(edge!.getAttribute('d')).toBe('M 240 190 L 240 195 L 340 195 L 340 200');
  });
});

// ---------------------------------------------------------------------------
// 落位槽纯函数（resolveDropSlot：槽几何 + 根级侧别仿真）
// ---------------------------------------------------------------------------

describe('resolveDropSlot 落位槽几何（M7c-D3 纯函数）', () => {
  it('中间插入 = 相邻两子级盒的垂直中点；尾部追加 = 末盒下方（间距一半）', () => {
    const mid = resolveDropSlot({
      boxes: BOXES,
      childrenIds: CHILDREN.r!,
      draggedId: 'a',
      parentId: 'r',
      index: 1,
      chipBox: { x: 200, y: 84, w: 100, h: 40 },
    });
    expect(mid).not.toBeNull();
    expect(mid!.index).toBe(1);
    expect(mid!.slot.x).toBe(200); // 与现有子级同列（r 右缘 -80 + 列距 280）
    expect(mid!.slot.y).toBe(200); // (b 底 140 + d 顶 300)/2 = 220 − a.h/2 20
    expect(mid!.slot.side).toBe('right');
    const tail = resolveDropSlot({
      boxes: BOXES,
      childrenIds: CHILDREN.r!,
      draggedId: 'a',
      parentId: 'r',
      index: 2,
      chipBox: { x: 400, y: 316, w: 100, h: 40 },
    });
    expect(tail!.index).toBe(2);
    expect(tail!.slot.y).toBe(420); // d 底 340 + 带间距 160/2 = 420（槽顶）
  });

  it('首位插入 = 首盒上方空隙（间距一半，跟随几何），槽列与现有子级同列', () => {
    const head = resolveDropSlot({
      boxes: BOXES,
      childrenIds: CHILDREN.r!,
      draggedId: 'a',
      parentId: 'r',
      index: 0,
      chipBox: { x: 200, y: 84, w: 100, h: 40 },
    });
    expect(head!.index).toBe(0);
    expect(head!.slot.y).toBe(0); // b.y 100 − 带间距/2 80 − a.h/2 20
    expect(head!.slot.x).toBe(200);
  });

  it('首位插入不做父中线钳制：首兄弟悬在父中线上方时槽中心 = 首盒上方空隙（M7c-F 复验问题1）', () => {
    // 首兄弟 k1（y=-100）悬在父 rt（y=-20..20，中线 0）上方：旧钳制把槽钳到父中线
    // （slotY=-20），与真实插入位（插首位、锚点顺移）偏离——现按几何直出。
    const boxes: NodeBox[] = [
      { id: 'k1', x: 120, y: -100, w: 100, h: 40, side: 'right', depth: 1, parentId: 'rt' },
      { id: 'rt', x: 0, y: -20, w: 80, h: 40, side: 'right', depth: 0 },
      { id: 'a', x: 400, y: 200, w: 100, h: 40, side: 'right', depth: 1, parentId: 'ot' },
      { id: 'ot', x: 380, y: 180, w: 80, h: 40, side: 'right', depth: 0 },
    ];
    const res = resolveDropSlot({
      boxes,
      childrenIds: ['k1'],
      draggedId: 'a',
      parentId: 'rt',
      index: 0,
      chipBox: { x: 120, y: -160, w: 100, h: 40 },
    });
    expect(res).not.toBeNull();
    expect(res!.index).toBe(0);
    // 槽中心 = 首盒 y − 带间距/2（单兄弟间距实测不到 → 兜底 20）= -110 ≠ 父中线 0。
    expect(res!.slot.y + res!.slot.h / 2).toBe(-110);
    expect(res!.slot.y).not.toBe(-20); // 旧钳制值（钳到父中线）不再出现
    expect(res!.slot.x).toBe(120); // 与首盒同列
  });

  it('父盒缺失（协同删除窗口期）→ null（无预览，释放仍按 target 结算）', () => {
    expect(
      resolveDropSlot({
        boxes: BOXES,
        childrenIds: ['zz'],
        draggedId: 'a',
        parentId: 'zz',
        index: 0,
        chipBox: { x: 0, y: 0, w: 100, h: 40 },
      }),
    ).toBeNull();
  });
});

describe('resolveDropSlot 根级侧别仿真（M7c-D3 不跳左）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 重装侧别仿真桩场景（右右左分布）
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(SIM_BOXES, SIM_CHILDREN, {}));
  });

  it('纯函数：几何 index 仿真翻左 → 修正到同侧（右）兄弟最接近芯片 y 的插入位，仿真侧别 right', () => {
    // 芯片在右侧低处（x2 下方 y≈80）：几何 index 2 插入后 [x2,x3,x1]，x1 累计过半翻左；
    // 修正为右列兄弟 [x2] 的 y 最近插入位（尾插 p=1 → 文档序 index 1）→ 复核仿真 right。
    const res = resolveDropSlot({
      boxes: SIM_BOXES,
      childrenIds: SIM_CHILDREN.r!,
      draggedId: 'x1',
      parentId: 'r',
      index: 2,
      chipBox: { x: 60, y: 80, w: 100, h: 40 },
    });
    expect(res).not.toBeNull();
    expect(res!.index).toBe(1); // 不按几何位次 2（会跳左）
    expect(res!.slot.side).toBe('right');
    expect(res!.slot.x).toBe(60); // 右列（r 右缘 0 + 列距 60）
    expect(res!.slot.y).toBe(40); // x2 底 30 + 带间距/2 10（槽顶）
  });

  it('DOM：右侧节点拖到右侧低处（x2 下缘带）→ 解析 index 落右、槽画在右列（不跳左）', () => {
    nodeEl('x1').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: 110, clientY: -50, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 110, clientY: 26, pointerId: 1 })); // x2 下缘带
    vi.advanceTimersByTime(100);
    const slot = slotEl();
    expect(slot).not.toBeNull();
    expect(slot!.getAttribute('x')).toBe('60'); // 右列（与 x1/x2 同列），绝不在左侧
    svg.dispatchEvent(pe('pointerup', { clientX: 110, clientY: 26, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledWith('x1', {
      kind: 'sibling',
      parentId: 'r',
      index: 1,
      anchorId: 'x2',
      position: 'after',
    });
  });

  it('空白（root 左半）→ 解析为左列末尾：槽画左列、index=文档序末尾（M7c-F 复验问题4）', () => {
    nodeEl('x1').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: 110, clientY: -50, pointerId: 1 }),
    );
    // 空白（-500 < r 中线 -40 → 指针侧 left）：仿真插入文档序末尾落在左列
    svg.dispatchEvent(pe('pointermove', { clientX: -500, clientY: 100, pointerId: 1 }));
    vi.advanceTimersByTime(100);
    const slot = slotEl();
    expect(slot).not.toBeNull(); // 空白悬停有预览
    expect(slot!.getAttribute('x')).toBe('-240'); // 左列（与 x3 同列），不在右列
    expect(slot!.getAttribute('y')).toBe('100'); // x3 底 90 + 带间距/2 10（槽顶）
    svg.dispatchEvent(pe('pointerup', { clientX: -500, clientY: 100, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledWith('x1', {
      kind: 'sibling',
      parentId: 'r',
      index: 2, // 左侧 = 文档序后缀：末尾 = post-removal 文档序末尾 [x2, x3] → 2
      anchorId: 'x3',
      position: 'after',
    });
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
// 被拖节点视觉反馈（gm-dragging + gm-drag-origin）与拖拽芯片（gm-drag-ghost）
// ---------------------------------------------------------------------------

describe('DragController 被拖节点视觉反馈与拖拽芯片（M7c-D3）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** 激活拖拽：down 于 a 中心 → 一步 move 到 (x,y)（过阈值即 activate）。 */
  function activateAt(x: number, y: number, pointerId = 1): void {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: x, clientY: y, pointerId }));
  }

  it('候选期不挂类；激活即建芯片（被拖盒大小白底蓝描边+文字）并并挂 gm-dragging/gm-drag-origin', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 52, clientY: 21, pointerId: 1 })); // ≈2.2px
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(ghostEl()).toBeNull(); // 候选期无芯片
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    const ghost = ghostEl();
    expect(ghost).not.toBeNull();
    const rect = ghost!.querySelector('rect');
    expect(rect!.getAttribute('width')).toBe('100'); // 同被拖节点盒 w/h
    expect(rect!.getAttribute('height')).toBe('40');
    expect(rect!.getAttribute('fill')).toBe('#ffffff');
    expect(rect!.getAttribute('stroke')).toBe('#3370ff');
    expect(rect!.getAttribute('stroke-width')).toBe('1.5');
    expect(ghost!.querySelector('text')!.textContent).toBe('a'); // 被拖节点文本
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
    expect(nodeEl('a').classList.contains('gm-drag-origin')).toBe(true); // 原位虚线占位
  });

  it('芯片跟随 = 指针 scene 点 + 右下偏移（screen 14px 恒定 → scene 偏移 = 14/scale）', () => {
    activateAt(CENTER.b.x, CENTER.b.y); // 指针 (250,120)，scale=1 → 偏移 14
    expect(ghostEl()!.getAttribute('transform')).toBe('translate(264, 134)');
    svg.dispatchEvent(pe('pointermove', { clientX: 300, clientY: 160, pointerId: 1 }));
    expect(ghostEl()!.getAttribute('transform')).toBe('translate(314, 174)');
    // screen 偏移恒定：scale=2 时 scene 偏移折半（7）——芯片不随缩放贴远光标
    vp.scale = 2;
    vp.apply();
    svg.dispatchEvent(pe('pointermove', { clientX: 300, clientY: 160, pointerId: 1 }));
    expect(ghostEl()!.getAttribute('transform')).toBe('translate(157, 87)');
  });

  it('禁止落点（自身/后代）→ 芯片并挂 gm-drag-ghost-forbidden（描边转红由 CSS 落地），离开即摘', () => {
    activateAt(CENTER.b.x, CENTER.b.y); // b 本体 = 合法 child 落点
    expect(ghostEl()!.classList.contains('gm-drag-ghost-forbidden')).toBe(false);
    // c = a 的后代 → 禁止目标
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.c.x, clientY: CENTER.c.y, pointerId: 1 }));
    expect(ghostEl()!.classList.contains('gm-drag-ghost-forbidden')).toBe(true);
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(ghostEl()!.classList.contains('gm-drag-ghost-forbidden')).toBe(false);
  });

  it('正常释放 → 摘除 gm-dragging/origin 与芯片，且任何节点不残留', () => {
    activateAt(CENTER.b.x, CENTER.b.y);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(ghostEl()).toBeNull();
    for (const b of BOXES) {
      expect(nodeEl(b.id).classList.contains('gm-dragging')).toBe(false);
      expect(nodeEl(b.id).classList.contains('gm-drag-origin')).toBe(false);
    }
  });

  it('禁止落点静默取消 / pointercancel / svg 外释放（window 兜底）→ 均摘除', () => {
    // 自身盒 = 禁止目标：释放走静默取消路径
    activateAt(80, 30);
    svg.dispatchEvent(pe('pointerup', { clientX: 80, clientY: 30, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(ghostEl()).toBeNull();
    // pointercancel 路径
    activateAt(CENTER.b.x, CENTER.b.y, 2);
    svg.dispatchEvent(pe('pointercancel', { pointerId: 2 }));
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(ghostEl()).toBeNull();
    // svg 外释放（window pointerup 兜底）路径
    activateAt(CENTER.b.x, CENTER.b.y, 3);
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 3 }));
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(ghostEl()).toBeNull();
  });

  it('destroy 中途打断 → gm-dragging 摘除、芯片移除（不回调 onDrop）', () => {
    activateAt(CENTER.b.x, CENTER.b.y);
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
    expect(ghostEl()).not.toBeNull();
    controller.destroy();
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(false);
    expect(nodeEl('a').classList.contains('gm-drag-origin')).toBe(false);
    expect(ghostEl()).toBeNull();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('gm-dragging 与落点反馈（drop-target/drop-forbidden）互不干扰、可共存', () => {
    activateAt(CENTER.b.x, CENTER.b.y);
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

  it('拖拽激活后 svg 外释放（window 兜底）：取消不回调（M7c-F 复验问题4），且不卡死', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled(); // svg 外兜底释放 = 取消，不按远点结算
    expect(controller.dragging).toBeNull();
    dragTo(CENTER.b.x, CENTER.b.y, 150);
    expect(onDrop).toHaveBeenCalledTimes(1);
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
