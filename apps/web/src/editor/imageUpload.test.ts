import { describe, expect, it } from 'vitest';
import { clampImageSize, IMAGE_MAX_EDGE, imageFileFromClipboard } from './imageUpload';

/**
 * 图片粘贴取图（FR-EDT-020 截图粘贴入口）+ ≤200px 等比钳制。
 *
 * `imageFileFromClipboard` 的 files→items 并集是 2026-10-15 缺陷修复的防御性兜底：
 * 根因（keydown 抑制原生 paste 事件）修好后，这条通道才真正被走到；部分 Windows
 * 应用只把位图挂在 items 上、files 为空，只读 files 会静默吞掉粘贴。
 */

/** 组装最小 DataTransfer 替身（Node 无 DataTransfer；只覆盖本函数用到的面）。 */
function fakeClipboard(opts: {
  files?: File[];
  items?: { kind: string; type: string; file: File | null }[];
}): DataTransfer {
  return {
    files: opts.files ?? [],
    items: (opts.items ?? []).map((i) => ({
      kind: i.kind,
      type: i.type,
      getAsFile: () => i.file,
    })),
  } as unknown as DataTransfer;
}

const png = (name: string): File => new File(['x'], name, { type: 'image/png' });

describe('imageFileFromClipboard（取第一张图片文件）', () => {
  it('null / 空剪贴板 → null（不抛）', () => {
    expect(imageFileFromClipboard(null)).toBeNull();
    expect(imageFileFromClipboard(fakeClipboard({}))).toBeNull();
  });

  it('files 里有图片 → 直接取（截图工具的常规路径）', () => {
    const f = png('shot.png');
    expect(imageFileFromClipboard(fakeClipboard({ files: [f] }))).toBe(f);
  });

  it('files 里只有非图片 → 不看 items 的非 file 项，返回 null', () => {
    const txt = new File(['t'], 'a.txt', { type: 'text/plain' });
    expect(
      imageFileFromClipboard(
        fakeClipboard({
          files: [txt],
          items: [{ kind: 'string', type: 'text/plain', file: null }],
        }),
      ),
    ).toBeNull();
  });

  it('files 为空但 items 挂着位图 → 从 items 兜底取（Windows 部分应用，缺陷修复新增）', () => {
    const f = png('bitmap.png');
    expect(
      imageFileFromClipboard(
        fakeClipboard({
          files: [],
          items: [
            { kind: 'string', type: 'text/html', file: null },
            { kind: 'file', type: 'image/png', file: f },
          ],
        }),
      ),
    ).toBe(f);
  });

  it('items 声明 image 但 getAsFile() 为 null → 跳过，不崩', () => {
    expect(
      imageFileFromClipboard(
        fakeClipboard({ items: [{ kind: 'file', type: 'image/png', file: null }] }),
      ),
    ).toBeNull();
  });

  it('多张图片 → 取第一张（确定性）', () => {
    const a = png('a.png');
    const b = png('b.png');
    expect(imageFileFromClipboard(fakeClipboard({ files: [a, b] }))).toBe(a);
  });
});

describe('clampImageSize（≤200px 等比钳制）', () => {
  it('小图原样（长边不足 200 不放大）', () => {
    expect(clampImageSize(16, 64)).toEqual({ w: 16, h: 64 });
  });

  it('大图等比缩到长边 200', () => {
    expect(clampImageSize(400, 100)).toEqual({ w: IMAGE_MAX_EDGE, h: 50 });
    expect(clampImageSize(100, 400)).toEqual({ w: 50, h: IMAGE_MAX_EDGE });
  });

  it('0 尺寸不产出 0（至少 1px，否则不可见）', () => {
    expect(clampImageSize(0, 0)).toEqual({ w: 1, h: 1 });
  });
});
