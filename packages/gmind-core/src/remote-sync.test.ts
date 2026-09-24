import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Transaction } from 'yjs';
import { createTemplateDoc, docFromState, docToState } from './doc';
import { ORIGIN_SYSTEM, deleteNodes, moveNode } from './operations';
import { childrenIds, getNode } from './read';
import type { NodeSnapshot } from './read';
import { attachRemoteNormalization, normalizeTree } from './repair';

/**
 * 远端事务收敛接线（M2 准入清单 §1）——@gmind/core 级契约钉死。
 *
 * 本地写经 withTransaction 自带按脏区 normalize；而远端更新经 HocuspocusProvider
 * 以裸 Y.applyUpdate 直入（无 withTransaction）——并发残留（move vs delete、
 * 换父败者侧等）会未治愈落库。本套件钉住修复域接线件 attachRemoteNormalization：
 *  - 无接线：远端 update 的残留原样落库（收敛缺口留档，解释接线为何必须存在）；
 *  - 接线后：远端事务在 afterTransaction 内以 deriveNormalizeDirty → normalizeTreeFor
 *    治愈，且 heal 写为 system origin（不进本地撤销栈，undo.test.ts 增补钉死）；
 *  - detach 返回注销函数（destroy 卫生）；
 *  - 接线副本上本地写二段 normalize 幂等零修复（双过闸无害，collab.ts 统一入口的代价）；
 *  - 接线收敛结果与「无接线 + 手动全量 normalize」完全一致（副本一致性口径）。
 * Task 8 并发混沌套件（准入清单 §8.1）直接依赖本契约。
 */

/** 按文本查节点 id（测试辅助；模板生成的 ULID 不可预知，同源克隆的 id 一致）。 */
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

/**
 * 同源场景构造：base = root[P1, X]；本端 deleteNodes([X])、远端 moveNode(X → P1)
 * 并发；返回仅含远端 move 事务的裸 update 与相关 id——正是 applyUpdate 直入路径上
 * withTransaction 覆盖不到的「move vs delete」并发残留事务。
 */
function moveVsDeleteScene(): {
  local: Y.Doc;
  update: Uint8Array;
  xId: string;
  p1Id: string;
} {
  const base = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }, { text: 'X' }] });
  const local = docFromState(docToState(base));
  const remote = docFromState(docToState(base));
  const xId = findIdByText(local, 'X');
  const p1Id = findIdByText(local, 'P1');
  const sv = Y.encodeStateVector(local); // 两端此刻同态 = base 状态向量
  deleteNodes(local, [xId]); // 本端并发删除（withTransaction 已 normalize，本端无残留）
  moveNode(remote, xId, p1Id); // 远端移动（同上；normalize 零修复无额外写入）
  return { local, update: Y.encodeStateAsUpdate(remote, sv), xId, p1Id };
}

describe('无接线：远端 update 直入不收敛（收敛缺口留档）', () => {
  it('远端 move vs 本端 delete 的并发残留经裸 applyUpdate 原样落库', () => {
    const { local, update, xId, p1Id } = moveVsDeleteScene();
    Y.applyUpdate(local, update); // 裸 applyUpdate：无任何 normalize

    // 残留在库：墓碑 X 仍挂在 P1 的 children（规则③违例），无人治愈
    expect(getNode(local, xId)!.deleted).toBe(true);
    expect(childrenIds(local, p1Id)).toEqual([xId]);
    expect(normalizeTree(local, ORIGIN_SYSTEM)).toBeGreaterThan(0); // 全量扫描确认违例在库
  });
});

