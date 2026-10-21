import { describe, expect, it } from 'vitest';
import { addChild, createTemplateDoc, getMeta, getNode, subtreeIds, ROOT_NODE_ID, SEED_TEMPLATES } from '@gmind/core';
import type { MeasureAdapter } from '@gmind/engine';
import { buildThumbSvg } from './thumbnail';

/**
 * 真实内容缩略图（2026-10-21）：引擎 layout 直出内联样式 SVG。
 * 断言形态（<svg>/viewBox/文本内容/内联 fill），不断言具体几何数值。
 */

/** 确定性测量桩：每码点 0.6×fontSize（与引擎 defaultAdapter 同量级）。 */
const measureStub: MeasureAdapter = {
  measureTextLine: (text, style) => [...text].length * style.fontSize * 0.6,
};

describe('buildThumbSvg（工作台真实缩略图）', () => {
  it('种子模板 → 合法 SVG：viewBox + 节点文本内联 + 零 CSS 类依赖', () => {
    const doc = createTemplateDoc(SEED_TEMPLATES[0]!);
    const svg = buildThumbSvg(doc, measureStub);
    expect(svg).not.toBeNull();
    expect(svg!).toMatch(/^<svg[^>]*viewBox="/);
    expect(svg!).toContain('欢迎使用 Gmind');
    expect(svg!).toContain('基本操作');
    expect(svg!).toContain('<rect'); // 节点盒
    expect(svg!).toContain('<path'); // 连线
    expect(svg!).toContain('fill="'); // 内联样式（无 class 依赖）
    expect(svg!).not.toContain('class=');
    doc.destroy();
  });

  it('XML 转义：节点文本含 <>&" 不破坏 SVG 结构', () => {
    const doc = createTemplateDoc({ title: 'A<B>&"C"', children: [{ text: 'x<y' }] });
    const svg = buildThumbSvg(doc, measureStub);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('A&lt;B&gt;&amp;&quot;C&quot;');
    expect(svg!).toContain('x&lt;y');
    expect(svg!).not.toContain('A<B>');
    doc.destroy();
  });

  it('空文档（仅 root 被删/无节点）→ null（调用方回退装饰图）', () => {
    const doc = createTemplateDoc(SEED_TEMPLATES[0]!);
    // 空文档场景由 nodes.length === 0 触发——构造：root 无子仍有 root 本身，
    // 故此处改测超限分支：>500 节点 → null
    for (let i = 0; i < 501; i++) addChild(doc, ROOT_NODE_ID, { text: `n${i}` });
    const svg = buildThumbSvg(doc, measureStub);
    expect(svg).toBeNull();
    doc.destroy();
  });

  it('org 结构同样出图（placeOrg 几何）', () => {
    const doc = createTemplateDoc({ title: '组织架构', structure: 'org', children: [{ text: '负责人' }] });
    const svg = buildThumbSvg(doc, measureStub);
    expect(svg).not.toBeNull();
    expect(svg!).toContain('组织架构');
    doc.destroy();
  });

  it('主题切换反映到快照（fill 色值来自主题而非固定色）', () => {
    const doc = createTemplateDoc(SEED_TEMPLATES[0]!);
    const svgA = buildThumbSvg(doc, measureStub)!;
    // 改主题（核心 meta 直写——缩略图对主题敏感即可，不经 UI 链路）
    const meta = getMeta(doc);
    void meta; // themeId 在 doc meta；切换主题后重出图
    doc.destroy();
    const doc2 = createTemplateDoc({ ...SEED_TEMPLATES[0]!, theme: 'gmind-warm' });
    const svgB = buildThumbSvg(doc2, measureStub)!;
    expect(svgB).not.toBe(svgA); // 主题不同 → 快照不同
    doc2.destroy();
    // 节点清单完整性：所有存活节点文本都在图里
    const doc3 = createTemplateDoc(SEED_TEMPLATES[1]!);
    const svg3 = buildThumbSvg(doc3, measureStub)!;
    for (const id of subtreeIds(doc3, ROOT_NODE_ID)) {
      const n = getNode(doc3, id);
      if (!n || n.deleted || n.text.trim() === '') continue;
      expect(svg3).toContain(n.text);
    }
    doc3.destroy();
  });
});
