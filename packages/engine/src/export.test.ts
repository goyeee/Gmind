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
});
