import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragController, classifyDropAt, resolveDropSlot, type DropTarget } from './drag';
import { Viewport } from './viewport';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 固定桩：恒等视口（jsdom rect 全 0 → scene == client 坐标）
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * 通用桩盒（遗留语义回归用）：a=拖拽源；b/d=根 r 的子级（散布点位，非真实列布局）；
 * c=a 的后代（禁止目标）；r=根；s=org 兄弟锚（父 q，side down）；q=org 父盒。
 * 列吸附连续模型（M7c-G）的主用例走下方 COL/LEFT 真实列布局桩。
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

/**
 * 列吸附主桩（M7c-G 测试①②④⑧）：root 右列三兄弟纵排（列 x=100、带间距 20，与
 * assignMindmapSides 全右单侧文档一致），a=被拖（第 4 个 root 子级）。
 * 带位：c1 −120..−80 / c2 −60..−20 / c3 0..40 / a 60..100；根带 −120..100。
 */
const COL_BOXES: NodeBox[] = [
  { id: 'r', x: -40, y: -20, w: 80, h: 40, side: 'right', depth: 0 },
  { id: 'c1', x: 100, y: -120, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'c2', x: 100, y: -60, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'c3', x: 100, y: 0, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'a', x: 100, y: 60, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
];
const COL_CHILDREN: Record<string, string[]> = { r: ['c1', 'c2', 'c3', 'a'] };
/** COL 桩里被拖节点 a 的盒中心（down 起手点）。 */
const COL_CENTER_A = { x: 150, y: 80 };

/**
 * 左侧吸附桩（M7c-G 测试③）：L=rt 左侧子级（朝左生长），ll/l2=L 的左列两子级
 * （带 −20..20 / 40..80），a=被拖（rt 右列）。列 x：L 列 −160、子列 −320。
 */
const LEFT_BOXES: NodeBox[] = [
  { id: 'rt', x: 0, y: -20, w: 80, h: 40, side: 'right', depth: 0 },
  { id: 'L', x: -160, y: -20, w: 100, h: 40, side: 'left', depth: 1, parentId: 'rt' },
  { id: 'll', x: -320, y: -20, w: 100, h: 40, side: 'left', depth: 2, parentId: 'L' },
  { id: 'l2', x: -320, y: 40, w: 100, h: 40, side: 'left', depth: 2, parentId: 'L' },
  { id: 'a', x: 100, y: -20, w: 100, h: 40, side: 'right', depth: 1, parentId: 'rt' },
];
const LEFT_CHILDREN: Record<string, string[]> = { rt: ['L', 'a'], L: ['ll', 'l2'] };
const LEFT_CENTER_A = { x: 150, y: 0 };

/**
 * org 专用桩（M7c-G org 镜像）：q=org 根（side down），子级行 s/t/a 横排（行 y=200、
 * 行距 20；q 底 190 → 层距 10）。行间隙/行下缘外的条带点位在此桩可命中（通用 BOXES
 * 桩里根区横向外扩会盖住 org 条带，无法构造条带用例）。
 */
const ORG_BOXES: NodeBox[] = [
  { id: 'q', x: 200, y: 150, w: 80, h: 40, side: 'down', depth: 0 },
  { id: 's', x: 200, y: 200, w: 80, h: 40, side: 'down', depth: 1, parentId: 'q' },
  { id: 't', x: 300, y: 200, w: 80, h: 40, side: 'down', depth: 1, parentId: 'q' },
  { id: 'a', x: 600, y: 200, w: 100, h: 40, side: 'down', depth: 1, parentId: 'q' },
];
const ORG_CHILDREN: Record<string, string[]> = { q: ['s', 't', 'a'] };
const ORG_CENTER_A = { x: 650, y: 220 };

/**
 * 根级侧别桩（逆时针定侧回归）：3 个等高 root 子级 右右左分布（r 右缘 0、
 * 右列 x=60、左列 x=-240；带高均 40、带间距均 20）。持久 side 下布局不再翻面：
 * 左列二级主题（x3）存在 → 左列门控开启，目标侧 = 芯片/指针所在侧。
 */
const SIM_BOXES: NodeBox[] = [
  { id: 'x1', x: 60, y: -70, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'x2', x: 60, y: -10, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'x3', x: -240, y: 50, w: 100, h: 40, side: 'left', depth: 1, parentId: 'r' },
  { id: 'r', x: -80, y: -30, w: 80, h: 60, side: 'right', depth: 0 },
];
const SIM_CHILDREN: Record<string, string[]> = { r: ['x1', 'x2', 'x3'] };

/**
 * 根级左列双主题桩（顺时针落位 2026-10-09）：doc [x1(右), x3(左), x4(左)]，左列
 * 视觉序 = 文档序倒排 [x4 顶, x3 底]（x4 是文档序在后的左列主题 → 视觉更高，与
 * 新布局「后建的往左上角长」一致）。拖 x1 入左列：视觉位次 → 文档序插入位映射。
 */
const SIM2_BOXES: NodeBox[] = [
  { id: 'x1', x: 60, y: -70, w: 100, h: 40, side: 'right', depth: 1, parentId: 'r' },
  { id: 'x4', x: -240, y: -10, w: 100, h: 40, side: 'left', depth: 1, parentId: 'r' },
  { id: 'x3', x: -240, y: 50, w: 100, h: 40, side: 'left', depth: 1, parentId: 'r' },
  { id: 'r', x: -80, y: -30, w: 80, h: 60, side: 'right', depth: 0 },
];
const SIM2_CHILDREN: Record<string, string[]> = { r: ['x1', 'x3', 'x4'] };

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
  /** 组拾起桩（2026-09-30 组拖动）：缺省恒单节点 [按下 id]——与旧口径一致。 */
  getDragGroup?: (grabbedId: string) => string[],
  /**
   * 左列结构门控桩（2026-10-09 需求方修复）：缺省不传 = 回退几何口径（盒集已有
   * 左列主题才开放，旧行为）；传 () => true 模拟 mindmap 页面接线（恒开放）。
   */
  rootLeftAllowed?: () => boolean,
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
    getDragGroup: getDragGroup ?? ((grabbedId) => [grabbedId]),
    onDrop: (ids, target) => onDrop(ids, target),
    isDescendant: (id, candidateId) => (descendants[id] ?? []).includes(candidateId),
    childrenIdsOf: (id) => children[id] ?? [],
    overlayLayer: overlay,
    ...(rootLeftAllowed !== undefined ? { rootLeftAllowed } : {}),
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

/** 拖拽起手：down 于 from（被拖节点中心）→ move 到 (x,y)（不抬——悬停断言用）。 */
function dragStart(
  x: number,
  y: number,
  from: { x: number; y: number } = CENTER.a,
  draggedId = 'a',
): void {
  nodeEl(draggedId).dispatchEvent(
    pe('pointerdown', { button: 0, clientX: from.x, clientY: from.y, pointerId: 1 }),
  );
  svg.dispatchEvent(pe('pointermove', { clientX: x, clientY: y, pointerId: 1 }));
}

/** 完整拖拽序列：down 于 from → 一步 move 到 (x,y) → up 于同点（预览即时，无悬停门槛）。 */
function dragTo(
  x: number,
  y: number,
  from: { x: number; y: number } = CENTER.a,
  draggedId = 'a',
): void {
  dragStart(x, y, from, draggedId);
  svg.dispatchEvent(pe('pointerup', { clientX: x, clientY: y, pointerId: 1 }));
}

/**
 * 兄弟顺序结算模拟：按引擎回报的 (parentId,index) 对桩数组逐个「先移除该 id 再按
 * index+i 插入」——与页面 onDrop 的 moveNode(id, parentId, index+i) 序列逐字一致；
 * ids 顺序即组内序（2026-09-30 组拖动），缺省 ['a'] 单节点旧口径。
 */
function applyTarget(
  target: DropTarget,
  children: Record<string, string[]>,
  ids: string[] = ['a'],
): void {
  if (!target || target.kind !== 'sibling') return;
  const arr = children[target.parentId];
  ids.forEach((id, i) => {
    const from = arr.indexOf(id);
    if (from !== -1) arr.splice(from, 1);
    arr.splice(target.index + i, 0, id);
  });
}

// ---------------------------------------------------------------------------
// 列吸附连续模型（M7c-G）：root 右列连续跟随 / 生长带子级吸附 / 预览即时性
// ---------------------------------------------------------------------------

describe('DragController 列吸附连续模型（M7c-G，COL 桩）', () => {
  beforeEach(() => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(COL_BOXES, COL_CHILDREN, {}));
  });

  it('① root 右列上连续移动：槽随指针停在最近两兄弟间隙（上/中/下三点断言 index 与槽 y）', () => {
    // 上点 y=-110 → 最近间隙 = c1 上方空隙（中心 -130）→ index 0
    dragStart(70, -110, COL_CENTER_A);
    expect(slotEl()!.getAttribute('x')).toBe('100'); // 右列（r 右缘 40 + 列距 60）
    expect(slotEl()!.getAttribute('y')).toBe('-150'); // 槽中心 -130 − a.h/2 20
    expect(edgeEl()!.getAttribute('d')).toBe('M 40 0 C 70 0 70 -130 100 -130');
    svg.dispatchEvent(pe('pointerup', { clientX: 70, clientY: -110, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 0,
      anchorId: 'c1',
      position: 'before',
      side: 'right', // 逆时针定侧：根级落点恒携带目标侧（全右文档门控后仍 right）
    });
    // 中点 y=-50 → 最近间隙 = c1/c2 之间（中心 -70）→ index 1（停在哪儿插在哪两个中间）
    dragStart(70, -50, COL_CENTER_A);
    expect(slotEl()!.getAttribute('y')).toBe('-90');
    svg.dispatchEvent(pe('pointerup', { clientX: 70, clientY: -50, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 1,
      anchorId: 'c1',
      position: 'after',
      side: 'right',
    });
    // 下点 y=80 → 最近间隙 = c3 下方（中心 70）→ index 3（尾插对称外推）
    dragStart(70, 80, COL_CENTER_A);
    expect(slotEl()!.getAttribute('y')).toBe('50');
    svg.dispatchEvent(pe('pointerup', { clientX: 70, clientY: 80, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 3,
      anchorId: 'c3',
      position: 'after',
      side: 'right',
    });
    // 文档序结算（中点那次）：先移除 a 再按 index 插入 → 落在 c1/c2 之间
    const children: Record<string, string[]> = { r: ['c1', 'c2', 'c3', 'a'] };
    applyTarget(onDrop.mock.calls[1]![1] as DropTarget, children);
    expect(children.r).toEqual(['c1', 'a', 'c2', 'c3']);
  });

  it('② 拖到 right 节点右侧生长带 → child of 该节点：蓝描边保留 + 边/槽同画，松开吸附为其子级', () => {
    dragStart(230, -100, COL_CENTER_A); // c1 右缘 200 右侧 30px（生长带内）
    expect(nodeEl('c1').classList.contains('drop-target')).toBe(true); // 蓝描边即时点亮
    expect(slotEl()!.getAttribute('x')).toBe('260'); // c1 右缘 200 + 兜底列距 60
    expect(slotEl()!.getAttribute('y')).toBe('-120'); // c1 中线 -100 − a.h/2 20（无子级=追加）
    expect(edgeEl()!.getAttribute('d')).toBe('M 200 -100 C 230 -100 230 -100 260 -100');
    svg.dispatchEvent(pe('pointerup', { clientX: 230, clientY: -100, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'c1',
      index: 0,
      anchorId: 'c1',
      position: 'after',
    });
    const children: Record<string, string[]> = { r: ['c1', 'c2', 'c3', 'a'], c1: [] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.c1).toEqual(['a']); // 吸附为 c1 子级
  });

  it('④ 悬停节点本体 → child（保留）：描边 + 槽（无子级=中线上方追加位）', () => {
    dragStart(150, -40, COL_CENTER_A); // c2 盒内
    expect(nodeEl('c2').classList.contains('drop-target')).toBe(true);
    expect(slotEl()!.getAttribute('x')).toBe('260'); // c2 右缘 200 + 60
    expect(slotEl()!.getAttribute('y')).toBe('-60'); // c2 中线 -40 − 20
    svg.dispatchEvent(pe('pointerup', { clientX: 150, clientY: -40, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'c2',
      index: 0,
      anchorId: 'c2',
      position: 'after',
    });
  });

  it('⑧ 预览即时性：move 后无需等待即有边/槽与描边（100ms 点亮门槛移除）', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: COL_CENTER_A.x, clientY: COL_CENTER_A.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 70, clientY: -110, pointerId: 1 })); // 根右列
    expect(edgeEl()).not.toBeNull(); // 不推进任何计时器即出现
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('y')).toBe('-150');
    svg.dispatchEvent(pe('pointermove', { clientX: 230, clientY: -100, pointerId: 1 })); // c1 生长带
    expect(nodeEl('c1').classList.contains('drop-target')).toBe(true); // 描边即时
    expect(slotEl()!.getAttribute('x')).toBe('260'); // 槽随动（原地刷新）
    expect(slotEl()!.getAttribute('y')).toBe('-120');
  });
});

