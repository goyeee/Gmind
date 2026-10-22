import { describe, expect, it } from 'vitest';
import {
  addCanvas,
  addChild,
  createTemplateDoc,
  getNode,
  listCanvases,
  ORIGIN_USER,
  rootIdOf,
  setActiveCanvas,
} from '@gmind/core';
import { collectMatchIds } from './FindReplace';

/**
 * 查找替换匹配集口径（多画布计划三 Task 4，item 6）：
 * collectMatchIds 只收集**当前画布**子树内的匹配节点（root 计入），
 * 不越画布；canvasId 缺省走 core 缺省解析（meta.activeCanvasId 回退链）。
 */

function makeTwoCanvasDoc(): { doc: ReturnType<typeof createTemplateDoc>; c1: string; c2: string } {
  const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
  const c1 = listCanvases(doc)[0]!.id;
  const c2 = addCanvas(doc, { name: '画布 2' });
  setActiveCanvas(doc, c1); // addCanvas 会把活动置新，固定回首画布
  const r2 = rootIdOf(doc, c2);
  addChild(doc, r2, { text: '乙' }, ORIGIN_USER, c2);
  addChild(doc, r2, { text: '甲乙' }, ORIGIN_USER, c2);
  return { doc, c1, c2 };
}

describe('collectMatchIds（当前画布口径，Task 4 item 6）', () => {
  it('限定画布：只命中该画布子树，异画布同文节点不入集', () => {
    const { doc, c1, c2 } = makeTwoCanvasDoc();
    const inC1 = collectMatchIds(doc, '甲', c1);
    const inC2 = collectMatchIds(doc, '甲', c2);
    expect(inC1).toHaveLength(1); // 仅「甲」（root「本周计划」不含关键字）
    expect(inC2).toHaveLength(1); // 仅「甲乙」：画布 1 的「甲」不越画布命中
    doc.destroy();
  });

  it('匹配 id 落在限定画布子图内（写路径 setText(..., canvasId) 可直接读回）', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    const ids = collectMatchIds(doc, '甲', c2);
    expect(ids).toHaveLength(1);
    expect(getNode(doc, ids[0]!, c2)?.text).toBe('甲乙');
    doc.destroy();
  });

  it('空查询返回空集（现状口径不动）', () => {
    const { doc, c2 } = makeTwoCanvasDoc();
    expect(collectMatchIds(doc, '', c2)).toEqual([]);
    doc.destroy();
  });

  it('缺省 canvasId = core 缺省解析（meta.activeCanvasId=画布 1 → 命中画布 1）', () => {
    const { doc } = makeTwoCanvasDoc();
    expect(collectMatchIds(doc, '甲')).toHaveLength(1); // 画布 1 的「甲」
    doc.destroy();
  });
});
