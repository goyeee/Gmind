import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DragController } from './drag';
import { Viewport } from './viewport';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 固定桩：恒等视口（jsdom rect 全 0 → scene == client 坐标）
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 测试盒几何：a=拖拽源，b/d=合法目标，c=a 的后代（禁止目标）。 */
const BOXES: NodeBox[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 40, side: 'right', depth: 1 },
  { id: 'b', x: 200, y: 100, w: 100, h: 40, side: 'right', depth: 2 },
  { id: 'c', x: 10, y: 60, w: 80, h: 30, side: 'right', depth: 2 },
  { id: 'd', x: 400, y: 300, w: 100, h: 40, side: 'right', depth: 2 },
];
/** 各节点的后代表：isDescendant 桩数据。 */
const DESCENDANTS: Record<string, string[]> = { a: ['c'] };

/** 各盒中心（命中检测用坐标）。 */
const CENTER: Record<string, { x: number; y: number }> = {
  a: { x: 50, y: 20 },
  b: { x: 250, y: 120 },
  c: { x: 50, y: 75 },
  d: { x: 450, y: 320 },
};

let svg: SVGSVGElement;
let sceneRoot: SVGGElement;
let vp: Viewport;
let onDrop: ReturnType<typeof vi.fn>;
let controller: DragController;

beforeEach(() => {
  document.body.innerHTML = '';
  svg = document.createElementNS(SVG_NS, 'svg');
  sceneRoot = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(sceneRoot);
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
    onDrop: (id, targetId) => onDrop(id, targetId),
    isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
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

function pe(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, { bubbles: true, ...init });
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

// ---------------------------------------------------------------------------
// 命中换父（FR-EDT-003）
// ---------------------------------------------------------------------------

describe('DragController 命中换父（FR-EDT-003）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('悬停目标 ≥300ms 后释放 → onDrop(id, targetId) 恰一次，高亮清除', () => {
    dragTo(CENTER.b.x, CENTER.b.y, 300);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', 'b');
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
  });

  it('悬停未满 300ms 即释放 → 视为无目标 → onDrop(id, null)', () => {
    dragTo(CENTER.b.x, CENTER.b.y, 100);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null);
  });

  it('切换目标重置悬停计时：b 上 100ms → d 上 100ms 释放 → onDrop(id, null)', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    vi.advanceTimersByTime(100); // b 上悬停 100ms
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.d.x, clientY: CENTER.d.y, pointerId: 1 }));
    vi.advanceTimersByTime(100); // d 上仅 100ms（计时已重置）
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.d.x, clientY: CENTER.d.y, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null);
  });

  it('空白释放 → onDrop(id, null)（浮动主题，页面层 moveNode(id, "root")）', () => {
    dragTo(650, 480, 500);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null);
  });

  it('后代目标：加 drop-forbidden、释放不回调、抬起后高亮清除', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.c.x, clientY: CENTER.c.y, pointerId: 1 }));
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(true);
    expect(nodeEl('c').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(400); // 即便悬停远超 300ms 也不允许
    svg.dispatchEvent(pe('pointerup', { clientX: CENTER.c.x, clientY: CENTER.c.y, pointerId: 1 }));
    expect(onDrop).not.toHaveBeenCalled();
    expect(nodeEl('c').classList.contains('drop-forbidden')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 拖拽激活阈值与高亮
// ---------------------------------------------------------------------------

describe('DragController 激活阈值与高亮', () => {
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

  it('命中目标即加 drop-target，移开即去除；跨目标切换高亮随指针走', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.b.x, clientY: CENTER.b.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointermove', { clientX: CENTER.d.x, clientY: CENTER.d.y, pointerId: 1 }));
    expect(nodeEl('b').classList.contains('drop-target')).toBe(false);
    expect(nodeEl('d').classList.contains('drop-target')).toBe(true);
    svg.dispatchEvent(pe('pointermove', { clientX: 650, clientY: 480, pointerId: 1 })); // 空白
    expect(nodeEl('d').classList.contains('drop-target')).toBe(false);
  });

  it('自命中（拖拽源自身盒）不算目标', () => {
    nodeEl('a').dispatchEvent(
      pe('pointerdown', { button: 0, clientX: CENTER.a.x, clientY: CENTER.a.y, pointerId: 1 }),
    );
    svg.dispatchEvent(pe('pointermove', { clientX: 80, clientY: 30, pointerId: 1 })); // 仍在 a 盒内
    expect(nodeEl('a').classList.contains('drop-target')).toBe(false);
    vi.advanceTimersByTime(400);
    svg.dispatchEvent(pe('pointerup', { clientX: 80, clientY: 30, pointerId: 1 }));
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', null);
  });
});

// ---------------------------------------------------------------------------
// 边界与生命周期
// ---------------------------------------------------------------------------

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
    expect(nodeEl('b').classList.contains('drop-target')).toBe(true);
    vi.advanceTimersByTime(400);
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
      onDrop: (id, targetId) => onDrop(id, targetId),
      isDescendant: (id, candidateId) => (DESCENDANTS[id] ?? []).includes(candidateId),
    });
    dragTo(CENTER.b.x, CENTER.b.y, 300);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith('a', 'b');
  });

  it('未 attach 直接 destroy 不抛错', () => {
    expect(() => new DragController().destroy()).not.toThrow();
  });
});
