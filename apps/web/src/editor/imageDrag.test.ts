import { describe, expect, it } from 'vitest';
import {
  findImageNode,
  findNodeAt,
  ghostRect,
  guideLayoutOf,
  placementAt,
  rectContains,
  GHOST_MAX_SCREEN,
  GUIDE_BAND_MAX,
} from './imageDrag';

/**
 * 图片拖拽换位几何（2026-10-20 图文四槽位）：引导带、命中槽位、ghost 等比 ——
 * 纯函数口径，DOM 绘制由 e2e 兜底。
 */

const box = { x: 10, y: 20, w: 108, h: 88 };

describe('guideLayoutOf / placementAt（四侧引导带）', () => {
  it('内容区盒内缩 padX；四带厚度 = clamp(min(w,h)/4, 18, 56)', () => {
    const layout = guideLayoutOf(box, 8);
    expect(layout.content).toEqual({ x: 18, y: 28, w: 92, h: 72 });
    const t = Math.min(GUIDE_BAND_MAX, Math.min(92, 72) / 4); // 18
    expect(layout.bands.top).toEqual({ x: 18, y: 28, w: 92, h: t });
    expect(layout.bands.bottom).toEqual({ x: 18, y: 28 + 72 - t, w: 92, h: t });
    expect(layout.bands.left).toEqual({ x: 18, y: 28, w: t, h: 72 });
    expect(layout.bands.right).toEqual({ x: 18 + 92 - t, y: 28, w: t, h: 72 });
  });

  it('内容区过小时回退整盒；带厚保底 18（允许重叠，不产生 0 尺寸带）', () => {
    const tiny = guideLayoutOf({ x: 0, y: 0, w: 10, h: 10 }, 8);
    expect(tiny.content).toEqual({ x: 0, y: 0, w: 10, h: 10 });
    expect(tiny.bands.top.h).toBe(18);
  });

  it('命中：指针在带中心即该槽位；四角重叠按最近中心确定（顺序固定）', () => {
    const layout = guideLayoutOf(box, 8);
    const c = layout.content;
    expect(placementAt(layout, { x: c.x + c.w / 2, y: c.y + 1 })).toBe('top');
    expect(placementAt(layout, { x: c.x + c.w / 2, y: c.y + c.h - 1 })).toBe('bottom');
    expect(placementAt(layout, { x: c.x + 1, y: c.y + c.h / 2 })).toBe('left');
    expect(placementAt(layout, { x: c.x + c.w - 1, y: c.y + c.h / 2 })).toBe('right');
    // 右下角：bottom/right 带中心距离对称时按 top→bottom→left→right 取先者
    const corner = { x: c.x + c.w - 1, y: c.y + c.h - 1 };
    const d = (band: { x: number; y: number; w: number; h: number }): number =>
      (corner.x - (band.x + band.w / 2)) ** 2 + (corner.y - (band.y + band.h / 2)) ** 2;
    const expected = d(layout.bands.bottom) <= d(layout.bands.right) ? 'bottom' : 'right';
    expect(placementAt(layout, corner)).toBe(expected);
  });
});

describe('findNodeAt / findImageNode（命中优先级）', () => {
  const boxes = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 100, y: 0, w: 100, h: 100 },
  ];

  it('节点命中取倒序（后绘制者在上），边界含端点', () => {
    expect(findNodeAt(boxes, { x: 50, y: 50 })?.id).toBe('a');
    expect(findNodeAt(boxes, { x: 150, y: 50 })?.id).toBe('b');
    expect(findNodeAt(boxes, { x: 300, y: 50 })).toBeNull();
  });

  it('图片命中：无图节点跳过；按图片矩形（非整盒）判定', () => {
    const images: Record<string, { w: number; h: number } | null> = {
      a: null,
      b: { w: 40, h: 40 },
    };
    const rectOf = (b: (typeof boxes)[number], img: { w: number; h: number }) => ({
      x: b.x + 8,
      y: b.y + 40,
      w: img.w,
      h: img.h,
    });
    expect(findImageNode(boxes, (id) => images[id], rectOf, { x: 50, y: 50 })).toBeNull();
    expect(findImageNode(boxes, (id) => images[id], rectOf, { x: 120, y: 60 })?.nodeId).toBe('b');
  });
});

describe('ghostRect / rectContains', () => {
  it('ghost 最长边 = 96 屏幕像素（按 scale 换算场景单位），等比且以指针为中心', () => {
    const odd = ghostRect({ x: 100, y: 100 }, { w: 16, h: 64 }, 1);
    expect(Math.max(odd.w, odd.h)).toBe(GHOST_MAX_SCREEN);
    expect(odd.h / odd.w).toBeCloseTo(4, 5);
    expect(odd.x + odd.w / 2).toBe(100);
    expect(odd.y + odd.h / 2).toBe(100);
    const zoomed = ghostRect({ x: 0, y: 0 }, { w: 16, h: 64 }, 2);
    expect(Math.max(zoomed.w, zoomed.h)).toBe(GHOST_MAX_SCREEN / 2);
  });

  it('rectContains 含边界', () => {
    expect(rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10 })).toBe(true);
    expect(rectContains({ x: 0, y: 0, w: 10, h: 10 }, { x: 10.1, y: 5 })).toBe(false);
  });
});
