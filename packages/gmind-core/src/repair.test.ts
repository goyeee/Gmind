import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Transaction } from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc, docFromState, docToState } from './doc';
import { ORIGIN_SYSTEM, ORIGIN_USER, addChild, deleteNodes, moveNode, setText, withTransaction } from './operations';
import { childrenIds, getNode } from './read';
import type { NodeSnapshot } from './read';
import { normalizeTree } from './repair';

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知，同源克隆的 id 一致）。 */
function findIdByText(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/** 全文档节点快照（getNode 全量）——交错一致性按此逐节点 deep-equal。 */
function fullSnapshot(doc: Y.Doc): Record<string, NodeSnapshot | null> {
  const out: Record<string, NodeSnapshot | null> = {};
  for (const id of doc.getMap('nodes').keys()) out[id] = getNode(doc, id);
  return out;
}

/** 裸取节点 Y.Map（破坏场景用；绕过操作层校验模拟并发残留）。 */
function rawNode(doc: Y.Doc, id: string): Y.Map<unknown> {
  return doc.getMap('nodes').get(id) as Y.Map<unknown>;
}

/** 裸取 children Y.Array（破坏场景用）。 */
function rawChildren(doc: Y.Doc, id: string): Y.Array<string> {
  return rawNode(doc, id).get('children') as Y.Array<string>;
}

/** 从 base 状态克隆出两份同源文档（单机模拟并发的基线）。 */
function clonePair(base: Y.Doc): { docA: Y.Doc; docB: Y.Doc } {
  const state = docToState(base);
  return { docA: docFromState(state), docB: docFromState(state) };
}

/** 双向交换更新：A↔B 互通后两文档 CRDT 状态收敛一致。 */
function exchange(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
}

describe('normalizeTree 破坏场景修复（spec §4.2 规则逐条）', () => {
  it('同一 id 出现在两个 children（parentId 指向其一）→ 仅 parentId 侧保留，返回修复次数 >0', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }, { text: 'P2' }] });
    const p1Id = findIdByText(doc, 'P1');
    const p2Id = findIdByText(doc, 'P2');
    const xId = addChild(doc, p1Id, { text: 'X' });
    // 并发换父残留：P2 的 children 里混入 x（x.parentId 仍指向 P1）
    doc.transact(() => {
      rawChildren(doc, p2Id).push([xId]);
    });

    expect(normalizeTree(doc)).toBe(1); // 败者侧（P2）恰一处移除
    expect(childrenIds(doc, p1Id)).toEqual([xId]);
    expect(childrenIds(doc, p2Id)).toEqual([]);
    expect(getNode(doc, xId)!.parentId).toBe(p1Id);
    expect(getNode(doc, xId)!.deleted).toBe(false);
  });

  it('children 含不存在的 id → 被清除', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }] });
    const p1Id = findIdByText(doc, 'P1');
    doc.transact(() => {
      rawChildren(doc, p1Id).push(['ghost-id-1', 'ghost-id-2']);
    });

    expect(normalizeTree(doc)).toBe(2);
    expect(childrenIds(doc, p1Id)).toEqual([]);
    expect(doc.getMap('nodes').size).toBe(2); // root + P1，无副作用写入
  });

  it('children 含墓碑 id → 条目被清除，节点本体保留（快照可还原）', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }] });
    const p1Id = findIdByText(doc, 'P1');
    const xId = addChild(doc, p1Id, { text: 'X' });
    // 裸写墓碑（children 不动，模拟并发删除残留）
    doc.transact(() => {
      rawNode(doc, xId).set('deleted', true);
    });
    expect(childrenIds(doc, p1Id)).toEqual([xId]);

    expect(normalizeTree(doc)).toBe(1);
    expect(childrenIds(doc, p1Id)).toEqual([]);
    expect(getNode(doc, xId)).not.toBeNull(); // 节点本体不删
    expect(getNode(doc, xId)!.deleted).toBe(true);
  });

  it('存活节点不在父 children → 追加到末尾', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'P1', children: [{ text: 'A' }, { text: 'B' }] }],
    });
    const p1Id = findIdByText(doc, 'P1');
    const aId = findIdByText(doc, 'A');
    const bId = findIdByText(doc, 'B');
    const xId = addChild(doc, p1Id, { index: 1, text: 'X' }); // [A, X, B]
    // 裸删条目（节点存活，parentId 仍指向 P1）
    doc.transact(() => {
      rawChildren(doc, p1Id).delete(1, 1); // [A, B]
    });

    expect(normalizeTree(doc)).toBe(1);
    expect(childrenIds(doc, p1Id)).toEqual([aId, bId, xId]); // 追加到末尾
    expect(getNode(doc, xId)!.parentId).toBe(p1Id);
  });

  it('干净文档：返回 0、不开事务、状态字节级不变', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }, { text: 'B' }] });
    addChild(doc, findIdByText(doc, 'A'), { text: 'A1' });
    const before = docToState(doc);
    const origins: string[] = [];
    doc.on('afterTransaction', (tr: Transaction) => origins.push(String(tr.origin)));

    expect(normalizeTree(doc)).toBe(0);
    expect(origins).toEqual([]); // 无修复不开事务
    expect(Buffer.from(docToState(doc)).equals(Buffer.from(before))).toBe(true);
  });

  it('墓碑冻结不变量：deleteNodes 之后的文档 normalize 返回 0，保留 children 不被改动', () => {
    const doc = createTemplateDoc({
      title: 'T',
      children: [{ text: 'A', children: [{ text: 'A1' }] }, { text: 'B' }],
    });
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');

    deleteNodes(doc, [aId, a1Id]);
    // 基线取「删除后、normalize 前」：断言 normalize 本身零写入
    const before = docToState(doc);
    // 墓碑 A 的保留 children [A1, A2 式结构] 不得被 normalize 触碰
    expect(normalizeTree(doc)).toBe(0);
    const aRaw = rawNode(doc, aId);
    expect((aRaw.get('children') as Y.Array<string>).toArray()).toEqual([a1Id]);
    expect(Buffer.from(docToState(doc)).equals(Buffer.from(before))).toBe(true);
  });

  it('root 缺失 → 防御重建（text 空、parentId 空、空 children），存活孤儿按 parentId 挂回', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'A' }] });
    const aId = findIdByText(doc, 'A');
    doc.transact(() => {
      doc.getMap('nodes').delete(ROOT_NODE_ID);
    });

    expect(normalizeTree(doc)).toBe(2); // 重建 root(1) + 追加 A(1)
    const root = getNode(doc, ROOT_NODE_ID)!;
    expect(root.text).toBe('');
    expect(root.parentId).toBe('');
    expect(root.childIds).toEqual([aId]);
    expect(getNode(doc, aId)!.parentId).toBe(ROOT_NODE_ID);
  });

  it('有修复时恰好开一个事务且 origin=system（默认）；重复调用幂等返回 0', () => {
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }] });
    const p1Id = findIdByText(doc, 'P1');
    doc.transact(() => {
      rawChildren(doc, ROOT_NODE_ID).push([p1Id, 'ghost-id']); // 去重(1) + 幽灵(1)
    });
    const origins: string[] = [];
    doc.on('afterTransaction', (tr: Transaction) => origins.push(String(tr.origin)));

    expect(normalizeTree(doc)).toBe(2);
    expect(origins).toEqual(['system']); // 单事务、system origin
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([p1Id]);

    expect(normalizeTree(doc)).toBe(0); // 幂等
    expect(origins).toEqual(['system']); // 第二次无新事务
  });
});

