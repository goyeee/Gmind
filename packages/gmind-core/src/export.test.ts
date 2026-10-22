import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc, docToState } from './doc';
import { canvasOrderArr, canvasesMap, canvasNodesMap } from './canvas';
import { cloneExpanded } from './export';
import { getMeta, getNode } from './read';
import { setCollapsed } from './operations';

describe('cloneExpanded（M4 Task 9，FR-IO-003：仅导出快照不改画布）', () => {
  it('克隆内自 root 可达的折叠节点全部展开，结构/文本/meta 保真；原 doc 折叠态不变', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [
        { text: 'A', children: [{ text: 'A1', children: [{ text: 'A1a' }] }] },
        { text: 'B' },
      ],
    });
    const [a, b] = getNode(doc, ROOT_NODE_ID)!.childIds;
    const a1 = getNode(doc, a)!.childIds[0]!;
    setCollapsed(doc, a, true);
    setCollapsed(doc, a1, true);
    const before = docToState(doc);

    const clone = cloneExpanded(doc);

    // 原 doc 不被触碰：字节级一致，折叠标记保持
    expect(docToState(doc)).toEqual(before);
    expect(getNode(doc, a)?.collapsed).toBe(true);
    expect(getNode(doc, a1)?.collapsed).toBe(true);
    // 克隆是独立实例且全展开
    expect(clone).not.toBe(doc);
    expect(getNode(clone, a)?.collapsed).toBe(false);
    expect(getNode(clone, a1)?.collapsed).toBe(false);
    // 结构/文本保真
    expect(getNode(clone, ROOT_NODE_ID)?.childIds).toEqual([a, b]);
    expect(getNode(clone, a1)?.text).toBe('A1');
    expect(getNode(clone, getNode(clone, a1)!.childIds[0]!)?.text).toBe('A1a');
    expect(getNode(clone, a1)!.childIds).toHaveLength(1);
    expect(getMeta(clone).title).toBe('T');
  });

  it('展开只作用于存活可达集：墓碑不展开（normalize ③ 会剪除其 children 项，节点数据保留）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A', children: [{ text: 'A1' }] }] });
    const a = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    setCollapsed(doc, a, true);
    const nodes = canvasNodesMap(doc);
    nodes.get(a)!.set('deleted', true); // 直接造墓碑（跳过 deleteNodes 的子树级联）
    const before = docToState(doc);

    const clone = cloneExpanded(doc);
    expect(docToState(doc)).toEqual(before); // 原 doc 不被触碰
    // docFromState 入口 normalize（规则 ③）把指向墓碑的 children 项剪除，但墓碑节点
    // 数据永不清除——其 collapsed 标记保持原样（存活可达集不含它，setCollapsed 不触达）
    expect(getNode(clone, ROOT_NODE_ID)!.childIds).not.toContain(a);
    expect(getNode(clone, a)?.deleted).toBe(true);
    expect(getNode(clone, a)?.collapsed).toBe(true);
  });

  it('cloneExpanded(doc, canvasId) 只展开指定画布：c2 折叠全展开，c1 折叠态在克隆中保留', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A', children: [{ text: 'A1' }] }] });
    const a = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    // 手工加第二个画布 c2（根 'root2'，子级 b 折叠）
    doc.transact(() => {
      const canvas = new Y.Map<unknown>();
      canvas.set('name', '画布-2');
      canvas.set('rootId', 'root2');
      canvas.set('structureType', 'mindmap');
      canvas.set('themeId', 'gmind-light');
      const nodes = new Y.Map<Y.Map<unknown>>();
      const root = new Y.Map<unknown>();
      root.set('text', 'R2');
      root.set('parentId', '');
      const rootChildren = new Y.Array<string>();
      root.set('children', rootChildren);
      nodes.set('root2', root);
      const b = new Y.Map<unknown>();
      b.set('text', 'b');
      b.set('parentId', 'root2');
      b.set('children', new Y.Array<string>());
      b.set('collapsed', true);
      nodes.set('c2-b', b);
      rootChildren.push(['c2-b']);
      canvas.set('nodes', nodes);
      canvas.set('summaries', new Y.Map<unknown>());
      canvasesMap(doc).set('c2', canvas);
      canvasOrderArr(doc).push(['c2']);
    });
    setCollapsed(doc, a, true);
    const c1 = canvasOrderArr(doc).get(0)!; // 第一画布 id 是 ULID（createTemplateDoc 新建路径）
    const before = docToState(doc);

    const clone = cloneExpanded(doc, 'c2');

    expect(docToState(doc)).toEqual(before); // 原 doc 不被触碰
    expect(getNode(clone, 'c2-b', 'c2')?.collapsed).toBe(false); // c2 已展开
    expect(getNode(clone, a, c1)?.collapsed).toBe(true); // c1 折叠态保留
    expect(getNode(clone, 'root2', 'c2')!.childIds).toEqual(['c2-b']);
  });
});
