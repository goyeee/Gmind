import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Transaction } from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc } from './doc';
import { GmindCoreError } from './errors';
import { childrenIds, countAlive, getNode } from './read';
import {
  addChild,
  deleteNodes,
  moveNode,
  setText,
  withTransaction,
  ORIGIN_SYSTEM,
  ORIGIN_USER,
} from './operations';

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知）。 */
function findIdByText(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/** 删除/移动用例的固定树：root → [A[A1[A1a], A2], B[B1]]。 */
function buildTestTree(): Y.Doc {
  return createTemplateDoc({
    title: 'T',
    children: [
      { text: 'A', children: [{ text: 'A1', children: [{ text: 'A1a' }] }, { text: 'A2' }] },
      { text: 'B', children: [{ text: 'B1' }] },
    ],
  });
}

/** 全文档节点快照（用于断言「树无变化」）。 */
function fullSnapshot(doc: Y.Doc): string {
  const out: Record<string, unknown> = {};
  for (const id of doc.getMap('nodes').keys()) out[id] = getNode(doc, id);
  return JSON.stringify(out);
}

describe('addChild', () => {
  it('返回 26 位 ULID 且 getNode 读回默认字段齐全', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const id = addChild(doc, ROOT_NODE_ID, { text: 'A' });
    expect(id).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/);
    const snap = getNode(doc, id)!;
    expect(snap).not.toBeNull();
    expect(snap.parentId).toBe(ROOT_NODE_ID);
    expect(snap.text).toBe('A');
    expect(snap.childIds).toEqual([]);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([id]);
  });

  it('不带 opts.text 默认空串，重复 addChild 产出唯一 id', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    const a = addChild(doc, ROOT_NODE_ID);
    const b = addChild(doc, ROOT_NODE_ID);
    expect(a).not.toBe(b);
    expect(getNode(doc, a)!.text).toBe('');
    expect(getNode(doc, b)!.text).toBe('');
  });

  it('指定 index 插入到对应位置（childrenIds 顺序）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    const before = childrenIds(doc, ROOT_NODE_ID);
    const c = addChild(doc, ROOT_NODE_ID, { index: 1, text: 'C' });
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([before[0], c, before[1]]);
  });

  it('index 越界 clamp 到末尾（负数与超过长度）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    const neg = addChild(doc, ROOT_NODE_ID, { index: -3 });
    expect(childrenIds(doc, ROOT_NODE_ID)[2]).toBe(neg);
    const over = addChild(doc, ROOT_NODE_ID, { index: 99 });
    expect(childrenIds(doc, ROOT_NODE_ID)[3]).toBe(over);
  });

  it('opts.text 超 500 字抛 TEXT_TOO_LONG（T3 评审遗留）且文档零变更', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    try {
      addChild(doc, ROOT_NODE_ID, { text: '长'.repeat(501) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('TEXT_TOO_LONG');
      expect((e as GmindCoreError).message).toBe('节点文本长度已达上限');
    }
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([]);
    expect(doc.getMap('nodes').size).toBe(1);
  });

  it('对 root addChild 合法；对不存在 parent 抛 NODE_NOT_FOUND；对墓碑 parent 抛 NODE_DELETED', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    expect(addChild(doc, ROOT_NODE_ID, { text: 'R1' })).toMatch(/^[0-9A-HJ-NP-TV-Z]{26}$/);

    expect(() => addChild(doc, 'nope')).toThrow(GmindCoreError);
    try {
      addChild(doc, 'nope');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }

    const aId = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const aNode = doc.getMap('nodes').get(aId) as { set: (k: string, v: unknown) => void };
    doc.transact(() => aNode.set('deleted', true));
    try {
      addChild(doc, aId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
  });
});

describe('setText', () => {
  it('正常写入文本', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '旧文本' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    setText(doc, id, '新文本');
    expect(getNode(doc, id)!.text).toBe('新文本');
  });

  it('501 字抛 TEXT_TOO_LONG（消息固定）且文档未被修改', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: '原文本' }] });
    const id = childrenIds(doc, ROOT_NODE_ID)[0]!;
    const before = getNode(doc, id)!.text;
    try {
      setText(doc, id, '长'.repeat(501));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('TEXT_TOO_LONG');
      expect((e as GmindCoreError).message).toBe('节点文本长度已达上限');
    }
    expect(getNode(doc, id)!.text).toBe(before);
  });
});

describe('withTransaction', () => {
  it('fn 返回值透传，且 origin 写入事务（afterTransaction 可捕获）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [] });
    let captured: unknown;
    doc.on('afterTransaction', (tr: Transaction) => {
      captured = tr.origin;
    });
    const ret = withTransaction(doc, ORIGIN_SYSTEM, () => 'ok');
    expect(ret).toBe('ok');
    expect(captured).toBe('system');
  });

  it('origin 常量：ORIGIN_USER=user、ORIGIN_SYSTEM=system', () => {
    expect(ORIGIN_USER).toBe('user');
    expect(ORIGIN_SYSTEM).toBe('system');
  });
});

