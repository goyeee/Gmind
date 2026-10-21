import { beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_CANVAS_NAME_LENGTH,
  ORIGIN_USER,
  addChild,
  createUndoManager,
  listCanvases,
  rootIdOf,
  undo,
} from './index';
import {
  canvasMapOf,
  canvasNodesMap,
  canvasOrderArr,
  canvasesMap,
} from './canvas';
import {
  addCanvas,
  deleteCanvas,
  renameCanvas,
  reorderCanvases,
  setActiveCanvas,
} from './canvas-ops';

/** 手工搭一个三画布 doc（两存活 + 一根墓碑），每存活画布带合法 root 节点。 */
function buildDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const mk = (name: string, rootId: string): Y.Map<unknown> => {
      const c = new Y.Map<unknown>();
      c.set('name', name);
      c.set('rootId', rootId);
      c.set('structureType', 'mindmap');
      c.set('themeId', 'gmind-light');
      const nodes = new Y.Map<unknown>();
      const root = new Y.Map<unknown>();
      root.set('text', `${name}根`);
      root.set('parentId', '');
      root.set('children', new Y.Array<string>());
      nodes.set(rootId, root);
      c.set('nodes', nodes);
      c.set('summaries', new Y.Map());
      return c;
    };
    canvasesMap(doc).set('c1', mk('画布一', 'root'));
    canvasesMap(doc).set('c2', mk('画布二', 'root-b'));
    const tomb = new Y.Map<unknown>();
    tomb.set('deleted', true);
    canvasesMap(doc).set('c-tomb', tomb);
    canvasOrderArr(doc).push(['c1', 'c-tomb', 'c2']);
    doc.getMap('meta').set('activeCanvasId', 'c2');
  });
  return doc;
}

/** 统计一次回调期间 doc 发出的 update 次数（幂等断言用）。 */
function countUpdates(doc: Y.Doc, fn: () => void): number {
  let n = 0;
  const h = (): void => {
    n += 1;
  };
  doc.on('update', h);
  try {
    fn();
  } finally {
    doc.off('update', h);
  }
  return n;
}

describe('addCanvas', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = buildDoc();
  });

  it('新增画布：listCanvases 末尾 +1，active 指向新画布，root 文本「中心主题」', () => {
    const id = addCanvas(doc);
    const list = listCanvases(doc);
    expect(list.map((c) => c.id)).toEqual(['c1', 'c2', id]);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(id);
    const created = canvasesMap(doc).get(id) as Y.Map<unknown>;
    expect(created.get('deleted')).not.toBe(true);
    const rootId = created.get('rootId') as string;
    expect(rootId).not.toBe('');
    const root = canvasNodesMap(doc, id).get(rootId) as Y.Map<unknown>;
    expect(root.get('text')).toBe('中心主题');
    expect(root.get('parentId')).toBe('');
    // 追加 order 末尾（墓碑条目随 normalize 清扫移出 order——repair Task 5 口径）
    expect(canvasOrderArr(doc).toArray()).toEqual(['c1', 'c2', id]);
  });

  it('缺省名 = 画布 ${存活数+1}（墓碑不计）', () => {
    const id = addCanvas(doc);
    expect(canvasMapOf(doc, id).get('name')).toBe('画布 3');
    deleteCanvas(doc, 'c1');
    const id2 = addCanvas(doc);
    expect(canvasMapOf(doc, id2).get('name')).toBe('画布 3');
  });

  it('显式 name/structureType/themeId 落盘，structure/theme 缺省回退', () => {
    const id = addCanvas(doc, { name: '  脑暴  ', structureType: 'logic', themeId: 'gmind-dark' });
    expect(canvasMapOf(doc, id).get('name')).toBe('脑暴');
    expect(canvasMapOf(doc, id).get('structureType')).toBe('logic');
    expect(canvasMapOf(doc, id).get('themeId')).toBe('gmind-dark');
    const id2 = addCanvas(doc, { name: '缺省' });
    expect(canvasMapOf(doc, id2).get('structureType')).toBe('mindmap');
    expect(canvasMapOf(doc, id2).get('themeId')).toBe('gmind-light');
  });

  it('空名/纯空白名抛 CANVAS_NAME_EMPTY，超长抛 CANVAS_NAME_TOO_LONG，均零变更', () => {
    const before = listCanvases(doc).map((c) => c.id);
    expect(() => addCanvas(doc, { name: '' })).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NAME_EMPTY' }),
    );
    expect(() => addCanvas(doc, { name: '   ' })).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NAME_EMPTY' }),
    );
    expect(() => addCanvas(doc, { name: 'x'.repeat(MAX_CANVAS_NAME_LENGTH + 1) })).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NAME_TOO_LONG' }),
    );
    expect(listCanvases(doc).map((c) => c.id)).toEqual(before);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe('c2');
  });
});

