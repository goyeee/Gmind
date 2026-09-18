import * as Y from 'yjs';
import { ulid } from 'ulid';
import {
  ICON_GROUPS,
  MAX_NOTE_LENGTH,
  MAX_TEXT_LENGTH,
  type IconGroup,
} from './constants';
import { GmindCoreError } from './errors';
import { ROOT_NODE_ID } from './doc';
import { requireAliveNode, subtreeIds, type NodeImage } from './read';
import { normalizeTree, normalizeTreeFor, deriveNormalizeDirty } from './repair';
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

/** 摊销安全网间隔：每 64 次本地写做一次全量 normalize 清扫（见 withTransaction）。 */
const SAFETY_SWEEP_INTERVAL = 64;

/**
 * 每文档写计数（模块级 WeakMap）：仅本地调度用，不进文档状态、不参与副本收敛——
 * normalize 是文档状态的纯函数，计数只决定「何时」做全量清扫，不改变收敛结果。
 */
const writeCounters = new WeakMap<Y.Doc, number>();

/** 统一写入口：doc.transact(fn, origin) + 事务后按脏区增量 normalizeTree（默认开启）。
 * 脏区由事务对象推导（deriveNormalizeDirty，replica 一致）；无法确定性识别的形状
 * （未知根类型/未知嵌套数组/root 缺失/嵌套事务）退回全量 normalizeTree 安全阀。
 * 自愈安全网（Task 9 修复轮 2）：脏区推导只覆盖「本事务制造的违例」，历史残留
 * （未走本入口的裸写等）由每 64 次写一次的全量 normalizeTree 清扫兜底——全量扫描
 * 蕴含增量修复（同一收敛结果），故第 64 写以全量替代增量而非叠加。 */
export function withTransaction<T>(
  doc: Y.Doc,
  origin: WriteOrigin,
  fn: () => T,
  opts: WithTransactionOptions = {},
): T {
  const writes = (writeCounters.get(doc) ?? 0) + 1;
  writeCounters.set(doc, writes);
  // afterTransaction 监听在事务 GC（tryGcDeleteSet）之前触发，可安全读取脏区
  // （含被覆盖键的旧值 item 链）；一次性注册，finally 注销。
  let captured: Y.Transaction | null = null;
  const capture = (tr: Y.Transaction): void => {
    captured = tr;
  };
  doc.on('afterTransaction', capture);
  let committed = false;
  let result: T;
  try {
    result = doc.transact(fn, origin);
    committed = true;
  } finally {
    doc.off('afterTransaction', capture);
  }
  // fn 抛出时（部分写入已提交）与原行为一致：跳过 normalize 向上传播。
  if (committed && opts.normalize !== false) {
    if (writes % SAFETY_SWEEP_INTERVAL === 0) {
      normalizeTree(doc, ORIGIN_SYSTEM); // 摊销全量清扫（蕴含增量）
    } else if (captured === null) {
      // 嵌套事务（外层未提交，afterTransaction 未触发）：维持原全量行为
      normalizeTree(doc, ORIGIN_SYSTEM);
    } else {
      const dirty = deriveNormalizeDirty(doc, captured);
      if (dirty === null) normalizeTree(doc, ORIGIN_SYSTEM);
      else normalizeTreeFor(doc, ORIGIN_SYSTEM, dirty);
    }
  }
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

/**
 * 设置节点备注（FR-EDT-018）。
 * 校验（先于 transact，拒绝即零变更）：存活；长度 ≤ MAX_NOTE_LENGTH，否则 NOTE_TOO_LONG。
 */
export function setNote(
  doc: Y.Doc,
  id: string,
  note: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (note.length > MAX_NOTE_LENGTH) {
    throw new GmindCoreError('NOTE_TOO_LONG', '备注长度已达上限');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('note', note);
  });
}

/**
 * 设置节点链接（FR-EDT-019）：仅允许 http/https；空串表示清除。
 * 校验（先于 transact，拒绝即零变更）：存活；/^https?:\/\//i 或空串，否则 INVALID_HREF。
 */
export function setHref(
  doc: Y.Doc,
  id: string,
  href: string,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (href !== '' && !/^https?:\/\//i.test(href)) {
    throw new GmindCoreError('INVALID_HREF', '链接仅支持 http/https');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('href', href);
  });
}

/**
 * 设置节点图片（FR-EDT-020）：{key,w,h} 写入；null 清除（读回 null，spec §4.1 缺省语义）。
 * 校验（先于 transact）：存活。
 */