describe('deleteNodes', () => {
  it('删叶子：deleted=true、从父 children 消失、其余树不动', () => {
    const doc = buildTestTree();
    const b1Id = findIdByText(doc, 'B1');
    const bId = findIdByText(doc, 'B');
    const rootChildIdsBefore = getNode(doc, ROOT_NODE_ID)!.childIds;
    const aliveBefore = countAlive(doc);
    const before = JSON.parse(fullSnapshot(doc));

    deleteNodes(doc, [b1Id]);

    expect(getNode(doc, b1Id)!.deleted).toBe(true);
    expect(childrenIds(doc, bId)).toEqual([]);
    // 其余树不动：除 b1 本体与父 B 的 children 外，全部节点快照与删除前一致
    const after = JSON.parse(fullSnapshot(doc));
    for (const id of Object.keys(before)) {
      if (id === b1Id) continue;
      if (id === bId) {
        expect(after[id].childIds).toEqual([]);
        after[id].childIds = before[id].childIds; // children 变化已被上面单独断言
      }
      expect(after[id], id).toEqual(before[id]);
    }
    expect(getNode(doc, ROOT_NODE_ID)!.childIds).toEqual(rootChildIdsBefore);
    expect(countAlive(doc)).toBe(aliveBefore - 1);
  });

  it('删中间节点：整个子树全部墓碑；后代自身 children 数组保留（raw 检查）', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a1aId = findIdByText(doc, 'A1a');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');

    deleteNodes(doc, [aId]);

    for (const id of [aId, a1Id, a1aId, a2Id]) {
      expect(getNode(doc, id)!.deleted).toBe(true);
    }
    // 后代节点的 children 数组保留不动（快照可还原）
    const a1Raw = doc.getMap('nodes').get(a1Id) as Y.Map<unknown>;
    const a1Children = a1Raw.get('children') as Y.Array<string>;
    expect(a1Children).toBeInstanceOf(Y.Array);
    expect(a1Children.toArray()).toEqual([a1aId]);
    const aRaw = doc.getMap('nodes').get(aId) as Y.Map<unknown>;
    expect((aRaw.get('children') as Y.Array<string>).toArray()).toEqual([a1Id, a2Id]);
    // 从父 children 移除，其余树不动
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([bId]);
    expect(getNode(doc, bId)!.deleted).toBe(false);
  });

  it("deleteNodes(['root'])：root 存活，原全部子孙墓碑（FR-EDT-002 降级）", () => {
    const doc = buildTestTree();
    const allNonRoot = [...doc.getMap('nodes').keys()].filter((id) => id !== ROOT_NODE_ID);

    deleteNodes(doc, ['root']);

    expect(getNode(doc, ROOT_NODE_ID)!.deleted).toBe(false);
    expect(getNode(doc, ROOT_NODE_ID)!.childIds).toEqual([]);
    for (const id of allNonRoot) {
      expect(getNode(doc, id)!.deleted, id).toBe(true);
    }
    expect(countAlive(doc)).toBe(0);
  });

  it('混入不存在的 id 静默忽略，其余正常处理', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const bId = findIdByText(doc, 'B');

    deleteNodes(doc, ['no-such-id', bId]);

    expect(getNode(doc, 'no-such-id')).toBeNull();
    expect(getNode(doc, bId)!.deleted).toBe(true);
    expect(getNode(doc, aId)!.deleted).toBe(false);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId]);
  });
});

describe('moveNode', () => {
  it('移动到新父：parentId 更新、旧父移除、插入新父指定位置', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');
    const b1Id = findIdByText(doc, 'B1');

    moveNode(doc, a2Id, bId, 0);

    expect(getNode(doc, a2Id)!.parentId).toBe(bId);
    expect(getNode(doc, a2Id)!.deleted).toBe(false);
    expect(childrenIds(doc, aId)).toEqual([a1Id]);
    expect(childrenIds(doc, bId)).toEqual([a2Id, b1Id]);
  });

  it('index 缺省追加末尾，同父内移动仅重排', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
    });
    const aId = findIdByText(doc, 'A');
    const cId = findIdByText(doc, 'C');

    moveNode(doc, cId, ROOT_NODE_ID);

    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([aId, findIdByText(doc, 'B'), cId]);
    expect(getNode(doc, cId)!.parentId).toBe(ROOT_NODE_ID);

    moveNode(doc, cId, ROOT_NODE_ID, 0);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([cId, aId, findIdByText(doc, 'B')]);
  });

  it('移动到自己后代抛 CYCLE_FORBIDDEN 且树无变化', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a1aId = findIdByText(doc, 'A1a');
    const before = fullSnapshot(doc);

    try {
      moveNode(doc, aId, a1aId);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GmindCoreError);
      expect((e as GmindCoreError).code).toBe('CYCLE_FORBIDDEN');
    }
    expect(fullSnapshot(doc)).toBe(before);
  });

  it("moveNode('root', …) 抛 ROOT_FORBIDDEN", () => {
    const doc = buildTestTree();
    const bId = findIdByText(doc, 'B');
    try {
      moveNode(doc, ROOT_NODE_ID, bId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('ROOT_FORBIDDEN');
    }
  });

  it('移动到墓碑父抛 NODE_DELETED；不存在父抛 NODE_NOT_FOUND', () => {
    const doc = buildTestTree();
    const aId = findIdByText(doc, 'A');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');

    const bRaw = doc.getMap('nodes').get(bId) as { set: (k: string, v: unknown) => void };
    doc.transact(() => bRaw.set('deleted', true));
    try {
      moveNode(doc, a2Id, bId);
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_DELETED');
    }
    // 树无变化：a2 仍在原位
    expect(getNode(doc, a2Id)!.parentId).toBe(aId);

    try {
      moveNode(doc, a2Id, 'nope');
      expect.unreachable();
    } catch (e) {
      expect((e as GmindCoreError).code).toBe('NODE_NOT_FOUND');
    }
  });
});