describe('renameCanvas', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = buildDoc();
  });

  it('改名落盘（trim 存储）；同值幂等零事务', () => {
    renameCanvas(doc, 'c1', ' 新名字 ');
    expect(canvasMapOf(doc, 'c1').get('name')).toBe('新名字');
    expect(countUpdates(doc, () => renameCanvas(doc, 'c1', '新名字'))).toBe(0);
    expect(countUpdates(doc, () => renameCanvas(doc, 'c1', '  新名字  '))).toBe(0);
  });

  it('空名/超长抛错且零变更；不存在或已墓碑的画布抛 CANVAS_NOT_FOUND', () => {
    expect(() => renameCanvas(doc, 'c1', ' \t ')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NAME_EMPTY' }),
    );
    expect(() => renameCanvas(doc, 'c1', 'x'.repeat(MAX_CANVAS_NAME_LENGTH + 1))).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NAME_TOO_LONG' }),
    );
    expect(canvasMapOf(doc, 'c1').get('name')).toBe('画布一');
    expect(() => renameCanvas(doc, 'c-ghost', 'x')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
    expect(() => renameCanvas(doc, 'c-tomb', 'x')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });
});

describe('deleteCanvas', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = buildDoc();
  });

  it('墓碑化 + 移出 order；nodes/summaries 冻结不动；active 指向被删时改指 order 首个存活', () => {
    const c2Before = canvasesMap(doc).get('c2') as Y.Map<unknown>;
    const nodesBefore = (c2Before.get('nodes') as Y.Map<unknown>).toJSON();
    const summariesBefore = (c2Before.get('summaries') as Y.Map<unknown>).toJSON();
    deleteCanvas(doc, 'c2'); // active 当前指向 c2
    const tomb = canvasesMap(doc).get('c2') as Y.Map<unknown>;
    expect(tomb.get('deleted')).toBe(true);
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c1']);
    expect(canvasOrderArr(doc).toArray()).toEqual(['c1']);
    // 冻结不变量：墓碑子图内容原样（canvasMapOf 对墓碑抛错，须直读原始子图）
    expect((tomb.get('nodes') as Y.Map<unknown>).toJSON()).toEqual(nodesBefore);
    expect((tomb.get('summaries') as Y.Map<unknown>).toJSON()).toEqual(summariesBefore);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe('c1');
  });

  it('active 指向其他画布时不动', () => {
    setActiveCanvas(doc, 'c2');
    deleteCanvas(doc, 'c1');
    expect(doc.getMap('meta').get('activeCanvasId')).toBe('c2');
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c2']);
  });

  it('最后一张存活画布抛 CANVAS_LAST_FORBIDDEN；不存在的画布抛 CANVAS_NOT_FOUND', () => {
    deleteCanvas(doc, 'c2');
    expect(() => deleteCanvas(doc, 'c1')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_LAST_FORBIDDEN' }),
    );
    // 零变更：c1 仍存活
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c1']);
    expect(() => deleteCanvas(doc, 'c-ghost')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });
});

