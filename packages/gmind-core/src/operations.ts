import * as Y from 'yjs';
import { ulid } from 'ulid';
import { MAX_TEXT_LENGTH } from './constants';
import { GmindCoreError } from './errors';
import { ROOT_NODE_ID } from './doc';
import { requireAliveNode, subtreeIds } from './read';
import { normalizeTree } from './repair';
import { ORIGIN_SYSTEM, ORIGIN_USER, type WriteOrigin } from './undo';

/** 写操作来源常量定义于 undo.ts（撤销栈同源）；此处 re-export 保持既有导入路径可用。 */
export { ORIGIN_USER, ORIGIN_SYSTEM };
export type { WriteOrigin };

export interface AddChildOptions {
  /** 插入位置；缺省追加末尾，越界（负数或超过长度）clamp 到末尾。 */
  index?: number;
  /** 新节点文本；缺省 `''`（spec §4.1 默认值）。 */
  text?: string;
}

export interface WithTransactionOptions {
  /** 事务后是否执行 normalizeTree（默认 true；normalize 以 system origin 执行）。 */
  normalize?: boolean;
}

/** 统一写入口：doc.transact(fn, origin) + 事务后 normalizeTree（默认开启）。 */
export function withTransaction<T>(
  doc: Y.Doc,
  origin: WriteOrigin,
  fn: () => T,
  opts: WithTransactionOptions = {},
): T {
  const result = doc.transact(fn, origin);
  if (opts.normalize !== false) normalizeTree(doc, ORIGIN_SYSTEM);
  return result;
}

/**
 * 在 parent 下新增子节点，返回新 ULID。
 * 校验（先于 transact，拒绝即零变更）：parent 存在且存活（root 合法）；
 * text 长度 ≤ MAX_TEXT_LENGTH，否则 TEXT_TOO_LONG（与 setText 同规则，T3 评审补齐）。
 */
export function addChild(
  doc: Y.Doc,
  parentId: string,
  opts: AddChildOptions = {},
  origin: WriteOrigin = ORIGIN_USER,
): string {
  if (opts.text !== undefined && opts.text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const parent = requireAliveNode(doc, parentId);
  const id = ulid();
  withTransaction(doc, origin, () => {
    const node = new Y.Map<unknown>();
    node.set('text', opts.text ?? '');
    node.set('parentId', parentId);
    node.set('children', new Y.Array<string>());
    doc.getMap('nodes').set(id, node);

    let parentChildren = parent.get('children') as Y.Array<string> | undefined;
    if (!parentChildren) {
      parentChildren = new Y.Array<string>();
      parent.set('children', parentChildren);
    }
    const len = parentChildren.length;
    const idx =
      opts.index !== undefined && opts.index >= 0 && opts.index <= len ? opts.index : len;
    parentChildren.insert(idx, [id]);
  });
  return id;
}

/**
 * 修改节点文本。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_TEXT_LENGTH，否则 TEXT_TOO_LONG。
 */
export function setText(
  doc: Y.Doc,
  id: string,
  text: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (text.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('TEXT_TOO_LONG', '节点文本长度已达上限');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('text', text);
  });
}

/** 与 read.ts 同款类型化访问（Y.Map 泛型丢失问题）。 */
function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

/** 内部：将 nodeId 及其全部后代标记为墓碑（deleted=true），children 数组保留不动（快照可还原）。 */
function tombstoneSubtree(doc: Y.Doc, nodeId: string): void {
  const nodes = nodesMap(doc);
  for (const id of subtreeIds(doc, nodeId, true)) {
    nodes.get(id)?.set('deleted', true);
  }
}

/** 内部：从父节点的 children 数组中移除 childId（含容错：父缺失/无 children/重复项）。
 * 父节点已墓碑时不动其 children——那是保留结构（快照还原依据），如批量 [祖先, 后代] 连删。 */
function removeFromParentChildren(doc: Y.Doc, childId: string): void {
  const nodes = nodesMap(doc);
  const node = nodes.get(childId);
  if (!node) return;
  const parentId = node.get('parentId');
  if (typeof parentId !== 'string' || parentId === '') return;
  const parent = nodes.get(parentId);
  if (!parent || parent.get('deleted') === true) return;
  const children = parent.get('children') as Y.Array<string> | undefined;
  if (!children) return;
  // Y.Array 无 indexOf，借 toArray() 定位（数组极小，开销可忽略）
  for (let i = children.toArray().indexOf(childId); i !== -1; i = children.toArray().indexOf(childId)) {
    children.delete(i, 1);
  }
}

/**
 * 批量删除（墓碑级联，FR-EDT-002/003）：单事务内对每个 id 处理——
 * - id==='root'：降级为「清空 root 全部子节点」（root 存活，递归墓碑全部子孙）；
 * - 其他 id：不存在则静默忽略；否则墓碑该节点及全部后代，并从父 children 中移除该 id。
 * 后代节点的 children 数组保留不动（撤销/快照可还原）。事务后 normalize。
 */
export function deleteNodes(
  doc: Y.Doc,
  ids: string[],
  origin: WriteOrigin = ORIGIN_USER,
): void {
  withTransaction(doc, origin, () => {
    const nodes = nodesMap(doc);
    for (const id of ids) {
      if (id === ROOT_NODE_ID) {
        const root = nodes.get(ROOT_NODE_ID);
        const rootChildren = root?.get('children') as Y.Array<string> | undefined;
        if (!rootChildren) continue;
        for (const childId of rootChildren.toArray()) tombstoneSubtree(doc, childId);
        rootChildren.delete(0, rootChildren.length);
        continue;
      }
      if (!nodes.get(id)) continue; // 不存在的 id 静默忽略
      tombstoneSubtree(doc, id);
      removeFromParentChildren(doc, id);
    }
  });
}

/**
 * 移动节点（换父或同父重排，FR-EDT-003）。
 * 校验（先于 transact，拒绝即零变更）：id 非 root（ROOT_FORBIDDEN）、id 存活
 * （NODE_NOT_FOUND/NODE_DELETED）、newParent 存活；newParent 不得为 id 自身或其后代
 * （CYCLE_FORBIDDEN，subtreeIds 含自身）。同事务：从旧 parent children 移除、写 parentId、
 * 按指定 index 插入新 parent children（缺省/越界 clamp 到末尾）。
 */
export function moveNode(
  doc: Y.Doc,
  id: string,
  newParentId: string,
  index?: number,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (id === ROOT_NODE_ID) {
    throw new GmindCoreError('ROOT_FORBIDDEN', '中心主题不可移动');
  }
  const node = requireAliveNode(doc, id);
  const newParent = requireAliveNode(doc, newParentId);
  if (subtreeIds(doc, id).includes(newParentId)) {
    throw new GmindCoreError('CYCLE_FORBIDDEN', '不能移动到自身或其后代');
  }
  withTransaction(doc, origin, () => {
    removeFromParentChildren(doc, id);

    node.set('parentId', newParentId);

    let newChildren = newParent.get('children') as Y.Array<string> | undefined;
    if (!newChildren) {
      newChildren = new Y.Array<string>();
      newParent.set('children', newChildren);
    }
    const len = newChildren.length;
    const idx = index !== undefined && index >= 0 && index <= len ? index : len;
    newChildren.insert(idx, [id]);
  });
}
