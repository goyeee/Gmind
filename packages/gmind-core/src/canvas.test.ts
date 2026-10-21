import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  LEGACY_CANVAS_ID,
  MAX_CANVAS_NAME_LENGTH,
  canvasMapOf,
  canvasNodesMap,
  canvasOrderArr,
  canvasSummariesMap,
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

  it('canvasMapOf 显式 id 不存在/已删除即抛 CANVAS_NOT_FOUND，不回退到其他存活画布', () => {
    const doc = buildTwoCanvasDoc();
    // doc 里有其他存活画布（c1/c2），但显式 id 不存在仍硬失败
    expect(() => canvasMapOf(doc, 'nope')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    // 显式 id 是墓碑 → 同样抛
    expect(() => canvasMapOf(doc, 'c-tomb')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    // 缺省（undefined）时回退链正常解析，仍命中存活画布
    expect(canvasMapOf(doc).get('name')).toBe('画布二');
    expect(canvasMapOf(doc, 'c1').get('name')).toBe('画布一');
    // 全链路落空（无任何画布）→ 解析落 LEGACY_CANVAS_ID 且不存在 → 抛错
    expect(() => canvasMapOf(new Y.Doc())).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    // order 全墓碑 + 缺省：同样抛 CANVAS_NOT_FOUND
    const dead = new Y.Doc();
    dead.transact(() => {
      const tomb = new Y.Map<unknown>();
      tomb.set('deleted', true);
      canvasesMap(dead).set('c1', tomb);
      canvasOrderArr(dead).push(['c1']);
    });
    expect(() => canvasMapOf(dead)).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });

  it('canvasNodesMap / canvasSummariesMap / rootIdOf 读侧正常', () => {
    const doc = buildTwoCanvasDoc();
    const nodes = canvasNodesMap(doc, 'c1');
    expect(nodes).toBeInstanceOf(Y.Map);
    expect(nodes.size).toBe(0);
    const summaries = canvasSummariesMap(doc, 'c1');
    expect(summaries).toBeInstanceOf(Y.Map);
    expect(summaries.size).toBe(0);
    expect(rootIdOf(doc, 'c1')).toBe('root');
    expect(rootIdOf(doc, 'c2')).toBe('root-b');
  });

  it('rootIdOf 在 rootId 缺失/空串时回退 ROOT_NODE_ID', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const c = new Y.Map<unknown>();
      c.set('rootId', '');
      canvasesMap(doc).set('c1', c);
      canvasOrderArr(doc).push(['c1']);
    });
    expect(rootIdOf(doc, 'c1')).toBe('root');
    const doc2 = new Y.Doc();
    doc2.transact(() => {
      canvasesMap(doc2).set('c1', new Y.Map<unknown>());
      canvasOrderArr(doc2).push(['c1']);
    });
    expect(rootIdOf(doc2, 'c1')).toBe('root');
  });
});

describe('canvas 结构访问器（crafted 值防御）', () => {
  it('canvases 塞非 Y.Map 值（字符串等）：listCanvases/resolveCanvasId 不抛错，按不存在跳过', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const c1 = new Y.Map<unknown>();
      c1.set('name', '画布一');
      c1.set('rootId', 'root');
      canvasesMap(doc).set('c1', c1);
      // crafted 值：字符串 / 数字 / 普通对象（绕过操作 API 直写）
      canvasesMap(doc).set('evil-str', 'not-a-map' as unknown as Y.Map<unknown>);
      canvasesMap(doc).set('evil-num', 42 as unknown as Y.Map<unknown>);
      canvasesMap(doc).set('evil-obj', { deleted: false } as unknown as Y.Map<unknown>);
      canvasOrderArr(doc).push(['evil-str', 'c1', 'evil-num', 'evil-obj']);
      doc.getMap('meta').set('activeCanvasId', 'evil-str'); // meta 指向 crafted 值
    });
    // 读侧全部不抛错，crafted 值按墓碑语义确定性跳过
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c1']);
    // meta.activeCanvasId 指向 crafted 值 → 回退到首个存活 c1
    expect(resolveCanvasId(doc)).toBe('c1');
    // 显式指向 crafted 值 → CANVAS_NOT_FOUND（视为不存在），且不回退
    expect(() => canvasMapOf(doc, 'evil-str')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    expect(canvasMapOf(doc).get('name')).toBe('画布一');
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
