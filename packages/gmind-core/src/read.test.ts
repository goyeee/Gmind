import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc } from './doc';
import { GmindCoreError } from './errors';
import { childrenIds, countAlive, getMeta, getNode, isAlive, pathToRoot, requireAliveNode, setDocMeta, subtreeIds } from './read';

describe('getMeta / setDocMeta', () => {
  it('读取模板文档 meta 完整', () => {
    const doc = createTemplateDoc({ title: 'T', structure: 'org', theme: 't2', children: [{ text: 'A' }] });
    expect(getMeta(doc)).toEqual({ title: 'T', structureType: 'org', themeId: 't2' });
  });

  it('setDocMeta 只写入提供的键且可指定 origin', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    setDocMeta(doc, { title: 'T2' }, 'system');
    expect(getMeta(doc).title).toBe('T2');
    expect(getMeta(doc).structureType).toBe('mindmap');
    const meta = doc.getMap('meta');
    expect(meta.get('title')).toBe('T2');
  });
});

describe('getNode', () => {
  it('模板节点缺省字段读取为默认值，childIds 保持插入顺序', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    const root = getNode(doc, ROOT_NODE_ID)!;
    expect(root).toMatchObject({
      id: ROOT_NODE_ID,
      text: 'T',
      parentId: '',
      note: '',
      href: '',
      image: null,
      icons: {},
      style: {},
      collapsed: false,
      deleted: false,
    });
    expect(root.childIds).toHaveLength(2);
    const first = getNode(doc, root.childIds[0]!)!;
    expect(first.text).toBe('A');
    expect(first.parentId).toBe(ROOT_NODE_ID);
    expect(first.childIds).toEqual([]);
  });

  it('显式富内容字段完整读回', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const nodes = doc.getMap('nodes');
      const root = new Y.Map();
      nodes.set(ROOT_NODE_ID, root);
      root.set('text', 'R');
      root.set('parentId', '');
      const rootChildren = new Y.Array<string>();
      root.set('children', rootChildren);
      const n = new Y.Map();
      nodes.set('n1', n);
      n.set('text', 'hello');
      n.set('parentId', ROOT_NODE_ID);
      rootChildren.push(['n1']);
      n.set('note', '备注内容');
      n.set('href', 'https://x.dev');
      n.set('image', { key: 'files/f1/x.png', w: 120, h: 80 });
      const icons = new Y.Map();
      icons.set('flag', 'red');
      n.set('icons', icons);
      const style = new Y.Map();
      style.set('fill', '#ffffff');
      n.set('style', style);
      n.set('collapsed', true);
    });
    const snap = getNode(doc, 'n1')!;
    expect(snap.note).toBe('备注内容');
    expect(snap.href).toBe('https://x.dev');
    expect(snap.image).toEqual({ key: 'files/f1/x.png', w: 120, h: 80 });
    expect(snap.icons).toEqual({ flag: 'red' });
    expect(snap.style).toEqual({ fill: '#ffffff' });
    expect(snap.collapsed).toBe(true);
  });

  it('不存在的节点返回 null', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    expect(getNode(doc, 'nope')).toBeNull();
  });
});

describe('树遍历', () => {
  const build = (): Y.Doc =>
    createTemplateDoc({
      title: 'T',
      children: [{ text: 'A', children: [{ text: 'A1' }, { text: 'A2' }] }, { text: 'B' }],
    });

  it('subtreeIds 先序遍历', () => {
    const doc = build();
    const root = getNode(doc, ROOT_NODE_ID)!;
    const aId = root.childIds[0]!;
    const a1Id = getNode(doc, aId)!.childIds[0]!;
    expect(subtreeIds(doc, aId)).toEqual([aId, a1Id, getNode(doc, aId)!.childIds[1]!]);
    expect(subtreeIds(doc, ROOT_NODE_ID)).toHaveLength(5);
  });

  it('pathToRoot 从叶子到根', () => {
    const doc = build();
    const aId = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    const a1Id = getNode(doc, aId)!.childIds[0]!;
    expect(pathToRoot(doc, a1Id)).toEqual([a1Id, aId, ROOT_NODE_ID]);
  });

  it('childrenIds / isAlive / countAlive', () => {
    const doc = build();
    expect(childrenIds(doc, ROOT_NODE_ID)).toHaveLength(2);
    expect(childrenIds(doc, 'missing')).toEqual([]);
    expect(countAlive(doc)).toBe(4); // 不含 root
    expect(isAlive(doc, ROOT_NODE_ID)).toBe(true);
  });

  it('墓碑节点 isAlive=false，requireAliveNode 抛 NODE_DELETED', () => {
    const doc = build();
    const aId = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    const aNode = doc.getMap<Y.Map<unknown>>('nodes').get(aId)!;
    doc.transact(() => aNode.set('deleted', true));
    expect(isAlive(doc, aId)).toBe(false);
    expect(() => requireAliveNode(doc, aId)).toThrow(GmindCoreError);
    try {
      requireAliveNode(doc, aId);
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
  });

  it('requireAliveNode 对缺失节点抛 NODE_NOT_FOUND', () => {
    const doc = build();
    try {
      requireAliveNode(doc, 'nope');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
  });
});

describe('parentId 环防御（遍历必须终止）', () => {
  /** 制造 2 节点环：X.parentId=Y、Y.parentId=X 且互相出现在对方 children
   * （裸写绕过操作层校验，模拟并发换父交换合并/crafted doc_state 残留；
   *  同时从 root.children 摘除二者，使既有规则①-⑤对该文档零修复）。 */
  function cycleDoc(): { doc: Y.Doc; xId: string; yId: string } {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'X' }, { text: 'Y' }] });
    const nodes = doc.getMap('nodes');
    const xId = [...nodes.entries()].find(([, n]) => (n as Y.Map<unknown>).get('text') === 'X')![0];
    const yId = [...nodes.entries()].find(([, n]) => (n as Y.Map<unknown>).get('text') === 'Y')![0];
    doc.transact(() => {
      const rootChildren = (nodes.get(ROOT_NODE_ID) as Y.Map<unknown>).get(
        'children',
      ) as Y.Array<string>;
      rootChildren.delete(1, 1);
      rootChildren.delete(0, 1);
      const x = nodes.get(xId) as Y.Map<unknown>;
      const y = nodes.get(yId) as Y.Map<unknown>;
      x.set('parentId', yId);
      y.set('parentId', xId);
      (x.get('children') as Y.Array<string>).push([yId]);
      (y.get('children') as Y.Array<string>).push([xId]);
    });
    return { doc, xId, yId };
  }

  it('subtreeIds 在 2 节点环上终止，返回有限前缀（visited 防御）', () => {
    const { doc, xId, yId } = cycleDoc();
    expect(subtreeIds(doc, xId)).toEqual([xId, yId]); // X → Y → X(已访问，跳过)
  });

  it('pathToRoot 在 2 节点环上终止，返回有限前缀（visited 防御）', () => {
    const { doc, xId, yId } = cycleDoc();
    expect(pathToRoot(doc, xId)).toEqual([xId, yId]); // X → Y → X(已访问，断链)
  });
});
