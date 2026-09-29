import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, countNodes, createTemplateDoc, docFromState, docToState } from './doc';
import { GmindCoreError } from './errors';
import { childrenIds, countAlive, countAliveReachable, countCollapsedWithChildren, getLastEditor, getMeta, getNode, isAlive, markLastEditor, pathToRoot, requireAliveNode, setDocMeta, subtreeIds } from './read';
import { deleteNodes, setCollapsed } from './operations';
import { ORIGIN_USER, createUndoManager, undo } from './undo';

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
      task: { status: 'todo', progress: 0, owners: [], startDate: null, dueDate: null, doneDate: null },
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
      icons.set('flag', Y.Array.from(['flag']));
      icons.set('emoji', Y.Array.from(['😄']));
      icons.set('legacy', 'junk'); // 旧组键（repair 未收敛窗口期）：不入快照
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
    expect(snap.icons).toEqual({ flag: ['flag'], emoji: ['😄'] });
    expect(snap.style).toEqual({ fill: '#ffffff' });
    expect(snap.collapsed).toBe(true);
  });

  it('task 字段读取：显式 Y.Map 完整读回；远端坏数据归一化（不抛错）', () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const nodes = doc.getMap('nodes');
      const root = new Y.Map();
      nodes.set(ROOT_NODE_ID, root);
      root.set('text', 'R');
      root.set('parentId', '');
      const rootChildren = new Y.Array<string>();
      root.set('children', rootChildren);
      const good = new Y.Map();
      nodes.set('good', good);
      good.set('text', 'g');
      good.set('parentId', ROOT_NODE_ID);
      const task = new Y.Map();
      task.set('status', 'doing');
      task.set('progress', 40);
      task.set('owners', ['u1', 'u2']);
      task.set('startDate', '2026-09-01');
      task.set('dueDate', '2026-10-01');
      task.set('doneDate', null);
      good.set('task', task);
      rootChildren.push(['good', 'bad']);
      const bad = new Y.Map();
      nodes.set('bad', bad);
      bad.set('text', 'b');
      bad.set('parentId', ROOT_NODE_ID);
      const badTask = new Y.Map();
      badTask.set('status', 'weird');
      badTask.set('progress', 250.4);
      badTask.set('owners', ['u1', 42, null]);
      badTask.set('startDate', '2026/09/01');
      badTask.set('doneDate', '2026-13-40');
      bad.set('task', badTask);
    });
    expect(getNode(doc, 'good')!.task).toEqual({
      status: 'doing',
      progress: 40,
      owners: ['u1', 'u2'],
      startDate: '2026-09-01',
      dueDate: '2026-10-01',
      doneDate: null,
    });
    // 坏数据按缺省/钳制归一化：status 非四枚举→todo、progress 钳 100、owners 只收字符串、日期形状不符→null
    expect(getNode(doc, 'bad')!.task).toEqual({
      status: 'todo',
      progress: 100,
      owners: ['u1'],
      startDate: null,
      dueDate: null,
      doneDate: null,
    });
    // task 为非 Y.Map 垃圾（字符串）：缺省任务，不抛错
    const doc2 = new Y.Doc();
    doc2.transact(() => {
      const nodes = doc2.getMap('nodes');
      const root = new Y.Map();
      nodes.set(ROOT_NODE_ID, root);
      root.set('text', 'R');
      root.set('parentId', '');
      root.set('children', new Y.Array<string>());
      root.set('task', 'garbage');
    });
    expect(getNode(doc2, ROOT_NODE_ID)!.task.status).toBe('todo');
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