describe('normalizeTree 交错一致性（FR-COL-003 单机预演）', () => {
  it('move vs 无关删除并发：双向交换后双方 normalize，全量快照收敛一致', () => {
    const base = createTemplateDoc({
      title: 'T',
      children: [{ text: 'P1' }, { text: 'P2' }, { text: 'X', children: [{ text: 'X1' }] }],
    });
    const { docA, docB } = clonePair(base);
    const xId = findIdByText(docA, 'X');
    const p1Id = findIdByText(docA, 'P1');
    const p2Id = findIdByText(docB, 'P2');

    moveNode(docA, xId, p1Id);
    deleteNodes(docB, [p2Id]);
    exchange(docA, docB);
    normalizeTree(docA, ORIGIN_SYSTEM);
    normalizeTree(docB, ORIGIN_SYSTEM);

    const snapA = fullSnapshot(docA);
    const snapB = fullSnapshot(docB);
    expect(snapA).toEqual(snapB);
    // 具体收敛结局：X 存活于 P1 之下、P2 墓碑，两端一致
    expect(snapA[xId]).toMatchObject({ parentId: p1Id, deleted: false });
    expect(snapA[p2Id]!.deleted).toBe(true);
    expect(snapA[findIdByText(docA, 'X1')]).toMatchObject({ deleted: false });
  });

  it('并发换父（X→P1 vs X→P2）：LWW 定唯一胜者，repair 清败者，两端快照一致', () => {
    const base = createTemplateDoc({
      title: 'T',
      children: [{ text: 'P1' }, { text: 'P2' }, { text: 'X' }],
    });
    const state = docToState(base);
    const docA = docFromState(state);
    const docB = docFromState(state); // 必须在任何 op 之前从 base 克隆
    const xId = findIdByText(docA, 'X');
    const p1Id = findIdByText(docA, 'P1');
    const p2Id = findIdByText(docB, 'P2');

    moveNode(docA, xId, p1Id);
    moveNode(docB, xId, p2Id);
    exchange(docA, docB);
    const repairsA = normalizeTree(docA, ORIGIN_SYSTEM);
    const repairsB = normalizeTree(docB, ORIGIN_SYSTEM);
    expect(repairsA).toBeGreaterThan(0);
    expect(repairsA).toBe(repairsB);

    const snapA = fullSnapshot(docA);
    const snapB = fullSnapshot(docB);
    expect(snapA).toEqual(snapB);
    // LWW 定胜者：parentId 两端一致，且 x 恰好出现在胜者一方的 children 中
    const winner = snapA[xId]!.parentId;
    expect([p1Id, p2Id]).toContain(winner);
    const holders = Object.values(snapA)
      .filter((s) => s?.childIds.includes(xId))
      .map((s) => s!.id);
    expect(holders).toEqual([winner]);
    // 败者侧 children 已清理
    const loser = winner === p1Id ? p2Id : p1Id;
    expect(snapA[loser]!.childIds).toEqual([]);
  });

  it('移动 vs 删除同一节点并发：两端收敛为墓碑 + children 一致的确定性结局', () => {
    const base = createTemplateDoc({
      title: 'T',
      children: [{ text: 'P1' }, { text: 'P2' }, { text: 'X', children: [{ text: 'X1' }] }],
    });
    const state = docToState(base);
    const docA = docFromState(state);
    const docB = docFromState(state);
    const xId = findIdByText(docA, 'X');
    const x1Id = findIdByText(docA, 'X1');
    const p1Id = findIdByText(docA, 'P1');

    moveNode(docA, xId, p1Id);
    deleteNodes(docB, [xId]);
    exchange(docA, docB);
    normalizeTree(docA, ORIGIN_SYSTEM);
    normalizeTree(docB, ORIGIN_SYSTEM);

    const snapA = fullSnapshot(docA);
    const snapB = fullSnapshot(docB);
    expect(snapA).toEqual(snapB);
    // 确定性结局：deleted 键仅删除方写入 → 两端均墓碑；新父 children 被修复清理
    expect(snapA[xId]!.deleted).toBe(true);
    expect(snapA[x1Id]!.deleted).toBe(true);
    expect(snapA[p1Id]!.childIds).toEqual([]);
  });

  it('并发建点 + 复制的 children 清空破坏：多孤儿追加顺序按 id 升序，跨副本一致', () => {
    // 评审 C3 场景：nodes 迭代序是「本副本插入序」（本地键先于远端键），不属于
    // CRDT 收敛状态——同状态不同迭代序时，多孤儿追加必须按可观测状态（id）定序。
    const base = createTemplateDoc({ title: 'T', children: [{ text: 'P' }] });
    const state = docToState(base);
    const docA = docFromState(state);
    const docB = docFromState(state);
    const pId = findIdByText(docA, 'P');

    // 并发建点：A 本地建 X，B 本地建 Y
    const xId = addChild(docA, pId, { text: 'X' });
    const yId = addChild(docB, pId, { text: 'Y' });
    expect(xId).not.toBe(yId);

    // 双向同步：CRDT 状态一致（entries 迭代序不一致：A=[root,P,X,Y]，B=[root,P,Y,X]）
    exchange(docA, docB);

    // 复制的破坏：A 清空 P.children（两个孤儿），并传播到 B → 两端状态再次一致
    docA.transact(() => {
      rawChildren(docA, pId).delete(0, 2);
    });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(childrenIds(docA, pId)).toEqual([]);
    expect(childrenIds(docB, pId)).toEqual([]);

    normalizeTree(docA, ORIGIN_SYSTEM);
    normalizeTree(docB, ORIGIN_SYSTEM);

    // 收敛断言：P.children 两端完全一致，且等于孤儿按 id 升序（跨副本稳定序）
    const expected = [xId, yId].sort();
    expect(childrenIds(docA, pId)).toEqual(expected);
    expect(childrenIds(docB, pId)).toEqual(expected);
  });
});

