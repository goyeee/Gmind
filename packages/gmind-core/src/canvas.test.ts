import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LEGACY_CANVAS_ID,
  MAX_CANVAS_NAME_LENGTH,
  canvasMapOf,
  canvasNodesMap,
  canvasOrderArr,
  canvasesMap,
  ensureCanvasShape,
  listCanvases,
  resolveCanvasId,
  rootIdOf,
} from './canvas';

/** 手工搭一个双画布 doc（canvases + canvasOrder + meta），模拟迁移后的多画布结构。 */
function buildTwoCanvasDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const c1 = new Y.Map<unknown>();
    c1.set('name', '画布一');
    c1.set('rootId', 'root');
    c1.set('structureType', 'mindmap');
    c1.set('themeId', 'gmind-light');
    c1.set('nodes', new Y.Map());
    c1.set('summaries', new Y.Map());
    const c2 = new Y.Map<unknown>();
    c2.set('name', '画布二');
    c2.set('rootId', 'root-b');
    c2.set('structureType', 'logic');
    c2.set('themeId', 'gmind-dark');
    const tomb = new Y.Map<unknown>();
    tomb.set('deleted', true);
    canvasesMap(doc).set('c1', c1);
    canvasesMap(doc).set('c2', c2);
    canvasesMap(doc).set('c-tomb', tomb);
    canvasOrderArr(doc).push(['c1', 'c-tomb', 'c2']);
    doc.getMap('meta').set('activeCanvasId', 'c2');
  });
  return doc;
}

describe('canvas 结构访问器（空文档）', () => {
  it('空 doc：listCanvases 返回 []', () => {
    const doc = new Y.Doc();
    expect(listCanvases(doc)).toEqual([]);
  });

  it('空 doc：resolveCanvasId 回退 LEGACY_CANVAS_ID', () => {
    const doc = new Y.Doc();
    expect(resolveCanvasId(doc)).toBe(LEGACY_CANVAS_ID);
    expect(LEGACY_CANVAS_ID).toBe('canvas-1');
    expect(MAX_CANVAS_NAME_LENGTH).toBe(50);
  });
});

describe('canvas 结构访问器（双画布文档）', () => {
  it('listCanvases 按 canvasOrder 顺序返回且跳过墓碑', () => {
    const doc = buildTwoCanvasDoc();
    const list = listCanvases(doc);
    expect(list.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(list[0]).toEqual({
      id: 'c1',
      name: '画布一',
      rootId: 'root',
      structureType: 'mindmap',
      themeId: 'gmind-light',
    });
    expect(list[1].structureType).toBe('logic');
    expect(list[1].themeId).toBe('gmind-dark');
  });

  it('字段缺失时回退默认值（画布 / root / mindmap / gmind-light）', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const c = new Y.Map<unknown>();
      canvasesMap(doc).set('c1', c);
      canvasOrderArr(doc).push(['c1']);
    });
    expect(listCanvases(doc)).toEqual([
      { id: 'c1', name: '画布', rootId: 'root', structureType: 'mindmap', themeId: 'gmind-light' },
    ]);
  });

  it('canvasMapOf 命中显式 id；resolveCanvasId 显式 > meta.active > 首个存活', () => {
    const doc = buildTwoCanvasDoc();
    expect(resolveCanvasId(doc, 'c1')).toBe('c1');
    expect(resolveCanvasId(doc)).toBe('c2'); // meta.activeCanvasId
    doc.getMap('meta').delete('activeCanvasId');
    expect(resolveCanvasId(doc)).toBe('c1'); // 首个存活
    expect(canvasMapOf(doc, 'c2').get('name')).toBe('画布二');
  });

  it('canvasMapOf 对不存在/已删除 id 沿回退链解析，落空时抛 CANVAS_NOT_FOUND', () => {
    const doc = buildTwoCanvasDoc();
    // 显式 id 不存在 → 回退 meta.activeCanvasId（c2）
    expect(canvasMapOf(doc, 'nope').get('name')).toBe('画布二');
    // 显式 id 是墓碑 → 同样被跳过
    expect(canvasMapOf(doc, 'c-tomb').get('name')).toBe('画布二');
    // 全链路落空（无任何画布）→ 解析落 LEGACY_CANVAS_ID 且不存在 → 抛错
    expect(() => canvasMapOf(new Y.Doc())).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    // order 全墓碑 + 显式 id 缺失：同样抛 CANVAS_NOT_FOUND
    const dead = new Y.Doc();
    dead.transact(() => {
      const tomb = new Y.Map<unknown>();
      tomb.set('deleted', true);
      canvasesMap(dead).set('c1', tomb);
      canvasOrderArr(dead).push(['c1']);
    });
    expect(() => canvasMapOf(dead, 'nope')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });

  it('canvasNodesMap / canvasSummariesMap / rootIdOf 读侧正常', () => {
    const doc = buildTwoCanvasDoc();
    const nodes = canvasNodesMap(doc, 'c1');
    expect(nodes).toBeInstanceOf(Y.Map);
    expect(nodes.size).toBe(0);
    expect(rootIdOf(doc, 'c1')).toBe('root');
    expect(rootIdOf(doc, 'c2')).toBe('root-b');
  });
});

describe('ensureCanvasShape（防尽补建）', () => {
  it('对缺 nodes/summaries 键的 CanvasMap 补建并写回', () => {
    // 注意：独立 Y.Map 未挂 doc 时读会抛「Add Yjs type to a document」，必须挂文档。
    const doc = new Y.Doc();
    const holder = doc.getMap('holder');
    const canvas = new Y.Map<unknown>();
    holder.set('c', canvas);
    const { nodes, summaries } = ensureCanvasShape(canvas);
    expect(nodes).toBeInstanceOf(Y.Map);
    expect(summaries).toBeInstanceOf(Y.Map);
    // 写回验证：再次读取拿到同一实例
    expect(canvas.get('nodes')).toBe(nodes);
    expect(canvas.get('summaries')).toBe(summaries);
    // 幂等：已合规时不重建
    const again = ensureCanvasShape(canvas);
    expect(again.nodes).toBe(nodes);
    expect(again.summaries).toBe(summaries);
  });
});
