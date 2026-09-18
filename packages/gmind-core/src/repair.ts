import * as Y from 'yjs';
import type { AbstractType, YEvent } from 'yjs';
import { ROOT_NODE_ID } from './doc';
import { ORIGIN_SYSTEM } from './undo';

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
 *
 * ── 增量路径（Task 9 修复轮）──────────────────────────────────────────────
 * 写操作经 withTransaction 提交后，normalize 由全量扫描改为**按事务脏区**的
 * `normalizeTreeFor`（deriveNormalizeDirty 从 Yjs 事务对象的公开内部字段
 * changed/beforeState/deleteSet 推导脏区；本副本与远端副本对同一 update 推导出
 * 同一脏区，replica 一致）。等价性依据：产品流（含其远端重放）中每处规则违例
 * 都由制造它的同一事务在其 changed/deleteSet 中留下痕迹——
 * ①-④ 违例必在「被改动的 children 数组属主」处（含换父旧父级、墓碑父级）；
 * ⑤ 违例必命中「parentId 变更 / 新建节点 / 脏数组 kept 条目 / 脏数组被删条目」。
 * 无法确定性识别的形状（未知根类型/未知嵌套数组/root 缺失）→ 调用方退回全量扫描
 * 安全阀。`normalizeTree`（全量）仍是导入/恢复路径与测试的真值口径。
 *
 * 墓碑 GC 说明（有意不做，M2 语义需要）：墓碑节点是撤销/快照还原依据，永不清除，
 * nodes Y.Map 随「删除+新建」流量单调增长；增量 normalize 后单次操作成本只与脏区
 * 相关（不再随 map 总量线性上涨），500 节点产品上限下增长缓慢，GC 留待 M2 裁决。
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
  // 阶段一之后各存活节点的 children 成员（无修复处即原数组），供阶段二成员判定。
  // 用 Set：阶段二逐候选 O(1) 成员判定——数组 includes 在「单父大量 children」文档上
  // 呈 O(alive × children) 二次方（Task 9 基准对照实验实测爆点），Set.has 消除。
  const keptByNode = new Map<Y.Map<unknown>, Set<string>>();
  for (const [id, node] of nodes.entries()) {
    if (id !== ROOT_NODE_ID && isTombstoned(node)) continue; // 墓碑 children 冻结
    const children = childrenOf(node);
    if (!children) continue;
    const entries = children.toArray();
    const kept = new Set<string>();
    const removeIndexes: number[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const childId = entries[i] as string;
      const child = typeof childId === 'string' ? nodes.get(childId) : undefined;
      if (typeof childId !== 'string' || child === undefined || kept.has(childId)) {
        removeIndexes.push(i); // ① 去重 / ② 不存在（含非字符串垃圾项）
        continue;
      }
      if (isTombstoned(child) || parentIdOf(child) !== id) {
        removeIndexes.push(i); // ③ 墓碑 / ④ 换父败者侧
        continue;
      }
      kept.add(childId);
    }
    if (removeIndexes.length > 0) {
      cleanups.push({ node, children, removeIndexes });
      repairs += removeIndexes.length;
    }
    keptByNode.set(node, kept);
  }

  // ── 阶段二（规划）：存活非 root 节点若不在其 parentId 的 children 中 → 追加到末尾。
  //    注意：nodes 迭代序是「本副本插入序」（本地键先于远端键），不属于 CRDT 收敛状态，
  //    不可用作写入顺序；追加序由收集后的 id 升序排序决定（见 appends.sort）。
  // ── 事务纪律：无修复不开事务、零写入；有修复则在单个 origin 事务内统一应用。
  // 阶段二成员判定（Set 缓存，每父级只建一次；原数组 includes 是二次方爆点，见阶段一注释）。
  const plannedCache = new Map<Y.Map<unknown>, Set<string>>();
  const VIRTUAL_PLANNED: ReadonlySet<string> = new Set(); // 规则⑥：重建后的空 root
  const plannedOf = (parent: Y.Map<unknown> | undefined, virtualNewRoot: boolean): ReadonlySet<string> => {
    if (virtualNewRoot || parent === undefined) return VIRTUAL_PLANNED;
    let planned = plannedCache.get(parent);
    if (planned === undefined) {
      planned =
        keptByNode.get(parent) ?? new Set(childrenOf(parent)?.toArray() ?? []);
      plannedCache.set(parent, planned);
    }
    return planned;
  };
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
    if (plannedOf(parent, virtualNewRoot).has(id)) continue;
    appends.push({ parentId, childId: id });
    repairs += 1;
  }

  // 追加序 = childId 升序：id 是可观测的文档状态，跨副本完全一致——这是
  // 「同状态必同结果」的关键（nodes 遍历序是每副本本地插入序，跨副本不可靠）。
  appends.sort((a, b) => (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0));
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

// ════ 增量 normalize：事务脏区推导 + 定向修复（Task 9 修复轮）══════════════

// Yjs 13.6.x 公开 d.ts 即以 YEvent<any> 泛型发布其 AbstractType 签名，此处原样引用。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YjsChangeType = AbstractType<YEvent<any>>;

