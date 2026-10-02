import { beforeEach, describe, expect, it } from 'vitest';
import { exportSceneSvg } from './export';
import type { DocReader, NodeSnapshotLike } from './types';

// ---------------------------------------------------------------------------
// 固定桩：手工 DocReader（engine 不依赖 yjs；结构与 NodeSnapshotLike 严格一致）。
// ---------------------------------------------------------------------------

const STUB_NODES = new Map<string, NodeSnapshotLike>([
  ['root', { id: 'root', text: '根主题', parentId: '', childIds: ['a', 'b'], collapsed: false, deleted: false }],
  ['a', { id: 'a', text: '分支A', parentId: 'root', childIds: [], collapsed: false, deleted: false }],
  ['b', { id: 'b', text: '分支B\n第二行', parentId: 'root', childIds: [], collapsed: false, deleted: false }],
]);

function stubReader(): DocReader {
  return {
    getMeta: () => ({ title: 'T', structureType: 'mindmap', themeId: 'gmind-light' }),
    getNode: (id) => STUB_NODES.get(id) ?? null,
    childrenIds: (id) => STUB_NODES.get(id)?.childIds ?? [],
  };
}

let existingSvg: SVGSVGElement;

beforeEach(() => {
  document.body.innerHTML = '';
  // 既有场景容器：预置一个子元素，导出后必须原样保留（不污染）。
  existingSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  existingSvg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'rect'));
  document.body.appendChild(existingSvg);
});

describe('exportSceneSvg（M4 Task 9，FR-IO-003）', () => {
  it('exportSceneSvg：序列化含根文本、xmlns、正尺寸；不污染既有场景容器', () => {
    const { svg, width, height } = exportSceneSvg(stubReader(), {
      structure: 'mindmap',
      themeId: 'gmind-light',
    });
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('根主题');
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    // 尺寸属性与返回值一致（web 侧按其取 Canvas 尺寸）
    expect(svg).toContain(`width="${width}"`);
    expect(svg).toContain(`height="${height}"`);
    // 不污染既有场景容器：预置子元素原样保留，导出产物在独立 detached 容器中
    expect(existingSvg.children).toHaveLength(1);
    expect(existingSvg.firstChild?.nodeName).toBe('rect');
    // 子节点也在产物中（分支A）
    expect(svg).toContain('分支A');
  });

  it('exportSceneSvg：org 结构与未知 themeId 兜底同样可序列化', () => {
    const { svg, width, height } = exportSceneSvg(stubReader(), {
      structure: 'org',
      themeId: 'unknown-theme',
    });
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  // M6 终审 Important 修复钉定：PNG/JPG 导出丢概要。reader 带 summaries 时概要必须
  // 入产物（web 侧 readerOf 缺 summaries 时 layout 拿不到概要、静默丢）；且导出边界
  // 必须容纳概要绘制范围——画布 fit-to-view 的 contentBounds 只按节点盒（M6 T6 裁决
  // 「概要不扩画布边界」），导出是静态整图截图，需按布局结果的 summaries 自行外扩。
  // 2026-10-01 反馈任务 1 起双形态：同侧（mindmap/logic）= 竖向花括号（成员列外侧，
  // 尖端旁 chip）→ 右向外扩；跨侧 / org = 旧横括线（片段下方，label 基线 +14）→
  // 下探外扩。
  it('exportSceneSvg：概要入产物；竖括号形态（同侧）右向容纳 brace+chip', () => {
    const reader: DocReader = {
      ...stubReader(),
      summaries: () => [{ id: 'sum-1', nodeIds: ['a', 'b'], label: '归纳' }],
    };
    const { svg } = exportSceneSvg(reader, {
      structure: 'mindmap',
      themeId: 'gmind-light',
    });
    // ① 概要元素与 chip 标签文本在序列化产物中（同时钉住 DocReader.summaries 契约）
    expect(svg).toContain('data-summary-id="sum-1"');
    expect(svg).toContain('gm-summary-chip');
    expect(svg).toContain('归纳');
    // ② 尺寸口径：a/b 同为 root 直接子级 index 0/1 → 全右列 → 竖括号形态。导出包围
    //    盒右缘（viewBox minX + width）必须 ≥ 片段右缘 + 脊线间隙 6 + 深 10 + chip
    //    间隙 6 + chip 全宽（labelW=2 兜底 + 内边距 16 = 18），否则括号/chip 被裁。
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const rightOf = (id: string): number => {
      const g = parsed.querySelector(`[data-node-id="${id}"]`);
      expect(g).not.toBeNull();
      const m = /translate\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(g?.getAttribute('transform') ?? '');
      const rect = g?.querySelector('rect');
      expect(m).not.toBeNull();
      expect(rect).not.toBeNull();
      return Number(m?.[1]) + Number(rect?.getAttribute('width'));
    };
    const fragmentRight = Math.max(rightOf('a'), rightOf('b'));
    const viewBox = parsed.documentElement.getAttribute('viewBox');
    expect(viewBox).toBeTruthy();
    const [minXStr, , wStr] = (viewBox as string).split(/\s+/);
    expect(Number(minXStr) + Number(wStr)).toBeGreaterThanOrEqual(fragmentRight + 6 + 10 + 6 + 18);
  });

  it('exportSceneSvg：横括线形态（org）导出边界容纳其下探（bbox 底 ≥ 片段底+26）', () => {
    const reader: DocReader = {
      ...stubReader(),
      summaries: () => [{ id: 'sum-1', nodeIds: ['a', 'b'], label: '归纳' }],
    };
    const { svg, height } = exportSceneSvg(reader, {
      structure: 'org',
      themeId: 'gmind-light',
    });
    expect(svg).toContain('data-summary-id="sum-1"');
    // 片段底 = 概要成员（a/b）盒底最大值，导出包围盒底（viewBox minY + height）必须
    // ≥ 片段底+26（12 gap + 14 label 基线），否则 bracket 被裁。
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const bottomOf = (id: string): number => {
      const g = parsed.querySelector(`[data-node-id="${id}"]`);
      expect(g).not.toBeNull();
      const m = /translate\((-?[\d.]+),\s*(-?[\d.]+)\)/.exec(g?.getAttribute('transform') ?? '');
      const rect = g?.querySelector('rect');
      expect(m).not.toBeNull();
      expect(rect).not.toBeNull();
      return Number(m?.[2]) + Number(rect?.getAttribute('height'));
    };
    const fragmentBottom = Math.max(bottomOf('a'), bottomOf('b'));
    const viewBox = parsed.documentElement.getAttribute('viewBox');
    expect(viewBox).toBeTruthy();
    const minY = Number(viewBox?.split(/\s+/)[1]);
    expect(minY + height).toBeGreaterThanOrEqual(fragmentBottom + 26);
  });
});