describe('normalizeTreeFor 事务脏区增量（与全量等价，Task 9 修复轮）', () => {
  it('move+delete 残渣事务（裸写）：增量 normalize 与全量 normalize 快照一致，且增量后全量残留为 0', () => {
    const base = createTemplateDoc({
      title: 'T',
      children: [
        { text: 'P1', children: [{ text: 'A' }] },
        { text: 'P2', children: [{ text: 'B' }] },
        { text: 'X' },
      ],
    });
    const state = docToState(base);
    const docA = docFromState(state); // 增量路径（withTransaction 按脏区 normalize）
    const docB = docFromState(state); // 全量路径（同一残渣 update + normalizeTree）
    const xId = findIdByText(docA, 'X');
    const p1Id = findIdByText(docA, 'P1');
    const bId = findIdByText(docA, 'B');
    const p2Id = findIdByText(docA, 'P2');

    // 残渣事务：裸写、不带 removeFromParentChildren/墓碑联动（模拟复制残缺的远端事务）
    // ① X 换父到 P1，但旧父（root）children 残留 X —— 走 parentId 旧值链推导
    // ② B 裸墓碑，但 P2.children 残留 B —— 走 deleted 键推导
    const sv = Y.encodeStateVector(docA);
    withTransaction(docA, ORIGIN_USER, () => {
      rawNode(docA, xId).set('parentId', p1Id);
      rawNode(docA, bId).set('deleted', true);
    });
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA, sv));
    expect(fullSnapshot(docB)).toEqual(fullSnapshot(docA)); // 事务后（normalize 前）两端一致

    normalizeTree(docB, ORIGIN_SYSTEM); // docB 全量修复
    const snapA = fullSnapshot(docA);
    const snapB = fullSnapshot(docB);
    expect(snapA).toEqual(snapB); // 增量与全量最终状态一致
    // 具体结局：X 只挂在 P1 下；B 条目从 P2 清除、本体保留墓碑
    expect(snapA[xId]).toMatchObject({ parentId: p1Id, deleted: false });
    // 具体结局：X 只挂在 P1 下（原子 A 在前，X 追加）；B 条目从 P2 清除、本体保留墓碑
    expect(snapA[p1Id]!.childIds).toEqual([findIdByText(docA, 'A'), xId]);
    expect(snapA[p2Id]!.childIds).toEqual([]);
    expect(snapA[bId]!.deleted).toBe(true);
    expect(snapA[findIdByText(docA, 'A')]!.deleted).toBe(false);
    // 增量无残留：全量复扫为 0（对状态所有规则违例的等价性收口断言）
    expect(normalizeTree(docA, ORIGIN_SYSTEM)).toBe(0);
    expect(normalizeTree(docB, ORIGIN_SYSTEM)).toBe(0);
  });

  it('常规操作流差分：每个混合操作后，全量复扫（同状态克隆）均无残留且快照不变', () => {
    // 每个操作（增量 normalize 后）克隆当前状态跑全量 normalizeTree：修复数必须为 0
    // 且快照不变——若增量漏掉该事务制造的任何规则违例，克隆上的全量复扫必然 > 0。
    // （新建节点 id 含 ulid 随机量，无法跨文档复现同序操作，故采用「逐操作克隆复扫」。）
    const doc = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }, { text: 'P2' }] });
    const p1 = findIdByText(doc, 'P1');
    const p2 = findIdByText(doc, 'P2');
    const pool: string[] = [p1, p2]; // 非 root 存活节点（root 不可 move/delete）
    let seed = 0x5eed1234;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pickId = (): string => pool[rnd() % pool.length];
    const pickParent = (): string => (rnd() % 4 === 0 ? ROOT_NODE_ID : pickId());
    const subtreeOf = (id: string): string[] => {
      const out: string[] = [];
      const walk = (nodeId: string): void => {
        const node = doc.getMap('nodes').get(nodeId) as Y.Map<unknown> | undefined;
        if (!node || node.get('deleted') === true) return;
        out.push(nodeId);
        for (const childId of getNode(doc, nodeId)!.childIds) walk(childId);
      };
      walk(id);
      return out;
    };
    for (let i = 0; i < 200; i += 1) {
      switch (i % 4) {
        case 0:
          pool.push(addChild(doc, pickParent(), { text: `n${i}` }));
          break;
        case 1:
          setText(doc, pickId(), `t${i}`);
          break;
        case 2: {
          const id = pickId();
          let target = pickParent();
          if (subtreeOf(id).includes(target)) target = ROOT_NODE_ID;
          moveNode(doc, id, target);
          break;
        }
        default: {
          const id = pickId();
          const removed = subtreeOf(id);
          deleteNodes(doc, [id]);
          const gone = new Set(removed);
          for (let k = pool.length - 1; k >= 0; k -= 1) {
            if (gone.has(pool[k])) pool.splice(k, 1);
          }
          pool.push(addChild(doc, ROOT_NODE_ID, { text: `补充${i}` }));
          break;
        }
      }
      const clone = docFromState(docToState(doc));
      const before = fullSnapshot(doc);
      expect(normalizeTree(clone, ORIGIN_SYSTEM), `op #${i}`).toBe(0);
      expect(fullSnapshot(clone), `op #${i}`).toEqual(before);
    }
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0);
  });
});
