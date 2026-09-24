import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ROOT_NODE_ID, createTemplateDoc, docFromState, docToState } from './doc';
import { addChild, deleteNodes, moveNode } from './operations';
import { childrenIds, countAlive, getMeta, getNode, setDocMeta } from './read';
import type { NodeSnapshot } from './read';
import { attachRemoteNormalization, normalizeTree } from './repair';
import { ORIGIN_SYSTEM, ORIGIN_USER, capUndoStack, createUndoManager, redo, undo } from './undo';

/** 空白文档（仅中心主题）。 */
function blankDoc(): Y.Doc {
  return createTemplateDoc({ title: 'T', children: [] });
}

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知）。 */
function findIdByText(doc: Y.Doc, text: string): string {
  for (const [id, node] of doc.getMap('nodes').entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/** 全文档节点快照（getNode 全量逐节点 deep-equal 口径）。 */
function fullSnapshot(doc: Y.Doc): Record<string, NodeSnapshot | null> {
  const out: Record<string, NodeSnapshot | null> = {};
  for (const id of doc.getMap('nodes').keys()) out[id] = getNode(doc, id);
  return out;
}

describe('ORIGIN 常量迁至 undo.ts', () => {
  it('ORIGIN_USER=user、ORIGIN_SYSTEM=system', () => {
    expect(ORIGIN_USER).toBe('user');
    expect(ORIGIN_SYSTEM).toBe('system');
  });
});

describe('createUndoManager', () => {
  it('仅跟踪 user origin，captureTimeout 默认 500', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    expect(um.captureTimeout).toBe(500);
    expect(um.trackedOrigins.has(ORIGIN_USER)).toBe(true);
  });
});

describe('undo / redo 基本流程', () => {
  it('addChild 后 undo 节点消失（getNode null、nodes 数回退），redo 恢复', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    const id = addChild(doc, 'root', { text: 'A' });
    expect(um.undoStack.length).toBe(1);
    expect(getNode(doc, id)).not.toBeNull();

    expect(undo(um)).toBe(true);
    expect(getNode(doc, id)).toBeNull();
    expect(doc.getMap('nodes').size).toBe(1);
    expect(childrenIds(doc, 'root')).toEqual([]);

    expect(redo(um)).toBe(true);
    expect(getNode(doc, id)!.text).toBe('A');
    expect(childrenIds(doc, 'root')).toEqual([id]);
  });

  it('undo addChild 后树状态一致：父 children 不再含该节点、兄弟不受影响；redo 回原位', () => {
    const doc = blankDoc();
    const aId = addChild(doc, 'root', { text: 'A' });
    const um = createUndoManager(doc);
    const bId = addChild(doc, 'root', { text: 'B' });

    expect(undo(um)).toBe(true);
    expect(getNode(doc, bId)).toBeNull();
    expect(doc.getMap('nodes').size).toBe(2);
    expect(getNode(doc, 'root')!.childIds).toEqual([aId]);
    expect(getNode(doc, aId)!.deleted).toBe(false);

    expect(redo(um)).toBe(true);
    expect(getNode(doc, 'root')!.childIds).toEqual([aId, bId]);
    expect(getNode(doc, bId)!.text).toBe('B');
  });

  it('空栈时 undo/redo 返回 false', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    expect(undo(um)).toBe(false);
    expect(redo(um)).toBe(false);
  });
});

describe('system origin 写不进撤销栈（折叠等内部写天然不可撤销）', () => {
  it('setDocMeta 以 system 调用：undo 返回 false 且该变更仍在', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    setDocMeta(doc, { title: 'X' }, 'system');

    expect(um.undoStack.length).toBe(0);
    expect(undo(um)).toBe(false);
    expect(getMeta(doc).title).toBe('X');
  });

  it('无 origin 的裸 transact（origin null）同样不进栈', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    doc.transact(() => {
      doc.getMap('meta').set('title', 'Y');
    });

    expect(um.undoStack.length).toBe(0);
    expect(undo(um)).toBe(false);
    expect(getMeta(doc).title).toBe('Y');
  });
});

describe('栈深 100（FR-EDT-004）', () => {
  it('105 次 addChild 每次 capUndoStack 后 undoStack.length===100，undo 恰好 100 次后返回 false', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    const ids: string[] = [];
    for (let i = 0; i < 105; i += 1) {
      ids.push(addChild(doc, 'root', { text: `n${i}` }));
      capUndoStack(um); // 默认 max=100
      um.stopCapturing(); // 隔离 captureTimeout，保证每次 addChild 独立成栈项
    }
    expect(um.undoStack.length).toBe(100);

    // 被裁掉的是最早 5 条：undo 到底后文档应回到「前 5 个子节点」状态
    expect(undo(um)).toBe(true);
    for (let i = 0; i < 99; i += 1) {
      expect(undo(um), `undo #${i + 2}`).toBe(true);
    }
    expect(undo(um)).toBe(false);
    expect(um.undoStack.length).toBe(0);

    expect(childrenIds(doc, 'root')).toEqual(ids.slice(0, 5));
    expect(doc.getMap('nodes').size).toBe(6);
    expect(countAlive(doc)).toBe(5);
  });
});

describe('撤销后新编辑清空重做栈（FR-EDT-004）', () => {
  it('undo 产生 redoStack，随后 user 编辑立即清空，redo 返回 false', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    const aId = addChild(doc, 'root', { text: 'A' });
    um.stopCapturing();
    expect(undo(um)).toBe(true);
    expect(um.redoStack.length).toBe(1);

    addChild(doc, 'root', { text: 'B' });
    expect(um.redoStack.length).toBe(0);
    expect(redo(um)).toBe(false);
    expect(childrenIds(doc, 'root')).not.toContain(aId);
    expect(getNode(doc, aId)).toBeNull();
  });
});

