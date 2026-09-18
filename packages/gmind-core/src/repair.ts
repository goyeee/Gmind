import * as Y from 'yjs';
import { ROOT_NODE_ID } from './doc';
import { ORIGIN_SYSTEM } from './operations';

/**
 * normalizeTree —— 树结构 repair 收敛（spec §4.2，全项目唯一自研共识点）。
 *
 * `parentId` 是父级归属的唯一真值，`children` 数组只定同级顺序。本函数是**文档状态的
 * 纯函数**：给定相同文档状态，在任何副本上都执行相同修复并得到相同结果（FR-COL-003）：
 *  ① children 数组去重（保留首个）；
 *  ② 移除指向不存在节点的项（含非字符串垃圾项的防御清除）；
 *  ③ 移除指向墓碑节点（deleted===true）的项；
 *  ④ 移除「目标节点 parentId !== 本节点 id」的项（并发换父的败者侧清理）；
 *  ⑤ 存活非 root 节点若不在其 parentId 的 children 中 → 追加到末尾；
 *  ⑥ root 缺失 → 防御重建（text ''、parentId ''、空 children），存活孤儿随后按 ⑤ 挂回。
 *
 * 冻结不变量：墓碑节点的 children 数组是撤销/快照还原依据（deleteNodes 保留不动），
 * 本函数绝不写墓碑节点的 children，也不向墓碑父级追加子节点。
 *
 * 事务纪律：仅在确有修复时开**一个** origin（默认 ORIGIN_SYSTEM）事务；干净文档返回 0
 * 且不产生任何写入（不开事务）。返回修复次数（每处移除/追加/重建各计 1）。
 *
 * 所有读取容错部分数据（镜像 read.ts 防御风格）：children 缺失/类型不符、parentId 缺失
 * 等一律按默认值处理，绝不抛错；无法归属的畸形节点确定性跳过（同状态 ⇒ 同行为）。
 */

function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

function parentIdOf(node: Y.Map<unknown>): string {
  const v = node.get('parentId');
  return typeof v === 'string' ? v : '';
}

function isTombstoned(node: Y.Map<unknown>): boolean {
  return node.get('deleted') === true;
}

function childrenOf(node: Y.Map<unknown>): Y.Array<string> | undefined {
  const children = node.get('children');
  return children instanceof Y.Array ? (children as Y.Array<string>) : undefined;
}

/** 阶段一产物：某存活节点的 children 数组待移除下标（升序）。 */
interface ChildrenCleanup {
  node: Y.Map<unknown>;
  children: Y.Array<string>;
  removeIndexes: number[];
}

/** 阶段二产物：把 childId 追加到 parentId 的 children 末尾（父缺 children 数组则补建）。 */
interface ChildAppend {
  parentId: string;
  childId: string;
}

export function normalizeTree(doc: Y.Doc, origin: string = ORIGIN_SYSTEM): number {
  const nodes = nodesMap(doc);
  let repairs = 0;

  // 规则⑥前置探测：root 缺失先计修复（重建后，⑤ 才能把「parentId==='root'」的存活孤儿挂回新 root）。
  const rootMissing = nodes.get(ROOT_NODE_ID) === undefined;
  if (rootMissing) repairs += 1;

  // ── 阶段一（规划）：清理「存活节点」的 children 数组（root 例外地始终参与；
  //    墓碑节点的 children 冻结不动）。先全部规划再统一应用，保证 ⑤ 的成员判定
  //    基于阶段一之后的数组状态（被从错误父级移除的项，同一轮即挂回正确父级）。
  const cleanups: ChildrenCleanup[] = [];
  // 阶段一之后各存活节点的 children 内容（无修复处即原数组），供阶段二成员判定。
  const keptByNode = new Map<Y.Map<unknown>, string[]>();
  for (const [id, node] of nodes.entries()) {
    if (id !== ROOT_NODE_ID && isTombstoned(node)) continue; // 墓碑 children 冻结
    const children = childrenOf(node);
    if (!children) continue;
    const entries = children.toArray();
    const seen = new Set<string>();
    const kept: string[] = [];
    const removeIndexes: number[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const childId = entries[i] as string;
      const child = typeof childId === 'string' ? nodes.get(childId) : undefined;
      if (typeof childId !== 'string' || child === undefined || seen.has(childId)) {
        removeIndexes.push(i); // ① 去重 / ② 不存在（含非字符串垃圾项）
        continue;
      }
      if (isTombstoned(child) || parentIdOf(child) !== id) {
        removeIndexes.push(i); // ③ 墓碑 / ④ 换父败者侧
        continue;
      }
      seen.add(childId);
      kept.push(childId);
    }
    if (removeIndexes.length > 0) {
      cleanups.push({ node, children, removeIndexes });
      repairs += removeIndexes.length;
    }
    keptByNode.set(node, kept);
  }

  // ── 阶段二（规划）：存活非 root 节点若不在其 parentId 的 children 中 → 追加到末尾。
  //    追加顺序即 nodes 遍历序——Yjs 收敛后各副本 entries 序一致，仍是状态的纯函数。
  const appends: ChildAppend[] = [];
  for (const [id, node] of nodes.entries()) {
    if (id === ROOT_NODE_ID) continue;
    if (isTombstoned(node)) continue; // ⑤ 仅存活节点
    const parentId = parentIdOf(node);
    if (parentId === '' || parentId === id) continue; // 防御：无父/自环，确定性跳过
    const parent = nodes.get(parentId);
    const virtualNewRoot = rootMissing && parentId === ROOT_NODE_ID;
    if (parent === undefined && !virtualNewRoot) continue; // 防御：父不存在
    if (parent !== undefined && parentId !== ROOT_NODE_ID && isTombstoned(parent)) {
      continue; // 冻结：不向墓碑父级追加（其 children 是快照还原依据）
    }
    const planned =
      virtualNewRoot ? [] : (keptByNode.get(parent as Y.Map<unknown>) ??
        childrenOf(parent as Y.Map<unknown>)?.toArray() ??
        []);
    if (planned.includes(id)) continue;
    appends.push({ parentId, childId: id });
    repairs += 1;
  }

  // ── 事务纪律：无修复不开事务、零写入；有修复则在单个 origin 事务内统一应用。
  if (repairs === 0) return 0;
  doc.transact(() => {
    if (rootMissing) {
      const root = new Y.Map<unknown>();
      root.set('text', '');
      root.set('parentId', '');
      root.set('children', new Y.Array<string>());
      nodes.set(ROOT_NODE_ID, root);
    }
    for (const c of cleanups) {
      // 倒序删除保持下标稳定
      for (let k = c.removeIndexes.length - 1; k >= 0; k -= 1) {
        c.children.delete(c.removeIndexes[k] as number, 1);
      }
    }
    for (const a of appends) {
      const parent = nodes.get(a.parentId);
      if (!parent) continue; // 防御（单事务内理论上不可达）
      let arr = childrenOf(parent);
      if (!arr) {
        arr = new Y.Array<string>();
        parent.set('children', arr);
      }
      arr.push([a.childId]);
    }
  }, origin);
  return repairs;
}
