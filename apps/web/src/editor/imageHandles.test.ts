import { describe, expect, it } from 'vitest';
import {
  HANDLE_SCREEN_PX,
  IMAGE_CORNERS,
  IMAGE_MIN_EDGE,
  imageSceneRect,
  resizeImageSizeByDelta,
} from './imageHandles';
import { IMAGE_MAX_EDGE } from './imageUpload';

/**
 * 图片缩放手柄几何/尺寸（2026-10-15 需求方「拖拽图片周边改尺寸，可暂时不突破
 * px 上限」）。钳制口径：等比锁定 + 长边 ≤ 200px（FR-EDT-020 不变）+ 短边 ≥ 24px。
 * 2026-10-20 需求方「指哪打哪」：位移 ×2 灵敏度（IMAGE_RESIZE_SENSITIVITY），钳制不变。
 */

describe('imageSceneRect（图片在场景坐标里的矩形）', () => {
  it('盒左上角 + 内边距起画，宽高直取 image.w/h（对齐 render.ts 的 <image> 属性）', () => {
    expect(imageSceneRect({ x: 100, y: 40 }, { w: 16, h: 64 }, 12)).toEqual({
      x: 112,
      y: 40,
      w: 16,
      h: 64,
    });
  });

  it('图文四槽位：偏移取盒 content（imageX/imageTop），无 content 回退旧口径', () => {
    expect(
      imageSceneRect(
        { x: 100, y: 40, content: { imageX: 30, imageTop: 8 } },
        { w: 16, h: 64 },
        12,
      ),
    ).toEqual({ x: 130, y: 48, w: 16, h: 64 });
  });
});

describe('resizeImageSizeByDelta（拖角等比改尺寸 + 上下限钳制 + 位移×2 灵敏度）', () => {
  const start = { w: 16, h: 64 }; // 夹具 pixel.png 的原始尺寸（max edge 64）

  it('四角方向符号：se 向右下放大、nw 向左上放大、ne/sw 同比例镜像（位移×2）', () => {
    const grow = (corner: 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number) =>
      resizeImageSizeByDelta(start, corner, { dx, dy });

    // 拖 (16,64) 经 ×2 = 等效 (32,128) → 放大 3 倍
    expect(grow('se', 16, 64)).toEqual({ w: 48, h: 192 });
    expect(grow('nw', -16, -64)).toEqual({ w: 48, h: 192 });
    expect(grow('ne', 16, -64)).toEqual({ w: 48, h: 192 });
    expect(grow('sw', -16, 64)).toEqual({ w: 48, h: 192 });
  });

  it('等比锁定：两轴需求取较大者（斜拖不缩水），比例继承起始 w/h', () => {
    // dx=16 ×2=32 → 宽需求 3 倍；dy=32 ×2=64 → 高需求 2 倍 → 取 3 倍
    const r = resizeImageSizeByDelta(start, 'se', { dx: 16, dy: 32 });
    expect(r).toEqual({ w: 48, h: 192 });
    expect(r.w / r.h).toBeCloseTo(start.w / start.h, 5);
  });

  it('长边 ≤ 200px（需求方裁定暂不突破 FR-EDT-020 上限）：超拖也钳到 200', () => {
    const r = resizeImageSizeByDelta(start, 'se', { dx: 1000, dy: 1000 });
    expect(Math.max(r.w, r.h)).toBe(IMAGE_MAX_EDGE);
    expect(r).toEqual({ w: 50, h: 200 });
  });

  it('短边下限只阻止缩过头，不反向强迫放大：起始短边 16（已低于下限）向内拖保持原尺寸', () => {
    const r = resizeImageSizeByDelta(start, 'se', { dx: -1000, dy: -1000 });
    expect(r).toEqual({ w: 16, h: 64 });
  });

  it('从大图往回缩：短边钳到 24，长边等比跟随（200×50 → 96×24）', () => {
    const big = { w: 200, h: 50 };
    const r = resizeImageSizeByDelta(big, 'se', { dx: -1000, dy: -1000 });
    expect(r).toEqual({ w: 96, h: 24 });
    expect(Math.min(r.w, r.h)).toBe(IMAGE_MIN_EDGE);
  });

  it('长边已达 200 时只许缩不许涨（上限是硬顶）', () => {
    const capped = { w: 200, h: 50 };
    expect(resizeImageSizeByDelta(capped, 'se', { dx: 500, dy: 500 })).toEqual({
      w: 200,
      h: 50,
    });
  });

  it('零位移 = 尺寸不变（幂等，拖了又拖回原位不产生脏写）', () => {
    expect(resizeImageSizeByDelta(start, 'se', { dx: 0, dy: 0 })).toEqual({
      w: 16,
      h: 64,
    });
  });

  it('退化输入（起始 0 尺寸）不产出 0 或负数（core 侧无第二道防线）', () => {
    const r = resizeImageSizeByDelta({ w: 0, h: 0 }, 'se', { dx: 40, dy: 40 });
    expect(r.w).toBeGreaterThanOrEqual(1);
    expect(r.h).toBeGreaterThanOrEqual(1);
  });
});

describe('手柄常量', () => {
  it('四角齐全且屏幕像素恒定（渲染时按 1/scale 补偿）', () => {
    expect(IMAGE_CORNERS).toEqual(['nw', 'ne', 'sw', 'se']);
    expect(HANDLE_SCREEN_PX).toBeGreaterThan(0);
  });
});
