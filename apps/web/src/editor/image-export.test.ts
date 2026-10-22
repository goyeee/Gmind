import { describe, expect, it } from 'vitest';
import { addCanvas, createTemplateDoc, listCanvases, setActiveCanvas } from '@gmind/core';
import { imageExportFileName } from './image-export';

/**
 * PNG/JPG 导出文件名口径（多画布计划三 Task 4，item 8）：
 * 单画布 = 文件标题（现状不动，e2e import-export 既有断言同源）；
 * 多画布 = 文件标题＋画布名（画布名取导出作用画布——与导出像素同口径）。
 */

function makeTwoCanvasDoc(): { doc: ReturnType<typeof createTemplateDoc>; c1: string; c2: string } {
  const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
  const c1 = listCanvases(doc)[0]!.id;
  const c2 = addCanvas(doc, { name: '画布 2' });
  setActiveCanvas(doc, c1);
  return { doc, c1, c2 };
}

describe('imageExportFileName（导出文件名当前画布口径）', () => {
  it('单画布：文件名 = 文件标题（现状回归护栏）', () => {
    const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
    expect(imageExportFileName(doc, '本周计划')).toBe('本周计划');
    expect(imageExportFileName(doc, '本周计划', listCanvases(doc)[0]!.id)).toBe('本周计划');
    doc.destroy();
  });

  it('多画布：文件名 = 文件标题＋导出画布名', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    expect(imageExportFileName(doc, '本周计划', c2)).toBe('本周计划-画布 2');
    doc.destroy();
  });

  it('多画布缺省 canvasId：按 meta.activeCanvasId 作用画布命名（与导出像素同口径）', () => {
    const { doc, c1 } = makeTwoCanvasDoc();
    setActiveCanvas(doc, c1);
    expect(imageExportFileName(doc, '本周计划')).toBe('本周计划-画布 1'); // 多画布恒带画布名
    doc.destroy();
  });

  it('多画布缺省 canvasId：活动画布非首画布 → 带活动画布名', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    setActiveCanvas(doc, c2);
    expect(imageExportFileName(doc, '本周计划')).toBe('本周计划-画布 2');
    doc.destroy();
  });
});