describe('reorderCanvases', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    doc = buildDoc();
  });

  it('order 内移动（墓碑不占位），同位幂等零事务', () => {
    const id3 = addCanvas(doc, { name: 'c3' });
    reorderCanvases(doc, 'c2', 0);
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c2', 'c1', id3]);
    expect(countUpdates(doc, () => reorderCanvases(doc, 'c2', 0))).toBe(0);
  });

  it('index 钳制 [0, len-1]', () => {
    reorderCanvases(doc, 'c2', -99);
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c2', 'c1']);
    reorderCanvases(doc, 'c2', 99);
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c1', 'c2']);
  });

  it('不存在的画布抛 CANVAS_NOT_FOUND', () => {
    expect(() => reorderCanvases(doc, 'c-ghost', 0)).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });
});

describe('setActiveCanvas', () => {
  it('LWW 切 active；ORIGIN_SYSTEM 不进画布撤销栈；不存在抛 CANVAS_NOT_FOUND', () => {
    const doc = buildDoc();
    const um = createUndoManager(doc, 'c1');
    const updates = countUpdates(doc, () => setActiveCanvas(doc, 'c1'));
    expect(updates).toBeGreaterThan(0);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe('c1');
    expect(um.undoStack.length).toBe(0); // system origin，且 meta 不在画布子图 scope
    expect(() => setActiveCanvas(doc, 'c-ghost')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });
});

describe('撤销隔离（假设 6：画布管理写 doc 级根类型，天然不进画布撤销栈）', () => {
  it('undo c1 节点编辑不触碰画布管理状态（canvases/canvasOrder/meta）', () => {
    const doc = buildDoc();
    const um = createUndoManager(doc, 'c1');
    // 画布管理操作在前（user origin；rename 写在 c1 子图内会进 c1 栈，单独隔离）
    const newId = addCanvas(doc, { name: '新画布' }); // 默认 user origin
    deleteCanvas(doc, 'c2');
    reorderCanvases(doc, 'c1', 0);
    um.stopCapturing(); // 隔离 captureTimeout：画布管理写不与后续节点编辑合并
    const listBefore = listCanvases(doc).map((c) => c.id);
    const activeBefore = doc.getMap('meta').get('activeCanvasId');
    const root = rootIdOf(doc, 'c1');
    const childId = addChild(doc, root, { text: '子' }, ORIGIN_USER, 'c1');
    expect(um.undoStack.length).toBe(1);
    expect(undo(um)).toBe(true);
    expect(canvasNodesMap(doc, 'c1').get(childId)).toBeUndefined();
    // 画布管理状态不受 undo 影响（doc 级根类型不在画布子图 scope 内）
    expect(listCanvases(doc).map((c) => c.id)).toEqual(listBefore);
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(activeBefore);
    expect(listBefore).toContain(newId);
  });
});

describe('crafted 状态防御（canvases 值非 Y.Map，沿用 repair 层口径）', () => {
  it('order 中畸形条目按墓碑跳过：默认名计数、重排、删除均不崩溃', () => {
    const doc = buildDoc();
    doc.transact(() => {
      canvasesMap(doc).set('bad', 'garbage' as unknown as Y.Map<unknown>);
      canvasOrderArr(doc).insert(1, ['bad']);
    });
    const id = addCanvas(doc); // addCanvas 同事务把 active 切到新画布
    expect(canvasMapOf(doc, id).get('name')).toBe('画布 3');
    reorderCanvases(doc, 'c2', 0);
    expect(listCanvases(doc).map((c) => c.id)).toEqual(['c2', 'c1', id]);
    deleteCanvas(doc, 'c1'); // active 指向新画布，不受影响
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(id);
    expect(() => deleteCanvas(doc, 'bad')).toThrowError(
      expect.objectContaining({ code: 'CANVAS_NOT_FOUND' }),
    );
  });
});

describe('空文档边界', () => {
  it('空 doc 上 addCanvas 直接建第一张画布（name 画布 1）', () => {
    const doc = new Y.Doc();
    const id = addCanvas(doc);
    expect(listCanvases(doc).map((c) => c.id)).toEqual([id]);
    expect(canvasMapOf(doc, id).get('name')).toBe('画布 1');
    expect(doc.getMap('meta').get('activeCanvasId')).toBe(id);
    // 只剩一张时禁止再删
    expect(() => deleteCanvas(doc, id)).toThrowError(
      expect.objectContaining({ code: 'CANVAS_LAST_FORBIDDEN' }),
    );
  });
});