describe('captureTimeout 合并', () => {
  it('500ms 内连续两次 addChild 合并为一条撤销单元，一次 undo 撤销两笔', () => {
    const doc = blankDoc();
    const um = createUndoManager(doc);
    const aId = addChild(doc, 'root', { text: 'A' });
    const bId = addChild(doc, 'root', { text: 'B' });
    expect(um.undoStack.length).toBe(1);

    expect(undo(um)).toBe(true);
    expect(getNode(doc, aId)).toBeNull();
    expect(getNode(doc, bId)).toBeNull();
    expect(childrenIds(doc, 'root')).toEqual([]);

    expect(um.redoStack.length).toBe(1);
    expect(redo(um)).toBe(true);
    expect(childrenIds(doc, 'root')).toEqual([aId, bId]);
  });
});

describe('远端事务不进本地撤销栈（M2 准入清单 §1 多端撤销断言）', () => {
  /**
   * 场景（接线挂载，与生产 useEditorDoc→startCollab 顺序一致）：本端 deleteNodes([X])
   * 进撤销栈；远端并发 moveNode(X → P1) 以裸 applyUpdate 直入——远端事务与其触发的
   * 接线 heal 写（system origin）都不得改变本地撤销栈；undo 仍只回退本端操作，
   * 远端写入的效果在 undo 后保留（由此产生的换父残留由接线当轮治愈）。
   */
  it('applyUpdate（远端 move + 接线 heal）后 undoStack 不变，undo 只回退本人删除', () => {
    const base = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }, { text: 'X' }] });
    const state = docToState(base);
    const doc = docFromState(state);
    const remote = docFromState(state);
    const xId = findIdByText(doc, 'X');
    const p1Id = findIdByText(doc, 'P1');
    const aliveBefore = fullSnapshot(doc);

    const um = createUndoManager(doc);
    attachRemoteNormalization(doc); // 生产接线（um 之后挂载，顺序同 collab.ts）

    deleteNodes(doc, [xId]); // 本端 user 操作：唯一进栈项
    expect(um.undoStack.length).toBe(1);

    const sv = Y.encodeStateVector(remote);
    moveNode(remote, xId, p1Id);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, sv)); // 远端裸事务 + 接线 heal 写

    expect(um.undoStack.length).toBe(1); // 远端 apply 与 heal 均未进栈
    expect(childrenIds(doc, p1Id)).toEqual([]); // heal 已清理墓碑 X 的换父残留
    expect(getNode(doc, xId)!.deleted).toBe(true); // 本端删除的墓碑不受远端事务影响

    expect(undo(um)).toBe(true); // undo 只回退本人删除
    expect(getNode(doc, xId)!.deleted).toBe(false); // X 复活（本人删除被撤销）
    expect(getNode(doc, xId)!.parentId).toBe(p1Id); // 远端移动结果保留（undo 不吃远端写）
    // 远端移动 + undo 还原的组合残留（X 同时挂在 root 与 P1）已由接线当轮治愈
    expect(childrenIds(doc, p1Id)).toEqual([xId]);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([p1Id]);
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0); // 无任何残留
    expect(um.undoStack.length).toBe(0);
    expect(fullSnapshot(doc)).not.toEqual(aliveBefore); // X 停在远端移动后的新父（远端写存活）
  });
});

describe('undo(deleteNodes) 往返钉死（T4 冻结 × T5 normalize × T6 undo 缝合）', () => {
  it('删中间节点（级联墓碑、后代 children 冻结）→ undo 还原全文档快照且 normalize=0，redo 回删除态', () => {
    // root → [A[A1[A1a], A2], B[B1]]；删中间节点 A（级联 A1/A1a/A2）
    const doc = createTemplateDoc({
      title: 'T',
      children: [
        { text: 'A', children: [{ text: 'A1', children: [{ text: 'A1a' }] }, { text: 'A2' }] },
        { text: 'B', children: [{ text: 'B1' }] },
      ],
    });
    const um = createUndoManager(doc); // 先于删除创建（user origin 进栈）
    const aId = findIdByText(doc, 'A');
    const a1Id = findIdByText(doc, 'A1');
    const a1aId = findIdByText(doc, 'A1a');
    const a2Id = findIdByText(doc, 'A2');
    const bId = findIdByText(doc, 'B');

    const before = fullSnapshot(doc);
    deleteNodes(doc, [aId]);
    // 删除态就位：级联墓碑 + A 从 root children 移除 + 后代 children 冻结不动
    for (const id of [aId, a1Id, a1aId, a2Id]) expect(getNode(doc, id)!.deleted, id).toBe(true);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([bId]);
    expect(
      ((doc.getMap('nodes').get(aId) as Y.Map<unknown>).get('children') as Y.Array<string>).toArray(),
    ).toEqual([a1Id, a2Id]); // T4：冻结（快照还原依据）

    // undo → 全文档逐节点快照与删除前完全一致
    expect(undo(um)).toBe(true);
    expect(fullSnapshot(doc)).toEqual(before);
    // T5×T6 缝合：还原态满足全部 §4.2 不变量（normalize 零修复）
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0);

    // redo → 删除态还原
    expect(redo(um)).toBe(true);
    for (const id of [aId, a1Id, a1aId, a2Id]) expect(getNode(doc, id)!.deleted, id).toBe(true);
    expect(childrenIds(doc, ROOT_NODE_ID)).toEqual([bId]);
    expect(getNode(doc, bId)!.deleted).toBe(false);
  });
});