/** children 数组条目删除/覆盖前值的读取口径（Yjs 公开内部字段，13.6.x 稳定）。 */

/**
 * 节点 Y.Map 的 children 数组属主 id；非「节点 children 数组」形状返回 null。
 */
function ownerNodeIdOfArray(nodesRoot: Y.Map<Y.Map<unknown>>, arr: YjsChangeType): string | null {
  const item = arr._item;
  if (item === null || item.parentSub !== 'children' || item.parent === null) return null;
  const owner = item.parent;
  if (!('_item' in owner)) return null; // ID（未解析父）→ 非已集成类型
  const ownerItem = owner._item;
  if (ownerItem === null || ownerItem.parent !== nodesRoot || typeof ownerItem.parentSub !== 'string') {
    return null;
  }
  return ownerItem.parentSub;
}

/**
 * 节点 parentId 在本事务之前的旧值；本事务内首次写入返回 null；形状不可读返回 undefined
 * （调用方据此退回全量扫描安全阀）。
 *
 * 判定口径（replica 一致）：`transaction.beforeState` 是事务前的状态向量，某 client 的
 * item 满足 `clock >= beforeState.get(client)` 即为本事务写入的 item——沿 `_map` 同键
 * item 链（`item.left`）从最新值回退，跳过全部本事务写入，停在的即事务前值。
 * 本地与远端（重放同一 update）对同一状态推导出同一结果。
 */