// ---------------------------------------------------------------------------
// 左侧节点吸附（M7c-G：left 侧镜像 + 深区优先）
// ---------------------------------------------------------------------------

describe('DragController 左侧节点吸附（M7c-G，LEFT 桩）', () => {
  beforeEach(() => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(LEFT_BOXES, LEFT_CHILDREN, {}));
  });

  it('③ 拖到 left 节点左侧生长带 → child of 该节点（左列镜像，边+槽同画）', () => {
    dragStart(-350, 0, LEFT_CENTER_A); // ll 左缘 -320 左侧 30px
    expect(nodeEl('ll').classList.contains('drop-target')).toBe(true);
    expect(slotEl()!.getAttribute('x')).toBe('-480'); // ll 左缘 -320 − 60 − a.w 100
    expect(slotEl()!.getAttribute('y')).toBe('-20'); // ll 中线 0 − 20
    expect(edgeEl()!.getAttribute('d')).toBe('M -320 0 C -350 0 -350 0 -380 0');
    svg.dispatchEvent(pe('pointerup', { clientX: -350, clientY: 0, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'll',
      index: 0,
      anchorId: 'll',
      position: 'after',
    });
  });

  it('父级区内按 P.y 序位插中间（更深区域优先于根区）：L 本体下方 → child of L index 1', () => {
    dragStart(-110, 30, LEFT_CENTER_A); // L 盒下方、L 子级列之间（ll/l2 间隙中心 y=30）
    expect(nodeEl('L').classList.contains('drop-target')).toBe(true); // L（depth1）先于 rt（depth0）
    expect(slotEl()!.getAttribute('x')).toBe('-320'); // L 的左子级列
    expect(slotEl()!.getAttribute('y')).toBe('10'); // 间隙中心 30 − a.h/2 20
    expect(edgeEl()!.getAttribute('d')).toBe('M -160 0 C -190 0 -190 30 -220 30');
    svg.dispatchEvent(pe('pointerup', { clientX: -110, clientY: 30, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'L',
      index: 1,
      anchorId: 'll',
      position: 'after',
    });
  });
});

