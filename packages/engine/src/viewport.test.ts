import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampScale,
  computeFit,
  computeZoomAt,
  contentBounds,
  MAX_SCALE,
  MIN_SCALE,
  Viewport,
} from './viewport';
import type { NodeBox } from './types';

// ---------------------------------------------------------------------------
// 固定桩
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function box(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  depth = 2,
): NodeBox {
  return { id, x, y, w, h, side: 'right', depth };
}

let svg: SVGSVGElement;
let sceneRoot: SVGGElement;
let vp: Viewport;

beforeEach(() => {
  document.body.innerHTML = '';
  svg = document.createElementNS(SVG_NS, 'svg');
  sceneRoot = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(sceneRoot);
  document.body.appendChild(svg);
  vp = new Viewport(svg, sceneRoot);
});

/** 解析 sceneRoot 上的 transform 属性串为数值三元组。 */
function parseTransform(): { tx: number; ty: number; scale: number } {
  const raw = sceneRoot.getAttribute('transform') ?? '';
  const m = /translate\((-?[\d.]+), (-?[\d.]+)\) scale\((-?[\d.]+)\)/.exec(raw);
  if (!m) throw new Error(`transform 属性不符合预期格式: "${raw}"`);
  return { tx: Number(m[1]), ty: Number(m[2]), scale: Number(m[3]) };
}

function wheelEvent(init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { cancelable: true, ...init });
  return e;
}

function pointerEvent(
  type: string,
  init: PointerEventInit,
): PointerEvent {
  return new PointerEvent(type, { bubbles: true, ...init });
}

// ---------------------------------------------------------------------------
// 纯数学：clampScale / computeZoomAt / computeFit
// ---------------------------------------------------------------------------

describe('clampScale', () => {
  it('下限 0.1 / 上限 4.0，区间内原样返回', () => {
    expect(clampScale(0.05)).toBe(MIN_SCALE);
    expect(clampScale(0.1)).toBe(MIN_SCALE);
    expect(clampScale(1)).toBe(1);
    expect(clampScale(4)).toBe(MAX_SCALE);
    expect(clampScale(99)).toBe(MAX_SCALE);
  });
});

describe('computeZoomAt（纯函数）', () => {
  it('锚点场景坐标不变：光标 (cx,cy) 指向的场景点缩放前后一致', () => {
    const scale = 1.3;
    const tx = -40;
    const ty = 17.25;
    const cx = 233;
    const cy = -88;
    const before = { x: (cx - tx) / scale, y: (cy - ty) / scale };
    const after = computeZoomAt(scale, tx, ty, 1.7, cx, cy);
    expect((cx - after.tx) / after.scale).toBeCloseTo(before.x, 10);
    expect((cy - after.ty) / after.scale).toBeCloseTo(before.y, 10);
  });

  it('放大/缩小倍率按 factor 作用（未触clamp）', () => {
    expect(computeZoomAt(1, 0, 0, 2, 100, 50).scale).toBeCloseTo(2, 10);
    expect(computeZoomAt(2, 0, 0, 0.5, 100, 50).scale).toBeCloseTo(1, 10);
  });

  it('clamp 生效：超上限/下限时 scale 钳在 4 / 0.1 且有限', () => {
    const up = computeZoomAt(3.9, 10, 10, 5, 100, 100);
    expect(up.scale).toBe(MAX_SCALE);
    expect(Number.isFinite(up.tx)).toBe(true);
    const down = computeZoomAt(0.12, 10, 10, 0.01, 100, 100);
    expect(down.scale).toBe(MIN_SCALE);
    expect(Number.isFinite(down.tx)).toBe(true);
  });
});

