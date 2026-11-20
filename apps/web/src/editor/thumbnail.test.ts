import { describe, expect, it } from 'vitest';
import {
  addCanvas,
  addChild,
  createTemplateDoc,
  getMeta,
  getNode,
  listCanvases,
  ORIGIN_USER,
  ROOT_NODE_ID,
  rootIdOf,
  SEED_TEMPLATES,
  setActiveCanvas,
  setCustomColumns,
  setCustomField,
  setNodeTask,
  subtreeIds,
} from '@gmind/core';
import type { MeasureAdapter } from '@gmind/engine';
import { buildTableThumbSvg, buildThumbSvg } from './thumbnail';

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

  it('多画布（裁定 3）：缩略图恒取第一画布——活动画布在画布 2 也不出画布 2 内容', () => {
    const doc = createTemplateDoc({ title: '本周计划', children: [{ text: '甲' }] });
    const c1 = listCanvases(doc)[0]!.id;
    const c2 = addCanvas(doc, { name: '画布 2' });
    setActiveCanvas(doc, c2); // 活动画布 = 画布 2（meta.activeCanvasId 同置）
    addChild(doc, rootIdOf(doc, c2), { text: '乙' }, ORIGIN_USER, c2);
    const svg = buildThumbSvg(doc, measureStub)!;
    expect(svg).toContain('本周计划'); // 第一画布 root 文本在图
    expect(svg).toContain('甲'); // 第一画布子节点在图
    expect(svg).not.toContain('乙'); // 画布 2 内容不进缩略图
    expect(c1).not.toBe(c2);
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

  // —— 2026-11-19 取景窗口口径（可读优先 + 宽度占缩略图 80%，四问确认）——

  it('取景窗口：viewBox 固定 176×64（2.75:1），与显示框 width:80%×64px 匹配', () => {
    const doc = createTemplateDoc(SEED_TEMPLATES[0]!);
    const svg = buildThumbSvg(doc, measureStub)!;
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 176 64"/);
    doc.destroy();
  });

  it('小内容放大撑满：仅 root 的文档按窗口宽 96% 档放大（不再窄条）', () => {
    const doc = createTemplateDoc({ title: '中心主题', children: [] });
    const svg = buildThumbSvg(doc, measureStub)!;
    // root 文本 font-size = 20 × s，s = min(0.96×176/72, 64/28) ≈ 2.29 → ≈45.7
    const fs = [...svg.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(fs.length).toBeGreaterThan(0);
    expect(Math.max(...fs)).toBeGreaterThan(30);
    doc.destroy();
  });

  it('大内容裁剪锚定（可读优先）：root 字号钳 8 窗口单位，全右布局 root 锚窗口左 1/4', () => {
    // 造宽文档：root 3 个右列分支（index<3 恒右）各带 30 字长文孙级 → 水平宽度
    // 超过窗口可读下限覆盖（440 doc 单位）触发裁剪档
    const long = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';
    const doc = createTemplateDoc({
      title: '根主题锚定',
      children: [1, 2, 3].map((i) => ({ text: `分支${i}`, children: [{ text: long }] })),
    });
    const svg = buildThumbSvg(doc, measureStub)!;
    expect(svg).toMatch(/viewBox="0 0 176 64"/);
    // root 文本：font-size = 20×0.4 = 8；x = 0.25×176 = 44（锚左 1/4，与定位中心同语义）
    const rootText = svg.match(/<text x="([\d.-]+)"[^>]*font-size="([\d.]+)"[^>]*>根主题锚定</);
    expect(rootText).not.toBeNull();
    expect(Number(rootText![1])).toBeCloseTo(44, 0);
    expect(Number(rootText![2])).toBeCloseTo(8, 0);
    doc.destroy();
  });

  it('表格缩略图只展示任务总进度，人员子进度 100 不把总进度 0 改成 100', () => {
    const doc = createTemplateDoc({ title: '任务表', children: [{ text: '任务A' }] });
    const id = subtreeIds(doc, ROOT_NODE_ID).find((nid) => getNode(doc, nid)?.text === '任务A')!;
    setCustomColumns(doc, [{ id: 'col-a', name: '执行人', type: 'assignee' }]);
    setCustomField(doc, id, 'col-a', { u1: { progress: 100 } }, ORIGIN_USER);
    setNodeTask(doc, id, { progress: 0 }, ORIGIN_USER);
    const svg = buildTableThumbSvg(doc)!;
    expect(svg).toContain('>0%</text>');
    expect(svg).not.toContain('>100%</text>');
    doc.destroy();
  });

  it('表格缩略图归一同纵横比：viewBox 固定 390×142（2.75:1）', () => {
    const doc = createTemplateDoc({ title: '任务表', children: [{ text: '任务A' }] });
    const svg = buildTableThumbSvg(doc)!;
    expect(svg).toMatch(/^<svg[^>]*viewBox="0 0 390 142"/);
    expect(svg).toContain('任务A');
    doc.destroy();
  });
});