describe('countAliveReachable（FR-ACC-003 配额口径：自 root 可达的活跃规模）', () => {
  const build = (): Y.Doc =>
    createTemplateDoc({
      title: 'T',
      children: [{ text: 'A', children: [{ text: 'A1' }, { text: 'A2' }] }, { text: 'B' }],
    });

  it('可达性：统计全部后代（不含 root）', () => {
    expect(countAliveReachable(build())).toBe(4); // A + A1 + A2 + B
  });

  it('墓碑与孤儿不计入（countAlive/countNodes 会计入，配额口径剔除）', () => {
    const doc = build();
    const nodes = doc.getMap<Y.Map<unknown>>('nodes');
    const root = getNode(doc, ROOT_NODE_ID)!;
    const bId = root.childIds[1]!;
    doc.transact(() => {
      (nodes.get(bId) as Y.Map<unknown>).set('deleted', true); // 墓碑（撤销语义：条目保留）
      const orphan = new Y.Map<unknown>();
      orphan.set('text', 'orphan');
      orphan.set('parentId', 'ghost'); // 指向缺失节点：normalize 确定性跳过、不挂回
      orphan.set('children', new Y.Array<string>());
      nodes.set('orphan-x', orphan);
    });
    const restored = docFromState(docToState(doc)); // 入口全量 normalize 后孤儿仍是孤儿
    expect(countNodes(restored)).toBe(6); // root + A + A1 + A2 + B墓碑 + 孤儿
    expect(countAlive(restored)).toBe(4); // A/A1/A2/孤儿（含不可达孤儿、不含墓碑）
    expect(countAliveReachable(restored)).toBe(3); // 仅 A/A1/A2 自 root 可达
  });

  it('children 侧 2 节点环上终止（visited 防御，复用 M1a 环防御结论）', () => {
    const doc = build();
    const nodes = doc.getMap<Y.Map<unknown>>('nodes');
    const root = getNode(doc, ROOT_NODE_ID)!;
    const aId = root.childIds[0]!;
    const bId = root.childIds[1]!;
    doc.transact(() => {
      const rootChildren = (nodes.get(ROOT_NODE_ID) as Y.Map<unknown>).get(
        'children',
      ) as Y.Array<string>;
      rootChildren.delete(1, 1); // root.children = [A]
      const aChildren = (nodes.get(aId) as Y.Map<unknown>).get('children') as Y.Array<string>;
      aChildren.delete(1, 1); // A.children = [A1]
      aChildren.push([bId]); // A.children = [A1, B]
      const bChildren = new Y.Array<string>();
      bChildren.push([aId]);
      bChildren.push([bId]); // B.children = [A, B]：环 + 自环
      (nodes.get(bId) as Y.Map<unknown>).set('children', bChildren);
    });
    // A + A1 + B：回指 A/B 均已访问，visited 集合保证终止
    expect(countAliveReachable(doc)).toBe(3);
  });

  it('root 缺失或墓碑时返回 0', () => {
    const doc = build();
    doc.getMap<Y.Map<unknown>>('nodes').delete(ROOT_NODE_ID);
    expect(countAliveReachable(doc)).toBe(0);
    const doc2 = build();
    (doc2.getMap<Y.Map<unknown>>('nodes').get(ROOT_NODE_ID) as Y.Map<unknown>).set('deleted', true);
    expect(countAliveReachable(doc2)).toBe(0);
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

describe('markLastEditor / getLastEditor（last_modifier 链路，M3a Task 4）', () => {
  it('markLastEditor 写入 meta.lastEditorUserId，getLastEditor 读回；未写过为 null', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    expect(getLastEditor(doc)).toBeNull();
    markLastEditor(doc, 'USER_A');
    expect(getLastEditor(doc)).toBe('USER_A');
    markLastEditor(doc, 'USER_B');
    expect(getLastEditor(doc)).toBe('USER_B'); // 最新写者覆盖
  });

  it('默认 system origin：不进撤销栈（撤销用户写不会回滚最后修改人标记）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const um = createUndoManager(doc);
    setDocMeta(doc, { title: 'T2' }, ORIGIN_USER); // 用户写，可撤销
    markLastEditor(doc, 'USER_A');
    undo(um);
    expect(getMeta(doc).title).toBe('T'); // 用户写被撤销
    expect(getLastEditor(doc)).toBe('USER_A'); // system 写不受影响
  });

  it('空串/非字符串值视同未标记（getLastEditor 返回 null）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    doc.getMap('meta').set('lastEditorUserId', '');
    expect(getLastEditor(doc)).toBeNull();
    doc.getMap('meta').set('lastEditorUserId', 42);
    expect(getLastEditor(doc)).toBeNull();
  });
});

describe('countCollapsedWithChildren（M4 Task 9，FR-IO-003 导出折叠提示口径）', () => {
  it('countCollapsedWithChildren：仅统计存活且折叠且有子级的节点（3 折叠 1 无子 → 2）', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [
        { text: 'A', children: [{ text: 'A1' }, { text: 'A2' }] },
        { text: 'B', children: [{ text: 'B1' }] },
        { text: 'C' },
      ],
    });
    const root = getNode(doc, ROOT_NODE_ID)!;
    const [a, b, c] = root.childIds;
    setCollapsed(doc, a!, true); // 有子级 → 计
    setCollapsed(doc, b!, true); // 有子级 → 计
    setCollapsed(doc, c!, true); // 无子级：空折叠不产生视觉折叠态 → 不计
    expect(countCollapsedWithChildren(doc)).toBe(2);
  });

  it('countCollapsedWithChildren：可达口径同 countAliveReachable——墓碑不计', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A', children: [{ text: 'A1' }] }] });
    const a = getNode(doc, ROOT_NODE_ID)!.childIds[0]!;
    setCollapsed(doc, a, true);
    expect(countCollapsedWithChildren(doc)).toBe(1);
    deleteNodes(doc, [a]); // 墓碑子树整枝剪除
    expect(countCollapsedWithChildren(doc)).toBe(0);
  });
});