describe('computeFit（纯函数）', () => {
  it('内容含于视口、限制轴四周留白恰为 5%、水平垂直均居中', () => {
    const content = { width: 400, height: 150, minX: -200, minY: -75 };
    const r = computeFit(content, 800, 600);
    expect(r.scale).toBeCloseTo(1.8, 10); // min(0.9*800/400, 0.9*600/150) = 1.8

    const left = content.minX * r.scale + r.tx;
    const right = left + content.width * r.scale;
    const top = content.minY * r.scale + r.ty;
    const bottom = top + content.height * r.scale;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(800);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(600);
    // 限制轴（宽）留白 = 5% 每侧；另一轴（高）留白更大但对称
    expect(left).toBeCloseTo(0.05 * 800, 6);
    expect(800 - right).toBeCloseTo(left, 10);
    expect(top).toBeCloseTo(600 - bottom, 10);
  });

  it('内容远大于视口：scale 钳到下限 0.1（不产生 NaN/Infinity）', () => {
    const r = computeFit({ width: 20000, height: 15000, minX: -10000, minY: -7500 }, 800, 600);
    expect(r.scale).toBe(MIN_SCALE);
    expect(Number.isFinite(r.tx)).toBe(true);
    expect(Number.isFinite(r.ty)).toBe(true);
  });

  it('内容远小于视口：scale 钳到上限 4.0 并居中', () => {
    const content = { width: 1, height: 1, minX: -0.5, minY: -0.5 };
    const r = computeFit(content, 800, 600);
    expect(r.scale).toBe(MAX_SCALE);
    const cx = content.minX * r.scale + r.tx + (0.5 * r.scale);
    const cy = content.minY * r.scale + r.ty + (0.5 * r.scale);
    expect(cx).toBeCloseTo(400, 6);
    expect(cy).toBeCloseTo(300, 6);
  });

  it('退化：宽或高为 0 → scale=1，居中该点，无 NaN/Infinity', () => {
    const r = computeFit({ width: 0, height: 80, minX: 0, minY: -40 }, 800, 600);
    expect(r.scale).toBe(1);
    expect(r.tx).toBeCloseTo(400, 10);
    expect(Number.isFinite(r.ty)).toBe(true);
    const r2 = computeFit({ width: 120, height: 0, minX: -60, minY: 0 }, 800, 600);
    expect(r2.scale).toBe(1);
    expect(r2.ty).toBeCloseTo(300, 10);
  });
});