export function setImage(
  doc: Y.Doc,
  id: string,
  image: NodeImage | null,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    if (image === null) node.delete('image');
    else node.set('image', image);
  });
}

/**
 * 设置节点图标（FR-EDT-021）：组内替换即覆盖；value null 删除该组。
 * icons 为节点上的 Y.Map（spec §4.1），缺失时同事务内创建（约定与 read.ts 读取侧一致）。
 * 校验（先于 transact，拒绝即零变更）：存活；group ∈ ICON_GROUPS，否则 INVALID_ICON_GROUP。
 */
export function setIcon(
  doc: Y.Doc,
  id: string,
  group: IconGroup,
  value: string | null,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  if (!ICON_GROUPS.includes(group)) {
    throw new GmindCoreError('INVALID_ICON_GROUP', '未知的图标分组');
  }
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    writeIcon(node, group, value);
  });
}

/** 内部：取节点 icons Y.Map（缺失则创建并挂到节点上，需在事务内调用）。 */
function iconsMapOf(node: Y.Map<unknown>): Y.Map<string> {
  let icons = node.get('icons') as Y.Map<string> | undefined;
  if (!icons) {
    icons = new Y.Map<string>();
    node.set('icons', icons);
  }
  return icons;
}

/** 内部：向节点 icons Y.Map 写入/删除一组图标。 */
function writeIcon(node: Y.Map<unknown>, group: IconGroup, value: string | null): void {
  const icons = iconsMapOf(node);
  if (value === null) icons.delete(group);
  else icons.set(group, value);
}

/**
 * 折叠/展开节点（FR-EDT-030）。默认 ORIGIN_SYSTEM：同步生效但不可撤销
 * （spec §4.2 第 5 条裁决——折叠状态不进撤销栈）。
 */
export function setCollapsed(
  doc: Y.Doc,
  id: string,
  collapsed: boolean,
  origin: WriteOrigin = ORIGIN_SYSTEM,
): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('collapsed', collapsed);
  });
}

/** 翻转折叠状态（默认 ORIGIN_SYSTEM，同 setCollapsed 不可撤销）。 */
export function toggleCollapse(doc: Y.Doc, id: string, origin: WriteOrigin = ORIGIN_SYSTEM): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    node.set('collapsed', node.get('collapsed') !== true);
  });
}

/** 内部：向节点 style Y.Map 应用 patch；value null 删除键；数值归一为字符串（与 NodeSnapshot.style 一致）。 */
function writeStylePatch(node: Y.Map<unknown>, patch: Record<string, string | number | null>): void {
  let style = node.get('style') as Y.Map<string> | undefined;
  if (!style) {
    style = new Y.Map<string>();
    node.set('style', style);
  }
  for (const [attr, value] of Object.entries(patch)) {
    if (value === null) style.delete(attr);
    else style.set(attr, String(value));
  }
}

/**
 * 修改节点样式（FR-EDT-030）：多键 patch；value null 删除该键。
 * 校验（先于 transact，拒绝即零变更）：存活。
 */
export function setStyle(
  doc: Y.Doc,
  id: string,
  patch: Record<string, string | number | null>,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const node = requireAliveNode(doc, id);
  withTransaction(doc, origin, () => {
    writeStylePatch(node, patch);
  });
}

/** applyStyle 作用域：'subtree' 对每个 root 的全部存活后代（含自身）；'single' 仅节点自身。 */
export type StyleScope = 'subtree' | 'single';

/**
 * 批量样式（FR-EDT-015 多选）：目标 id 在事务前收集完毕（rootIds 全部存活校验，
 * subtree 作用域经 subtreeIds 展开含自身），随后单个 withTransaction 写入全部目标——
 * 多选节点同时生效、撤销一次全部回滚。subtreeIds 跳过墓碑（对墓碑样式无意义）。
 */
export function applyStyle(
  doc: Y.Doc,
  rootIds: string[],
  patch: Record<string, string | number | null>,
  scope: StyleScope,
  origin: WriteOrigin = ORIGIN_USER,
): void {
  const targets = new Set<string>();
  for (const rootId of rootIds) {
    requireAliveNode(doc, rootId);
    if (scope === 'subtree') {
      for (const targetId of subtreeIds(doc, rootId)) targets.add(targetId);
    } else {
      targets.add(rootId);
    }
  }
  withTransaction(doc, origin, () => {
    const nodes = nodesMap(doc);
    for (const targetId of targets) {
      const node = nodes.get(targetId);
      if (!node) continue; // 防御：事务前已校验存活，正常不可达
      writeStylePatch(node, patch);
    }
  });
}