function previousParentIdOf(
  type: YjsChangeType,
  beforeState: Map<number, number>,
): string | null | undefined {
  const latest = type._map.get('parentId');
  if (latest === undefined) return null;
  let cur: Y.Item | null = latest;
  while (cur !== null && cur.id.clock >= (beforeState.get(cur.id.client) ?? 0)) {
    cur = cur.left;
  }
  if (cur === null) return null; // parentId 在本事务内首次出现 → 无旧父
  const value = cur.content.getContent()[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * 从事务的 changed/beforeState/deleteSet 推导增量 normalize 脏区（节点 id 集合，语义：
 * ①-④ 施加于每个脏 id 的 children 数组；⑤ 施加于每个脏 id 自身与其脏数组的成员）。
 * 返回 null 表示形状无法确定性识别 → 调用方退回全量扫描（安全阀，见文件头等价性依据）。
 */
export function deriveNormalizeDirty(doc: Y.Doc, tr: Y.Transaction): Set<string> | null {
  const nodesRoot = nodesMap(doc);
  const nodesRootType = nodesRoot as unknown as YjsChangeType;
  const dirty = new Set<string>();
  for (const [type, keys] of tr.changed) {
    if (type === nodesRootType) {
      // nodes 根的新键 = 新建/重建节点 id（⑤ 候选）
      for (const key of keys) {
        if (typeof key === 'string' && key !== '') dirty.add(key);
      }
      continue;
    }
    const item = type._item;
    if (item === null) continue; // 其他根类型（meta 等）：非结构变更，无脏区
    if (item.parent === nodesRoot && typeof item.parentSub === 'string') {
      // 节点 Y.Map 的键变更：结构键 = parentId / children / deleted
      const nodeId = item.parentSub;
      if (keys.has('parentId')) {
        dirty.add(nodeId); // ⑤ 自查
        const node = nodesRoot.get(nodeId);
        const newParent = node !== undefined ? parentIdOf(node) : '';
        if (newParent !== '') dirty.add(newParent); // 新父数组 ④/⑤
        const old = previousParentIdOf(type, tr.beforeState);
        if (old === undefined) return null;
        if (old !== null && old !== '') dirty.add(old); // 旧父数组 ④ 败者侧
      }
      if (keys.has('children')) dirty.add(nodeId); // 数组被替换 → ①-④ + 成员 ⑤
      if (keys.has('deleted')) {
        if (nodeId === ROOT_NODE_ID) return null; // root 墓碑：非产品形状 → 全量
        const node = nodesRoot.get(nodeId);
        const parent = node !== undefined ? parentIdOf(node) : '';
        if (parent === '') return null; // 无主墓碑 → 全量
        dirty.add(parent); // 父数组 ③ 清理
      }
      continue;
    }
    const arrayOwner = ownerNodeIdOfArray(nodesRoot, type);
    if (arrayOwner !== null) {
      dirty.add(arrayOwner); // children 数组被直接改动 → ①-④ + kept 成员 ⑤
      continue;
    }
    if (item.parentSub === null) return null; // 未知嵌套数组 → 全量安全阀
    // 其余嵌套 Y.Map（icons/style 子 Map 等）：非结构键，无脏区
  }
  // 防御纵深：本事务删除的 children 条目对应节点加入 ⑤ 候选——覆盖「仅改数组、
  // 不同步 parentId/墓碑」的裸事务形状（与全量扫描同判：存活且父数组缺位 → 追加）。
  let malformed = false;
  Y.iterateDeletedStructs(tr, tr.deleteSet, (struct) => {
    if (malformed || !(struct instanceof Y.Item)) return;
    if (struct.parentSub !== null) return; // map 键删除（被覆盖的 parentId 等）非数组条目
    if (struct.parent === null || !('_item' in struct.parent)) return;
    const owner = ownerNodeIdOfArray(nodesRoot, struct.parent);
    if (owner === null) {
      malformed = true; // 未知数组的删除 → 全量安全阀
      return;
    }
    for (const value of struct.content.getContent()) {
      if (typeof value === 'string' && value !== '') dirty.add(value);
    }
  });
  if (malformed) return null;
  return dirty;
}

/**
 * 增量 normalize：与 normalizeTree 同一套规则（①-④ + ⑤），但 ①-④ 只施加于
 * dirtyNodeIds 中各 id 的 children 数组、⑤ 只施加于「脏 id 自身 ∪ 脏数组成员 ∪
 * 脏数组被删条目」。规划与事务纪律（单 origin 事务、追加按 id 升序、墓碑冻结）
 * 与全量完全一致；对产品流事务制造的违例，最终状态与全量扫描一致（文件头等价性依据）。
 * 返回修复次数。root 缺失（规则⑥）超出脏区表达力 → 委托全量。
 */
export function normalizeTreeFor(doc: Y.Doc, origin: string, dirtyNodeIds: Set<string>): number {
  const nodes = nodesMap(doc);
  if (nodes.get(ROOT_NODE_ID) === undefined) return normalizeTree(doc, origin); // 规则⑥ 仅全量
  let repairs = 0;

  // ── 阶段一：仅脏数组属主（规则①-④）；墓碑属主冻结（与全量一致）。
  const cleanups: ChildrenCleanup[] = [];
  const removedIds: string[] = []; // 阶段一移除的条目 id（⑤ 候选，镜像全量对全体节点的覆盖）
  const keptSets = new Map<string, Set<string>>();
  for (const ownerId of dirtyNodeIds) {
    const node = nodes.get(ownerId);
    if (node === undefined || (ownerId !== ROOT_NODE_ID && isTombstoned(node))) continue;
    const children = childrenOf(node);
    const kept = new Set<string>();
    if (children !== undefined) {
      const entries = children.toArray();
      const removeIndexes: number[] = [];
      for (let i = 0; i < entries.length; i += 1) {
        const childId = entries[i] as string;
        const child = typeof childId === 'string' ? nodes.get(childId) : undefined;
        if (typeof childId !== 'string' || child === undefined || kept.has(childId)) {
          removeIndexes.push(i);
          continue;
        }
        if (isTombstoned(child) || parentIdOf(child) !== ownerId) {
          removeIndexes.push(i);
          continue;
        }
        kept.add(childId);
      }
      if (removeIndexes.length > 0) {
        cleanups.push({ node, children, removeIndexes });
        repairs += removeIndexes.length;
        for (const idx of removeIndexes) {
          const removedId = entries[idx];
          if (typeof removedId === 'string') removedIds.push(removedId);
        }
      }
    }
    keptSets.set(ownerId, kept);
  }

  // ── 阶段二（规则⑤）：候选 = 脏 id 自身（换父/新建/数组删除侧）∪ 脏数组 kept 成员
  //    ∪ 阶段一移除条目；成员判定 Set 缓存（每父级一次），同全量的 O(1) 判定。
  const candidates = new Set<string>(dirtyNodeIds);
  for (const ownerId of dirtyNodeIds) {
    const kept = keptSets.get(ownerId);
    if (kept !== undefined) {
      for (const childId of kept) candidates.add(childId);
    }
  }
  for (const removedId of removedIds) candidates.add(removedId);
  const membershipCache = new Map<string, Set<string>>();
  const membershipOf = (parentId: string, parent: Y.Map<unknown>): Set<string> => {
    let membership = membershipCache.get(parentId);
    if (membership === undefined) {
      membership = keptSets.get(parentId) ?? new Set(childrenOf(parent)?.toArray() ?? []);
      membershipCache.set(parentId, membership);
    }
    return membership;
  };
  const appends: ChildAppend[] = [];
  for (const id of candidates) {
    if (id === ROOT_NODE_ID) continue;
    const node = nodes.get(id);
    if (node === undefined || isTombstoned(node)) continue;
    const parentId = parentIdOf(node);
    if (parentId === '' || parentId === id) continue; // 防御：无父/自环
    const parent = nodes.get(parentId);
    if (parent === undefined) continue; // 防御：父不存在（root 缺失已在入口委托全量）
    if (parentId !== ROOT_NODE_ID && isTombstoned(parent)) continue; // 冻结：不向墓碑父级追加
    if (membershipOf(parentId, parent).has(id)) continue;
    appends.push({ parentId, childId: id });
    repairs += 1;
  }
  appends.sort((a, b) => (a.childId < b.childId ? -1 : a.childId > b.childId ? 1 : 0));

  if (repairs === 0) return 0;
  doc.transact(() => {
    for (const c of cleanups) {
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