describe('contentBounds', () => {
  it('minX/minY 取节点盒最小值，宽高取布局结果', () => {
    const layout = {
      nodes: [box('r', -60, -10, 120, 20, 0), box('b', 60, -30, 100, 40)],
      width: 220,
      height: 80,
    };
    expect(contentBounds(layout)).toEqual({ width: 220, height: 80, minX: -60, minY: -30 });
  });

  it('空节点集回退 minX/minY = 0', () => {
    expect(contentBounds({ nodes: [], width: 0, height: 0 })).toEqual({
      width: 0,
      height: 0,
      minX: 0,
      minY: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// jsdom：Viewport 实例（transform 写入 sceneRoot / 事件 / 生命周期）
// ---------------------------------------------------------------------------

describe('Viewport 基础状态与 transform 写入', () => {
  it('构造即写恒等 transform：translate(0, 0) scale(1)', () => {
    expect(sceneRoot.getAttribute('transform')).toBe('translate(0, 0) scale(1)');
    expect(parseTransform()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it('panBy 按 screen px 平移并回写 transform', () => {
    vp.panBy(12.5, -3.25);
    const t = parseTransform();
    expect(t.tx).toBeCloseTo(12.5, 4);
    expect(t.ty).toBeCloseTo(-3.25, 4);
    expect(t.scale).toBe(1);
  });

  it('zoomAt 与纯函数一致，transform 数值可解析', () => {
    vp.zoomAt(2, 100, 50);
    const want = computeZoomAt(1, 0, 0, 2, 100, 50);
    const t = parseTransform();
    expect(t.scale).toBeCloseTo(want.scale, 4);
    expect(t.tx).toBeCloseTo(want.tx, 4);
    expect(t.ty).toBeCloseTo(want.ty, 4);
  });

  it('zoomTo 钳制到 [0.1, 4]', () => {
    vp.zoomTo(99);
    expect(parseTransform().scale).toBe(MAX_SCALE);
    vp.zoomTo(0.001);
    expect(parseTransform().scale).toBe(MIN_SCALE);
    vp.zoomTo(1.75);
    expect(parseTransform().scale).toBeCloseTo(1.75, 4);
  });

  it('toScene/toScreen 往返一致', () => {
    vp.zoomAt(1.7, 120, 80);
    vp.panBy(33, -21);
    const p = { x: 123.5, y: 45.25 };
    const scene = vp.toScene(p.x, p.y);
    const back = vp.toScreen(scene.x, scene.y);
    expect(back.x).toBeCloseTo(p.x, 10);
    expect(back.y).toBeCloseTo(p.y, 10);
  });

  it('toSceneFromEvent 用 svg 包围盒换算（jsdom 中 rect 为 0，与 toScene 一致）', () => {
    vp.zoomAt(2, 10, 20);
    const e = new MouseEvent('pointermove', { clientX: 70, clientY: 30 });
    expect(vp.toSceneFromEvent(e)).toEqual(vp.toScene(70, 30));
  });

  it('fit：与纯函数一致，内容含于视口', () => {
    const layout = {
      nodes: [box('r', -60, -20, 120, 40, 0), box('a', 60, -30, 100, 30)],
      width: 220,
      height: 90,
    };
    vp.fit(layout, { w: 800, h: 600 });
    const want = computeFit(contentBounds(layout), 800, 600);
    const t = parseTransform();
    expect(t.scale).toBeCloseTo(want.scale, 4);
    expect(t.tx).toBeCloseTo(want.tx, 4);
    expect(t.ty).toBeCloseTo(want.ty, 4);
    const left = -60 * t.scale + t.tx;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left + 220 * t.scale).toBeLessThanOrEqual(800);
    const top = -30 * t.scale + t.ty;
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 90 * t.scale).toBeLessThanOrEqual(600);
  });
});

describe('Viewport 滚轮（attach 后）', () => {
  it('ctrl+wheel：以光标为锚缩放并 preventDefault', () => {
    vp.attach();
    const e = wheelEvent({ ctrlKey: true, deltaY: -100, clientX: 100, clientY: 50 });
    const spy = vi.spyOn(e, 'preventDefault');
    svg.dispatchEvent(e);
    const want = computeZoomAt(1, 0, 0, 1.1, 100, 50);
    const t = parseTransform();
    expect(t.scale).toBeCloseTo(want.scale, 4);
    expect(t.tx).toBeCloseTo(want.tx, 4);
    expect(t.ty).toBeCloseTo(want.ty, 4);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('meta+wheel deltaY>0：缩小（×1/1.1）', () => {
    vp.attach();
    svg.dispatchEvent(wheelEvent({ metaKey: true, deltaY: 100, clientX: 0, clientY: 0 }));
    expect(parseTransform().scale).toBeCloseTo(1 / 1.1, 4);
  });

  it('无修饰 wheel：平移 panBy(-deltaX, -deltaY)，不缩放', () => {
    vp.attach();
    svg.dispatchEvent(wheelEvent({ deltaX: 50, deltaY: 120 }));
    const t = parseTransform();
    expect(t.tx).toBeCloseTo(-50, 4);
    expect(t.ty).toBeCloseTo(-120, 4);
    expect(t.scale).toBe(1);
  });

  it('attach 两次不重复绑事件（一次滚轮只放大一档）', () => {
    vp.attach();
    vp.attach();
    svg.dispatchEvent(wheelEvent({ ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 }));
    expect(parseTransform().scale).toBeCloseTo(1.1, 4);
  });
});

describe('Viewport 拖拽平移（M7b-W3 平移改道：中键 / 空格+左键）', () => {
  it('无修饰左键空白拖拽不平移（空白左拖=框选，归页面层 SelectionModel）', () => {
    vp.attach();
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 25, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 60, clientY: 25, pointerId: 1 }));
    expect(parseTransform()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it('中键拖拽 → 平移量 = 位移增量，pointerup 后停止；pointerdown preventDefault（抑制自动滚动）', () => {
    vp.attach();
    const down = pointerEvent('pointerdown', { button: 1, clientX: 10, clientY: 10, pointerId: 1, cancelable: true });
    const spy = vi.spyOn(down, 'preventDefault');
    svg.dispatchEvent(down);
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 60, clientY: 25, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 60, clientY: 25, pointerId: 1 }));
    const t = parseTransform();
    expect(t.tx).toBeCloseTo(50, 4);
    expect(t.ty).toBeCloseTo(15, 4);
    expect(spy).toHaveBeenCalledOnce();

    // 抬起后再移动不再平移
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 200, pointerId: 1 }));
    const t2 = parseTransform();
    expect(t2.tx).toBeCloseTo(50, 4);
    expect(t2.ty).toBeCloseTo(15, 4);
  });

  it('中键在节点目标上拖拽也平移（节点拖拽只认主键，中键不冲突）', () => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-node-id', 'n1');
    const rect = document.createElementNS(SVG_NS, 'rect');
    g.appendChild(rect);
    sceneRoot.appendChild(g);
    vp.attach();
    rect.dispatchEvent(pointerEvent('pointerdown', { button: 1, clientX: 10, clientY: 10, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 90, clientY: 90, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 90, clientY: 90, pointerId: 1 }));
    const t = parseTransform();
    expect(t.tx).toBeCloseTo(80, 4);
    expect(t.ty).toBeCloseTo(80, 4);
  });

  it('空格按住 + 左键空白拖拽 → 平移；keyup 后左键拖拽恢复为不平移', () => {
    vp.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(vp.spacePressed).toBe(true);
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 45, clientY: 30, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 45, clientY: 30, pointerId: 1 }));
    let t = parseTransform();
    expect(t.tx).toBeCloseTo(40, 4);
    expect(t.ty).toBeCloseTo(25, 4);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    expect(vp.spacePressed).toBe(false);
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 2 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 105, clientY: 105, pointerId: 2 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 105, clientY: 105, pointerId: 2 }));
    t = parseTransform();
    expect(t.tx).toBeCloseTo(40, 4);
    expect(t.ty).toBeCloseTo(25, 4);
  });

  it('空格按住时 repeat keydown 不翻转状态，window blur 复位', () => {
    vp.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' })); // 多余 keyup 不出错
    expect(vp.spacePressed).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true }));
    // repeat 不置位（按住期间 OS 重复事件不干扰状态机）
    expect(vp.spacePressed).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(vp.spacePressed).toBe(true);
    window.dispatchEvent(new Event('blur'));
    expect(vp.spacePressed).toBe(false);
  });

  it('空格按住 + 左键在节点/概要/折叠徽标目标上不平移（左键仍归节点手势/页面层）', () => {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-node-id', 'n1');
    sceneRoot.appendChild(g);
    const badge = document.createElementNS(SVG_NS, 'g');
    badge.setAttribute('data-for-id', 'n1');
    sceneRoot.appendChild(badge);
    vp.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    badge.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 70, clientY: 70, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 70, clientY: 70, pointerId: 1 }));
    expect(parseTransform()).toEqual({ tx: 0, ty: 0, scale: 1 });
  });

  it('spacePressed 随 destroy 复位（状态不跨生命周期残留）', () => {
    vp.attach();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(vp.spacePressed).toBe(true);
    vp.destroy();
    expect(vp.spacePressed).toBe(false);
  });

  it('无修饰左键在节点目标上也不平移（左键只做选择/节点拖拽，平移已改道）', () => {
    // 语义注记：无修饰左键无论目标是否节点都不平移（平移改道后左键只做选择/拖拽）
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('data-node-id', 'n1');
    const rect = document.createElementNS(SVG_NS, 'rect');
    g.appendChild(rect);
    sceneRoot.appendChild(g);
    vp.attach();
    rect.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 10, clientY: 10, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 90, clientY: 90, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 90, clientY: 90, pointerId: 1 }));
    const t = parseTransform();
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
  });

  it('非主键（button=2）不启动拖拽平移', () => {
    vp.attach();
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 2, clientX: 10, clientY: 10, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 80, clientY: 80, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 80, clientY: 80, pointerId: 1 }));
    const t = parseTransform();
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
  });

  it('Shift+主键空白按下不平移（框选/加选语义归页面层）', () => {
    vp.attach();
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 0, shiftKey: true, clientX: 10, clientY: 10, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { shiftKey: true, clientX: 80, clientY: 80, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { shiftKey: true, clientX: 80, clientY: 80, pointerId: 1 }));
    const t = parseTransform();
    expect(t.tx).toBe(0);
    expect(t.ty).toBe(0);
  });
});

describe('Viewport destroy 生命周期', () => {
  it('destroy 后滚轮与指针事件不再改状态', () => {
    vp.attach();
    vp.destroy();
    const before = sceneRoot.getAttribute('transform');
    svg.dispatchEvent(wheelEvent({ ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 }));
    svg.dispatchEvent(wheelEvent({ deltaX: 10, deltaY: 10 }));
    svg.dispatchEvent(pointerEvent('pointerdown', { button: 0, clientX: 1, clientY: 1, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointermove', { clientX: 90, clientY: 90, pointerId: 1 }));
    svg.dispatchEvent(pointerEvent('pointerup', { clientX: 90, clientY: 90, pointerId: 1 }));
    expect(sceneRoot.getAttribute('transform')).toBe(before);
  });

  it('未 attach 直接 destroy 不抛错，可再 attach 复用', () => {
    expect(() => vp.destroy()).not.toThrow();
    vp.attach();
    svg.dispatchEvent(wheelEvent({ ctrlKey: true, deltaY: -100, clientX: 0, clientY: 0 }));
    expect(parseTransform().scale).toBeCloseTo(1.1, 4);
  });
});