describe('attachRemoteNormalization：远端事务收敛接线（准入清单 §1）', () => {
  it('接线后同一残留 update 在 afterTransaction 内被治愈：③ 清理 + 全量复扫为 0', () => {
    const { local, update, xId, p1Id } = moveVsDeleteScene();

    const origins: Array<string | null> = [];
    local.on('afterTransaction', (tr: Transaction) => origins.push(tr.origin ?? null));
    const detach = attachRemoteNormalization(local);
    expect(typeof detach).toBe('function'); // 返回注销函数（destroy 卫生）

    Y.applyUpdate(local, update); // 远端裸事务：applyUpdate 期间即治愈

    // heal 写为恰好一个 system 事务（远端事务 origin=null → 随后一个 'system'）
    expect(origins[0]).toBeNull();
    expect(origins[origins.length - 1]).toBe('system');
    // 治愈结局：墓碑 X 从 P1.children 清除、本体保留（快照可还原）
    expect(childrenIds(local, p1Id)).toEqual([]);
    expect(getNode(local, xId)).not.toBeNull();
    expect(getNode(local, xId)!.deleted).toBe(true);
    // 无任何残留：全量复扫为 0（接线后文档恒满足 §4.2 不变量的收口断言）
    expect(normalizeTree(local, ORIGIN_SYSTEM)).toBe(0);
  });

  it('detach 后停止治愈：远端残留再次原样落库', () => {
    const { local, update, xId, p1Id } = moveVsDeleteScene();
    const detach = attachRemoteNormalization(local);
    detach(); // 注销

    Y.applyUpdate(local, update);
    expect(childrenIds(local, p1Id)).toEqual([xId]); // 残留落库（接线已注销）
    expect(normalizeTree(local, ORIGIN_SYSTEM)).toBeGreaterThan(0);
  });

  it('接线副本上的本地写二段 normalize 幂等：干净操作不产生额外事务/写入', () => {
    const doc = docFromState(docToState(createTemplateDoc({
      title: 'T',
      children: [{ text: 'P1' }],
    })));
    const p1Id = findIdByText(doc, 'P1');
    attachRemoteNormalization(doc);
    const origins: string[] = [];
    doc.on('afterTransaction', (tr: Transaction) => origins.push(String(tr.origin)));

    moveNode(doc, p1Id, 'root'); // 本地写（withTransaction 已按脏区 normalize）

    // 仅 'user' 一个事务：withTransaction 的 normalize 与接线第二趟都零修复、不开事务
    // ——collab.ts 统一入口的「双过闸」代价只多一次只读推导，无额外写入。
    expect(origins).toEqual(['user']);
    expect(normalizeTree(doc, ORIGIN_SYSTEM)).toBe(0);
  });

  it('接线收敛结果与无接线 + 手动全量 normalize 完全一致（副本一致性口径）', () => {
    // 同一残留 update 分别打到「接线副本」与「无接线副本（事后全量 normalize）」，
    // 全量快照必须一致——接线不是新语义，只是把既有收敛函数挂到远端事务上。
    const base = createTemplateDoc({ title: 'T', children: [{ text: 'P1' }, { text: 'X' }] });
    const wired = docFromState(docToState(base));
    const manual = docFromState(docToState(base));
    const remote = docFromState(docToState(base));
    const xId = findIdByText(wired, 'X');
    const p1Id = findIdByText(wired, 'P1');
    const sv = Y.encodeStateVector(wired);
    deleteNodes(wired, [xId]);
    deleteNodes(manual, [xId]);
    moveNode(remote, xId, p1Id);
    const update = Y.encodeStateAsUpdate(remote, sv);

    attachRemoteNormalization(wired);
    Y.applyUpdate(wired, update);
    Y.applyUpdate(manual, update);
    normalizeTree(manual, ORIGIN_SYSTEM); // 手动全量（M1a 口径）

    expect(fullSnapshot(wired)).toEqual(fullSnapshot(manual));
    expect(childrenIds(wired, p1Id)).toEqual([]);
    expect(childrenIds(wired, 'root')).not.toContain(xId);
    expect(getNode(wired, xId)!.deleted).toBe(true);
    expect(normalizeTree(wired, ORIGIN_SYSTEM)).toBe(0);
  });
});