// ---------------------------------------------------------------------------
// 落点分类与释放结算（继承语义：本体/根盒/空白/禁止，BOXES 桩）
// ---------------------------------------------------------------------------

describe('DragController 落点分类与释放结算（继承语义）', () => {
  it('本体命中 → child of b（蓝描边保留，边+槽同画；无子级=追加）', () => {
    dragStart(CENTER.b.x, CENTER.b.y);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true); // 即时点亮
    expect(slotEl()!.getAttribute('x')).toBe('360'); // b 右缘 300 + 兜底列距 60
    expect(slotEl()!.getAttribute('y')).toBe('100'); // b 中线 120 − a.h/2 20
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
  });

  it('快速释放（move 后立即抬起）按同一最后悬停结算（一致性缓存，无门槛）', () => {
    dragTo(CENTER.b.x, CENTER.b.y);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
  });

  it('根盒命中 → child of root：index 按指针 y 最近间隙位（此点位=c1 前插），侧别按指针半屏', () => {
    dragTo(CENTER.r.x, -116); // 根盒内（r 中线 -120 → 右半）
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 0,
      anchorId: 'b',
      position: 'before',
      side: 'right', // 逆时针定侧：指针在根盒右半 → 目标侧 right
    });
    const children: Record<string, string[]> = { r: ['a', 'b', 'd'], a: ['c'], q: ['s', 't'] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.r).toEqual(['a', 'b', 'd']); // 前插：兄弟顺序不变
  });

  it('空白悬停 → 预览（root 边缘→对应侧末尾槽）+ 释放解析为 root 右侧末尾 sibling（M7c-F 复验问题4）', () => {
    dragStart(650, 480); // 空白（650 在 r 中线 -120 右半）
    expect(edgeEl()).not.toBeNull(); // 空白悬停不再零预览（即时）
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('200'); // 右列（与 b/d 同列）
    expect(slotEl()!.getAttribute('y')).toBe('420'); // d 底 340 + 带间距 160/2 − a.h/2 20
    // 边 = root 右缘中点 → 槽左边中点（render 同款 bezier）
    expect(edgeEl()!.getAttribute('d')).toBe('M -80 -100 C 60 -100 60 440 200 440');
    svg.dispatchEvent(pe('pointerup', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 2, // 右侧（=文档序前缀）末尾：post-removal 子级 [b, d] 全右 → 2
      anchorId: 'd',
      position: 'after',
      side: 'right', // 指针 650 在 r 中线 -120 右半 → 目标侧 right
    });
  });

  it('后代目标（本体/吸附区均禁止）：加 drop-forbidden、释放不回调、无预览、抬起后高亮清除', () => {
    dragStart(CENTER.c.x, CENTER.c.y + 12); // c 盒内
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('c').classList.contains('drop-target')).toBe(false);
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
    dragStart(80, 30); // 仍在 a 盒内
    expect(nodeEl('a').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('a').classList.contains('drop-target')).toBe(false);
    svg.dispatchEvent(pe('pointerup', { clientX: 80, clientY: 30, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('a').classList.contains('drop-forbidden')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// org（side=down）门控：区=本体+下侧生长带、列=子级行条带、index 按 P.x（M7c-G 镜像）
// ---------------------------------------------------------------------------

describe('DragController org 结构（side=down，ORG 桩）', () => {
  beforeEach(() => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(ORG_BOXES, ORG_CHILDREN, {}));
  });

  it('org 盒本体 → child of s：槽在父下中点下方（elbow 边），index=0 追加', () => {
    dragStart(240, 220, ORG_CENTER_A); // s 盒内
    expect(nodeEl('s').classList.contains('drop-target')).toBe(true);
    expect(slotEl()!.getAttribute('x')).toBe('190'); // s 中线 240 − a.w/2 50
    expect(slotEl()!.getAttribute('y')).toBe('260'); // s 底 240 + 兜底层距 20
    expect(edgeEl()!.getAttribute('d')).toBe('M 240 240 L 240 250 L 240 250 L 240 260');
    svg.dispatchEvent(pe('pointerup', { clientX: 240, clientY: 220, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 's',
      index: 0,
      anchorId: 's',
      position: 'after',
    });
  });

  it('org 子级行间隙 → child of q：index 按 P.x 插中间（s/t 之间），槽/边同真实 org 口径', () => {
    dragStart(290, 220, ORG_CENTER_A); // s 右缘 280 与 t 左缘 300 之间
    expect(nodeEl('q').classList.contains('drop-target')).toBe(true);
    expect(slotEl()!.getAttribute('x')).toBe('240'); // 间隙中点 290 − a.w/2 50
    expect(slotEl()!.getAttribute('y')).toBe('200'); // q 底 190 + 层距 10
    expect(edgeEl()!.getAttribute('d')).toBe('M 240 190 L 240 195 L 290 195 L 290 200');
    svg.dispatchEvent(pe('pointerup', { clientX: 290, clientY: 220, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'q',
      index: 1,
      anchorId: 's',
      position: 'after',
    });
  });

  it('org 行条带（行下缘外、区外）→ sibling 按 P.x：尾插 index=1 / 头插 index=0', () => {
    dragStart(299, 255, ORG_CENTER_A); // 行下缘 240 之下、q 区底 248 之外（条带 y ≤ 264）
    expect(slotEl()!.getAttribute('x')).toBe('240');
    svg.dispatchEvent(pe('pointerup', { clientX: 299, clientY: 255, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'q',
      index: 1, // 同父移动：index 已是「移除 a 后」的位次（[s,t] 中间），无需二次修正
      anchorId: 's',
      position: 'after',
    });
    dragStart(185, 255, ORG_CENTER_A); // 行左缘 200 左侧（条带 x ≥ 180）
    svg.dispatchEvent(pe('pointerup', { clientX: 185, clientY: 255, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'q',
      index: 0,
      anchorId: 's',
      position: 'before',
    });
  });
});

// ---------------------------------------------------------------------------
// 落位预览元素生命周期（gm-drop-edge / gm-drop-slot 清理路径）
// ---------------------------------------------------------------------------

describe('DragController 落位预览清理（gm-drop-edge / gm-drop-slot）', () => {
  /** 起手并悬停到根右列（child of r，槽/边即现）。 */
  const startDrag = (pointerId: number): void => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 250, clientY: 150, pointerId }));
    expect(ghostEl()).not.toBeNull();
    expect(edgeEl()).not.toBeNull();
    expect(slotEl()).not.toBeNull();
  };
  it('移开到空白/释放/pointercancel/destroy → 芯片/边/槽全部移除（预览元素存在性）', () => {
    // 空白：预览切换为 root 对应侧末尾槽（M7c-F 问题4 + M7c-G 即时刷新），芯片仍在
    startDrag(1);
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(slotEl()!.getAttribute('x')).toBe('200'); // root 右列末尾槽
    expect(slotEl()!.getAttribute('y')).toBe('420');
    expect(ghostEl()).not.toBeNull();
    svg.dispatchEvent(pe('pointerup', { clientX: 650, clientY: 480, pointerId: 1 }));
    expect(ghostEl()).toBeNull();
    // 释放路径
    startDrag(2);
    svg.dispatchEvent(pe('pointerup', { clientX: 250, clientY: 150, pointerId: 2 }));
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
});

// ---------------------------------------------------------------------------
// 落位槽纯函数（resolveDropSlot：槽几何 + 根级侧别仿真——未随 M7c-G 改动，回归保护）
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

describe('resolveDropSlot 根级落点（逆时针定侧：持久侧别不再翻面）', () => {
  beforeEach(() => {
    // 重装根级侧别桩场景（右右左分布，左列门控开启）
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(SIM_BOXES, SIM_CHILDREN, {}));
  });

  it('纯函数：index 直通不修正（旧半分仿真退役）——芯片在右低处 → index 落右列、槽画右列', () => {
    // 芯片在右侧低处（x2 下方 y≈80）：index 2 直通 = 文档序末尾（post-removal
    // [x2,x3] 插 index 2 → [x2,x3,x1]，x1 仍在右列 x2 之下）；无仿真修正。
    const res = resolveDropSlot({
      boxes: SIM_BOXES,
      childrenIds: SIM_CHILDREN.r!,
      draggedId: 'x1',
      parentId: 'r',
      index: 2,
      chipBox: { x: 60, y: 80, w: 100, h: 40 },
    });
    expect(res).not.toBeNull();
    expect(res!.index).toBe(2); // 直通（旧版此处被仿真修正为 1）
    expect(res!.slot.side).toBe('right');
    expect(res!.slot.x).toBe(60); // 右列（r 右缘 0 + 列距 60）
    expect(res!.slot.y).toBe(40); // x2 底 30 + 带间距/2 10（槽顶）
  });

  it('DOM：右侧节点拖到根右区低处（x2 下方）→ index 落右、槽画在右列，target.side=right', () => {
    dragStart(110, 60, { x: 110, y: -50 }, 'x1'); // 根区右带低处（x2 下方）
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('60'); // 右列（与 x1/x2 同列），绝不在左侧
    expect(slotEl()!.getAttribute('y')).toBe('40');
    svg.dispatchEvent(pe('pointerup', { clientX: 110, clientY: 60, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['x1'], {
      kind: 'sibling',
      parentId: 'r',
      index: 1,
      anchorId: 'x2',
      position: 'after',
      side: 'right',
    });
  });

  it('DOM：根左区命中（x3 上方）→ 目标侧=芯片侧落左列（y 最近插入位在 x3 之上），target.side=left', () => {
    dragStart(-100, 70, { x: 110, y: -50 }, 'x1'); // 根区左带（x3 上方间隙侧）
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('-240'); // 左列（与 x3 同列）
    expect(slotEl()!.getAttribute('y')).toBe('20'); // x3 顶 50 − 带间距/2 10 − a.h/2 20（槽顶）
    svg.dispatchEvent(pe('pointerup', { clientX: -100, clientY: 70, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['x1'], {
      kind: 'sibling',
      parentId: 'r',
      // 顺时针落位（2026-10-09）：左列视觉反序——「x3 视觉上方」= 文档序 x3 之后
      // （sideInsertDocIndex 视觉序映射；旧单带下是文档序 x3 之前）。落位后 [x2,x3,x1]
      // 左列 [x3,x1] 视觉 [x1 顶, x3 底]，x1 恰在 x3 上方，与拖放所见一致。
      index: 2,
      anchorId: 'x3',
      position: 'after',
      side: 'left', // 持久侧别：拖到左半 → 页面 setNodeSide 换左
    });
  });

  it('空白（root 左半）→ 解析为左列视觉底：槽画左列下方、index=左列文档序首位之前、target.side=left', () => {
    dragStart(-500, 100, { x: 110, y: -50 }, 'x1');
    // 空白（-500 < r 中线 -40 → 指针侧 left；左列门控开启 → 目标侧 left）
    const slot = slotEl();
    expect(slot).not.toBeNull(); // 空白悬停有预览
    expect(slot!.getAttribute('x')).toBe('-240'); // 左列（与 x3 同列），不在右列
    expect(slot!.getAttribute('y')).toBe('100'); // x3 底 90 + 带间距/2 10（槽顶）
    svg.dispatchEvent(pe('pointerup', { clientX: -500, clientY: 100, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['x1'], {
      kind: 'sibling',
      parentId: 'r',
      // 左侧尾插 = 视觉列底（顺时针落位：文档序左列首位 x3 之前——post-removal
      // [x2,x3] → index 1；旧单带下是文档序末尾 2）。落位后 [x2,x1,x3] 左列 [x1,x3]
      // 视觉 [x3 顶, x1 底]，空白落在左列底部，语义不变。
      index: 1,
      anchorId: 'x2',
      position: 'after',
      side: 'left',
    });
  });

  it('DOM：左列双主题视觉序映射——视觉顶=文档序末位后、视觉底=文档序首位前、中间=其间', () => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(SIM2_BOXES, SIM2_CHILDREN, {}));
    // 拖 x1（右列）入左列（x=-100 根左带；x4 顶 -10、x3 底 90，槽中心：顶 -20 / 中 40 / 底 110）
    const dragToLeft = (pointerY: number, expected: { index: number; anchorId: string; position: 'before' | 'after' }): void => {
      dragStart(-100, pointerY, { x: 110, y: -50 }, 'x1');
      expect(slotEl()).not.toBeNull();
      expect(slotEl()!.getAttribute('x')).toBe('-240'); // 恒画左列
      svg.dispatchEvent(pe('pointerup', { clientX: -100, clientY: pointerY, pointerId: 1 }));
      expect(onDrop).toHaveBeenLastCalledWith(
        ['x1'],
        expect.objectContaining({ kind: 'sibling', parentId: 'r', side: 'left', ...expected }),
      );
    };
    // 视觉顶（x4 之上，y=-20）：post-removal [x3,x4] 插 x4 之后（index 2）→ 落位后左列
    // [x3,x4,x1] 视觉 [x1,x4,x3]——x1 恰在列顶。
    dragToLeft(-20, { index: 2, anchorId: 'x4', position: 'after' });
    // 视觉中（x4 与 x3 之间，y=40）：插 x3 之后（index 1）→ 左列 [x3,x1,x4] 视觉 [x4,x1,x3]。
    dragToLeft(40, { index: 1, anchorId: 'x3', position: 'after' });
    // 视觉底（x3 之下，y=110——已出同级条带，走空白解析）：左列视觉尾插 = 插 x3 之前
    // （index 0）→ 左列 [x1,x3,x4] 视觉 [x4,x3,x1]。空白路径空锚 = after 父自身。
    dragToLeft(110, { index: 0, anchorId: 'r', position: 'after' });
  });

  it('门控：全右文档（无左列二级主题）拖到根左半 → 恒结算右列（logic/新文档不受影响）', () => {
    // COL 桩（全右，左列门控关闭）：根左半的子级吸附区命中——slot/target 恒 right，
    // 与旧「单侧根级恒右」行为一致，绝不向左解析。
    // （缺省未传 rootLeftAllowed = 几何兜底口径；2026-10-09 起页面按结构供给，
    // mindmap 恒开放的修复行为见下两条用例。）
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(COL_BOXES, COL_CHILDREN, {}));
    dragStart(-150, -110, COL_CENTER_A); // 根区左半（-150 < r 中线 0，根区 y 带内）
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('100'); // 右列（绝不画左槽）
    expect(slotEl()!.getAttribute('y')).toBe('-150'); // c1 上方空隙（与右列命中同槽）
    svg.dispatchEvent(pe('pointerup', { clientX: -150, clientY: -110, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 0,
      anchorId: 'c1',
      position: 'before',
      side: 'right',
    });
  });

  it('rootLeftAllowed=true（mindmap 修复）：全右文档拖到根左半 → 结算左列（首个左列主题），target.side=left', () => {
    // 2026-10-09 需求方修复「左侧没有分支主题时，右侧分支无法拖到左侧」：结构门控
    // 开放后，COL 桩（全右）同一指针点不再恒右——槽画左列兜底列位、index=左列空堆
    // 尾插（sideInsertDocIndex 左空 → 文档序末尾）。
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(
      COL_BOXES,
      COL_CHILDREN,
      {},
      undefined,
      () => true,
    ));
    dragStart(-150, -110, COL_CENTER_A); // 与上门控用例同一指针点（根区左半）
    expect(slotEl()).not.toBeNull();
    expect(slotEl()!.getAttribute('x')).toBe('-200'); // 左列兜底列位（r 左缘 -40 − 列距 60 − a.w 100）
    expect(slotEl()!.getAttribute('y')).toBe('-20'); // 左列无兄弟 → 父盒垂直居中（槽中心 0 − a.h/2）
    svg.dispatchEvent(pe('pointerup', { clientX: -150, clientY: -110, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 3, // 左列空堆 → 文档序末尾（与空白解析「右顶/左尾」语义一致）
      anchorId: 'c3',
      position: 'after',
      side: 'left', // 页面据此 setNodeSide 建首个左列主题
    });
    // 落位仿真：post-removal [c1,c2,c3] 插 index 3 → [c1,c2,c3,a]（文档序末尾追加）
    const children: Record<string, string[]> = { r: ['c1', 'c2', 'c3', 'a'] };
    applyTarget(onDrop.mock.calls[0]![1] as DropTarget, children);
    expect(children.r).toEqual(['c1', 'c2', 'c3', 'a']);
  });

  it('rootLeftAllowed=true（mindmap 修复）：全右文档空白左半 → 解析左列末尾，target.side=left', () => {
    // 空白路径同一门控（resolveBlankTarget）：root 左区横向外扩缘（-200）之外的
    // 左半空白 → 目标侧 left、左列尾插（文档序末尾）。
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(
      COL_BOXES,
      COL_CHILDREN,
      {},
      undefined,
      () => true,
    ));
    dragStart(-500, 0, COL_CENTER_A); // 空白（-500 < 根左区缘 -200）
    expect(slotEl()).not.toBeNull(); // 空白悬停有预览
    expect(slotEl()!.getAttribute('x')).toBe('-200'); // 左列兜底列位，不在右列
    expect(slotEl()!.getAttribute('y')).toBe('-20'); // 左列无兄弟 → 父盒垂直居中
    svg.dispatchEvent(pe('pointerup', { clientX: -500, clientY: 0, pointerId: 1 }));
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'r',
      index: 3,
      anchorId: 'c3',
      position: 'after',
      side: 'left',
    });
  });

  it('纯函数：rootLeftAllowed=true → 全右文档芯片左半槽画左列兜底列位（index 直通）', () => {
    // resolveDropSlot 与 classifyDropAt 同一显式门控值（同点必同侧）：芯片左半 +
    // sideHint left + rootLeftAllowed true → 左列槽（缺省几何口径下此场景恒右，
    // 由上门控用例锁定）。
    const res = resolveDropSlot({
      boxes: COL_BOXES,
      childrenIds: COL_CHILDREN.r!,
      draggedId: 'a',
      parentId: 'r',
      index: 3,
      chipBox: { x: -136, y: -96, w: 100, h: 40 },
      sideHint: 'left',
      rootLeftAllowed: true,
    });
    expect(res).not.toBeNull();
    expect(res!.index).toBe(3); // 直通（持久侧别下不做仿真修正）
    expect(res!.slot.side).toBe('left');
    expect(res!.slot.x).toBe(-200); // 左列兜底列位（r 左缘 -40 − H_GAP_FALLBACK 60 − a.w 100）
    expect(res!.slot.y).toBe(-20); // 左列无兄弟 → 父盒垂直居中
  });
});

// ---------------------------------------------------------------------------
// classifyDropAt 纯函数（M7c-G 区域优先级直测）
// ---------------------------------------------------------------------------

describe('classifyDropAt 纯函数（M7c-G 区域优先级）', () => {
  const classify = (point: { x: number; y: number }): ReturnType<typeof classifyDropAt> =>
    classifyDropAt({
      boxes: COL_BOXES,
      childrenIdsOf: (id) => COL_CHILDREN[id] ?? [],
      isDescendant: () => false,
      draggedId: 'a',
      point,
    });

  it('rootLeftAllowed=true：全右文档根左半 → child of root、sideHint=left、index=左空尾插文档序尾', () => {
    // 2026-10-09 需求方修复「左侧没有分支主题时，右侧分支无法拖到左侧」：显式结构
    // 门控开放后目标侧按指针侧直取（缺省几何口径下此点恒 right，由 DOM 门控用例锁定）。
    expect(
      classifyDropAt({
        boxes: COL_BOXES,
        childrenIdsOf: (id) => COL_CHILDREN[id] ?? [],
        isDescendant: () => false,
        draggedId: 'a',
        rootLeftAllowed: true,
        point: { x: -150, y: -110 },
      }),
    ).toEqual({
      placement: { kind: 'child', nodeId: 'r', index: 3, sideHint: 'left' },
      forbiddenId: null,
    });
  });

  it('根右列 → child of root（index=最近间隙位，sideHint=right）', () => {
    expect(classify({ x: 70, y: -110 })).toEqual({
      placement: { kind: 'child', nodeId: 'r', index: 0, sideHint: 'right' },
      forbiddenId: null,
    });
    expect(classify({ x: 70, y: -50 })!.placement).toEqual({
      kind: 'child',
      nodeId: 'r',
      index: 1,
      sideHint: 'right',
    });
  });

  it('右生长带 → child of c1（非 root 无 sideHint；index=0 追加）', () => {
    expect(classify({ x: 230, y: -100 })).toEqual({
      placement: { kind: 'child', nodeId: 'c1', index: 0 },
      forbiddenId: null,
    });
  });

  it('被拖子树盒直击 → forbiddenId（placement null，先于一切区域）', () => {
    expect(
      classifyDropAt({
        boxes: BOXES,
        childrenIdsOf: (id) => CHILDREN[id] ?? [],
        isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
        draggedId: 'a',
        point: CENTER.c,
      }),
    ).toEqual({ placement: null, forbiddenId: 'c' });
  });

  it('组排除集并组（draggedIds）：组内任一成员本体/其后代均 forbiddenId（2026-09-30 组拖动）', () => {
    // 组 ['a','b']：b 本体（组成员）与 c（a 的后代）都进排除集；非组成员 r 正常。
    const group = (point: { x: number; y: number }): ReturnType<typeof classifyDropAt> =>
      classifyDropAt({
        boxes: BOXES,
        childrenIdsOf: (id) => CHILDREN[id] ?? [],
        isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
        draggedId: 'a',
        draggedIds: ['a', 'b'],
        point,
      });
    expect(group(CENTER.b)!.placement).toBeNull();
    expect(group(CENTER.b)!.forbiddenId).toBe('b');
    expect(group(CENTER.c)!.placement).toBeNull();
    expect(group(CENTER.c)!.forbiddenId).toBe('c');
    expect(group({ x: 70, y: -110 })!.placement).toEqual({
      kind: 'child',
      nodeId: 'r',
      index: 0,
      sideHint: 'right',
    });
  });
});

// ---------------------------------------------------------------------------
// 组拖动（2026-09-30 需求方批量拖动：多选整组同时拖到其他节点）
// ---------------------------------------------------------------------------

describe('DragController 组拖动（2026-09-30 批量拖动）', () => {
  /** COL 桩组拾起桩：按住 a → 组 ['c3','a']（布局序 box.y 升序：c3 y=0 < a y=60）。 */
  const colGroup = (grabbedId: string): string[] => (grabbedId === 'a' ? ['c3', 'a'] : [grabbedId]);

  beforeEach(() => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(COL_BOXES, COL_CHILDREN, {}, colGroup));
  });

  it('① 组拾起 → 悬停列条带 → 释放 onDrop 收 ids 长度 2；applyTarget 后两节点相邻兄弟、序=布局序', () => {
    dragStart(70, -110); // 根右列（child of r，与单节点用例①同点位）
    expect(slotEl()).not.toBeNull(); // 组同样单套边/槽预览（组落同一槽）
    svg.dispatchEvent(pe('pointerup', { clientX: 70, clientY: -110, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    const [ids, target] = onDrop.mock.calls[0]! as [string[], DropTarget];
    expect(ids).toEqual(['c3', 'a']); // 组序 = 拾起时布局序
    expect(target).toMatchObject({ kind: 'sibling', parentId: 'r' });
    // 页面侧 moveNode(id, parentId, index+i) 序列逐字模拟：组内任一成员先移除再插入
    const children: Record<string, string[]> = { r: ['c1', 'c2', 'c3', 'a'] };
    applyTarget(target, children, ids);
    expect(children.r).toEqual(['c3', 'a', 'c1', 'c2']); // 相邻兄弟 + 组内序=布局序
  });

  it('② 组禁止：拖组到组内某节点的子级（c 为组成员 a 的后代）→ forbidden，释放不回调', () => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(BOXES, CHILDREN, DESCENDANTS, (id) =>
      id === 'a' ? ['a', 'b'] : [id],
    ));
    // c = 组成员 a 的后代 → 全组各自子树并集禁止
    dragStart(CENTER.c.x, CENTER.c.y);
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('c').classList.contains('drop-target')).toBe(false);
    expect(slotEl()).toBeNull();
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.c.x, clientY: CENTER.c.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    // 组成员 b 本体同为禁止目标
    dragStart(CENTER.b.x, CENTER.b.y);
    expect(nodeEl('b').classList.contains('drop-forbidden')).toBe(true);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('③ 组 ghost：size>1 时 .gm-drag-ghost-badge（×N）存在；单节点路径无徽章', () => {
    dragStart(70, -110);
    const badge = ghostEl()!.querySelector('.gm-drag-ghost-badge');
    expect(badge).not.toBeNull();
    expect(badge!.querySelector('text')!.textContent).toBe('×2');
    expect(badge!.querySelector('circle')).not.toBeNull(); // 圆形徽章底
    svg.dispatchEvent(pe('pointerup', { clientX: 70, clientY: -110, pointerId: 1 }));
    // 单节点（缺省桩 getDragGroup 返回单元素）：芯片保留、徽章不画
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(COL_BOXES, COL_CHILDREN, {}));
    dragStart(70, -110);
    expect(ghostEl()).not.toBeNull();
    expect(ghostEl()!.querySelector('.gm-drag-ghost-badge')).toBeNull();
  });

  it('④ 单节点路径回归：getDragGroup 返回单元素时行为与旧一致（onDrop 收长度 1 数组）', () => {
    ({ svg, overlay, vp, onDrop, controller } = buildHarness(BOXES, CHILDREN, DESCENDANTS, (id) => [
      id,
    ]));
    dragTo(CENTER.b.x, CENTER.b.y);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
  });
});

// ---------------------------------------------------------------------------
// 被拖节点视觉反馈（gm-dragging + gm-drag-origin）与拖拽芯片（gm-drag-ghost）
// ---------------------------------------------------------------------------

describe('DragController 被拖节点视觉反馈与拖拽芯片（M7c-D3）', () => {
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

  it('gm-dragging 与落点反馈（drop-target/边/槽）互不干扰、可共存（即时点亮）', () => {
    activateAt(CENTER.b.x, CENTER.b.y);
    expect(nodeEl('a').classList.contains('gm-dragging')).toBe(true);
    expect(nodeEl('a').classList.contains('drop-target')).toBe(false);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true); // child 蓝描边即时
    expect(slotEl()).not.toBeNull(); // child 模式边/槽同画
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
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('非主键（button=2）不启动拖拽', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 2, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('pointercancel 中止拖拽：清高亮、不回调', () => {
    dragStart(CENTER.b.x, CENTER.b.y);
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true); // 反馈即时
    svg.dispatchEvent(pe('pointercancel', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('destroy 中止进行中的拖拽：不回调且监听已移除', () => {
    dragStart(CENTER.b.x, CENTER.b.y);
    controller.destroy();
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
      onDrop: (ids, target) => onDrop(ids, target),
      isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
      childrenIdsOf: (id) => CHILDREN[id] ?? [],
      overlayLayer: overlay,
    });
    dragTo(CENTER.b.x, CENTER.b.y);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
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
    dragTo(CENTER.b.x, CENTER.b.y);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
  });

  it('拖拽激活后 svg 外释放（window 兜底）：取消不回调（M7c-F 复验问题4），且不卡死', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    window.dispatchEvent(pe('pointerup', { clientX: 5000, clientY: -20, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled(); // svg 外兜底释放 = 取消，不按远点结算
    expect(controller.dragging).toBeNull();
    dragTo(CENTER.b.x, CENTER.b.y);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenLastCalledWith(['a'], {
      kind: 'sibling',
      parentId: 'b',
      index: 0,
      anchorId: 'b',
      position: 'after',
    });
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
