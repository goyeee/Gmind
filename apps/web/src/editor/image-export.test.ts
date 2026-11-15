// @vitest-environment jsdom（stripCollapseToggles 走 DOMParser/XMLSerializer）
import { describe, expect, it } from 'vitest';
import { addCanvas, createTemplateDoc, listCanvases, setActiveCanvas } from '@gmind/core';
import { imageExportFileName, stripCollapseToggles } from './image-export';

/**
 * JPG 导出文件名口径（PNG 2026-11-15 退役；被测函数与格式无关）（多画布计划三 Task 4，item 8）：
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

/** 最小导出 SVG（与 engine render.ts 结构同形）：一个普通节点矩形 + 折叠节点的
 *  「+N」徽标（g.gm-collapse-badge）+ 展开父节点的交互切换钮（g.gm-collapse-toggle，
 *  内含命中圆/前景钮两层嵌套）。 */
const BADGE_TOGGLE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60">',
  '<rect class="gm-node-bg" x="1" y="2" width="30" height="12" rx="4"/>',
  '<g class="gm-collapse-badge" data-for-id="n-folded"><rect width="22" height="14" rx="7"/><text x="11" y="11">+3</text></g>',
  '<g class="gm-collapse-toggle" data-for-id="n-open"><circle class="gm-collapse-toggle-hit" cx="9" cy="9" r="14" fill="transparent"/><g class="gm-collapse-toggle-fg"><circle class="gm-collapse-toggle-btn" cx="9" cy="9" r="8"/><text x="9" y="13">-</text></g></g>',
  '</svg>',
].join('');

describe('stripCollapseToggles（2026-11-15 导出按折叠态裁定：图里剥交互钮、保 +N 徽标）', () => {
  it('toggle 整组剥离（嵌套 hit/fg/btn 随组消失），badge 与其余节点原样', () => {
    const out = stripCollapseToggles(BADGE_TOGGLE_SVG);
    const dom = new DOMParser().parseFromString(out, 'image/svg+xml');
    // toggle 整组消失：组本身与嵌套元素都不残留孤儿
    expect(dom.querySelectorAll('g.gm-collapse-toggle')).toHaveLength(0);
    expect(
      dom.querySelectorAll(
        '.gm-collapse-toggle-hit,.gm-collapse-toggle-fg,.gm-collapse-toggle-btn',
      ),
    ).toHaveLength(0);
    // badge 保留：+N 文本与归属节点 id 原样
    const badge = dom.querySelector('g.gm-collapse-badge');
    expect(badge?.getAttribute('data-for-id')).toBe('n-folded');
    expect(badge?.querySelector('text')?.textContent).toBe('+3');
    // 其余节点原样：普通节点矩形不受牵连
    const rect = dom.querySelector('rect.gm-node-bg');
    expect(rect?.getAttribute('x')).toBe('1');
    expect(rect?.getAttribute('class')).toBe('gm-node-bg');
  });

  it('多组 toggle 全剥、幂等（已剥离 SVG 二次处理零变化）', () => {
    const twoToggles = BADGE_TOGGLE_SVG.replace(
      '</svg>',
      '<g class="gm-collapse-toggle" data-for-id="n-open-2"><circle class="gm-collapse-toggle-hit" r="4"/></g></svg>',
    );
    const once = stripCollapseToggles(twoToggles);
    expect(new DOMParser().parseFromString(once, 'image/svg+xml').querySelectorAll('g.gm-collapse-toggle')).toHaveLength(0);
    expect(stripCollapseToggles(once)).toBe(once);
  });
});
