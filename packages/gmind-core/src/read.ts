import * as Y from 'yjs';
import type { StructureType } from '@gmind/shared';
import { ROOT_NODE_ID } from './doc';
import { isValidDateStr, TASK_STATUSES, type IconGroup } from './constants';
import { GmindCoreError } from './errors';
// undo 是叶子模块（仅依赖 yjs），此导入不构成新环（无 cycle 风险，评审轮已核）。
import { ORIGIN_SYSTEM, ORIGIN_USER, type WriteOrigin } from './undo';

export interface DocMeta {
  title: string;
  structureType: StructureType;
  themeId: string;
}

export interface NodeImage {
  key: string;
  w: number;
  h: number;
}

/**
 * 节点任务字段（M7a-T1）：字段集与 @gmind/shared 的 DeriveTask 一致（status/progress/
 * owners/三日期），此处为 core 读取侧的归一化形状——节点无 task Y.Map 时恒读出
 * 缺省值 todo/0/[]/null×3（模板文档只写 text/parentId/children，读取侧零特判）。
 */
export interface NodeTask {
  status: (typeof TASK_STATUSES)[number];
  progress: number;
  owners: string[];
  startDate: string | null;
  dueDate: string | null;
  doneDate: string | null;
}

/** 任务字段缺省值（读取侧归一化锚点；冻结对象，调用方不得原地改）。 */
export const DEFAULT_NODE_TASK: NodeTask = {
  status: 'todo',
  progress: 0,
  owners: [],
  startDate: null,
  dueDate: null,
  doneDate: null,
};

/** spec §4.1 节点快照：缺省字段读取为默认值（M0 模板文档只写 text/parentId/children）。 */
export interface NodeSnapshot {
  id: string;
  text: string;
  parentId: string;
  childIds: string[];
  note: string;
  href: string;
  image: NodeImage | null;
  icons: Partial<Record<IconGroup, string>>;
  /** 任务字段（M7a-T1）：恒为归一化对象（缺省 todo/0/[]/null×3），防御读取远端坏数据。 */
  task: NodeTask;
  style: Record<string, string>;
  collapsed: boolean;
  deleted: boolean;
}

function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function getMeta(doc: Y.Doc): DocMeta {
  const meta = doc.getMap('meta');
  return {
    title: asString(meta.get('title')),
    structureType: (meta.get('structureType') as StructureType | undefined) ?? 'mindmap',
    themeId: asString(meta.get('themeId'), 'gmind-light'),
  };
}

/** 仅写入提供的键；默认 user origin（改名/结构切换可撤销，FR-EDT-012）。 */
export function setDocMeta(doc: Y.Doc, patch: Partial<DocMeta>, origin: WriteOrigin = ORIGIN_USER): void {
  doc.transact(() => {
    const meta = doc.getMap('meta');
    if (patch.title !== undefined) meta.set('title', patch.title);
    if (patch.structureType !== undefined) meta.set('structureType', patch.structureType);
    if (patch.themeId !== undefined) meta.set('themeId', patch.themeId);
  }, origin);
}

/** 最后修改人标记（M3a Task 4，FR-FIL-001）：写在 meta.lastEditorUserId，随协同同步
 *  / PUT 落库由服务端回写 files.last_modifier_user_id。默认 system origin——
 *  「谁改过」是文档事实而非用户编辑，不进撤销栈（Ctrl+Z 不回滚该标记）。 */
export function markLastEditor(doc: Y.Doc, userId: string, origin: WriteOrigin = ORIGIN_SYSTEM): void {
  doc.transact(() => {
    doc.getMap('meta').set('lastEditorUserId', userId);
  }, origin);
}

/** 读回最后修改人；未标记 / 空串 / 非字符串（远端坏数据）一律 null。 */
export function getLastEditor(doc: Y.Doc): string | null {
  const v = doc.getMap('meta').get('lastEditorUserId');
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 读取侧任务归一化：形状不符/远端坏数据按缺省处理，绝不抛错（镜像本文件防御风格）。
 *  progress 钳到 0-100 并取整、owners 只收字符串、日期须日历合法的 'YYYY-MM-DD'
 *  （isValidDateStr 与 setNodeTask 写入校验同口径），保证快照恒为合法值。 */
function readTask(raw: unknown): NodeTask {
  if (!(raw instanceof Y.Map)) return { ...DEFAULT_NODE_TASK, owners: [] };
  const status = raw.get('status');
  const progress = raw.get('progress');
  const owners = raw.get('owners');
  const asDate = (v: unknown): string | null =>
    typeof v === 'string' && isValidDateStr(v) ? v : null;
  const p = typeof progress === 'number' && Number.isFinite(progress) ? progress : 0;
  return {
    status: (TASK_STATUSES as readonly string[]).includes(status as string)
      ? (status as NodeTask['status'])
      : 'todo',
    progress: Math.min(100, Math.max(0, Math.round(p))),
    owners: Array.isArray(owners) ? owners.filter((v): v is string => typeof v === 'string') : [],
    startDate: asDate(raw.get('startDate')),
    dueDate: asDate(raw.get('dueDate')),
    doneDate: asDate(raw.get('doneDate')),
  };
}

export function getNode(doc: Y.Doc, id: string): NodeSnapshot | null {
  const node = nodesMap(doc).get(id);
  if (!node) return null;
  const children = node.get('children') as Y.Array<string> | undefined;
  const icons = node.get('icons') as Y.Map<string> | undefined;
  const style = node.get('style') as Y.Map<string> | undefined;
  const image = node.get('image') as NodeImage | undefined;
  return {
    id,
    text: asString(node.get('text')),
    parentId: asString(node.get('parentId')),
    childIds: children ? children.toArray() : [],
    note: asString(node.get('note')),
    href: asString(node.get('href')),
    image: image ?? null,
    icons: icons ? Object.fromEntries(icons.entries()) : {},
    task: readTask(node.get('task')),
    style: style ? Object.fromEntries(style.entries()) : {},
    collapsed: node.get('collapsed') === true,
    deleted: node.get('deleted') === true,
  };
}

export function childrenIds(doc: Y.Doc, id: string): string[] {
  return getNode(doc, id)?.childIds ?? [];
}

export function isAlive(doc: Y.Doc, id: string): boolean {
  const node = nodesMap(doc).get(id);
  return node !== undefined && node.get('deleted') !== true;
}

/** 先序遍历（含自身）；includeDeleted=false 时跳过墓碑子树。
 * visited 集合防御 children/parentId 环（并发换父交换合并或 crafted doc_state 可产生
 * 2 节点环）：已访问 id 直接跳过，保证任意形状下终止——环的最终治理由全量扫描的
 * 断环规则负责（repair.ts normalizeTree），遍历层只保证不挂起。 */
export function subtreeIds(doc: Y.Doc, id: string, includeDeleted = false): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (nodeId: string): void => {
    if (visited.has(nodeId)) return; // 环防御：跳过已访问
    visited.add(nodeId);
    const node = nodesMap(doc).get(nodeId);
    if (!node) return;
    const deleted = node.get('deleted') === true;
    if (deleted && !includeDeleted) return;
    out.push(nodeId);
    const children = node.get('children') as Y.Array<string> | undefined;
    if (children) for (const childId of children) walk(childId);
  };
  walk(id);
  return out;
}

/** 向根回溯；visited 集合防御 parentId 环（同 subtreeIds），成环时止于重复节点前。 */
export function pathToRoot(doc: Y.Doc, id: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  let cur: string | undefined = id;
  while (cur !== undefined && cur !== '' && !visited.has(cur)) {
    visited.add(cur);
    out.push(cur);
    const node = nodesMap(doc).get(cur);
    if (!node) break;
    cur = asString(node.get('parentId')) || undefined;
  }
  return out;
}

/** 存活节点数（不含中心主题）。 */
export function countAlive(doc: Y.Doc): number {
  let n = 0;
  for (const [id, node] of nodesMap(doc).entries()) {
    if (id !== ROOT_NODE_ID && node.get('deleted') !== true) n += 1;
  }
  return n;
}

/** 配额口径（FR-ACC-003「文档节点数 ≤500」＝活跃文档规模）：自 root 沿 children
 * 可达的存活节点数（不含 root）。与 countAlive/countNodes 的差异：
 * - 墓碑（deleted=true，永不清除、随编辑累积）不计入——否则长期编辑的正常文档会
 *   被 countNodes 的墓碑余额推过上限，永久无法保存（M1 验收修复轮裁决）；
 * - 自 root 不可达的孤儿（parentId 指向缺失/墓碑/为空，normalize 确定性跳过）不计入；
 * docFromState 已在入口全量 normalize，可达集合即「有意义的活跃规模」。
 * visited 集合防御 children 侧环（同 subtreeIds，并发换父交换合并或 crafted state
 * 可产生），保证任意形状下终止。 */
export function countAliveReachable(doc: Y.Doc): number {
  const root = nodesMap(doc).get(ROOT_NODE_ID);
  if (!root || root.get('deleted') === true) return 0;
  const children = root.get('children') as Y.Array<string> | undefined;
  if (!children) return 0;
  let n = 0;
  const visited = new Set<string>([ROOT_NODE_ID]);
  const stack: string[] = [...children.toArray()];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue; // 环防御：跳过已访问
    visited.add(id);
    const node = nodesMap(doc).get(id);
    if (!node || node.get('deleted') === true) continue; // 墓碑子树整枝剪除
    n += 1;
    const next = node.get('children') as Y.Array<string> | undefined;
    if (next) stack.push(...next.toArray());
  }
  return n;
}

/** 折叠处数（M4 Task 9，FR-IO-003 导出折叠提示口径）：自 root 可达的存活节点中
 * collapsed=true 且 childIds.length>0 的个数。可达口径与 countAliveReachable 一致——
 * 提示的 N 必须等于导出实际展开的处数（cloneExpanded 只展开可达集）；childIds 为空
 * 的「空折叠」不产生视觉折叠态，不计。visited 集合防御 children 侧环（同上）。 */
export function countCollapsedWithChildren(doc: Y.Doc): number {
  const root = nodesMap(doc).get(ROOT_NODE_ID);
  if (!root || root.get('deleted') === true) return 0;
  let n = 0;
  const visited = new Set<string>();
  const stack: string[] = [ROOT_NODE_ID];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (visited.has(id)) continue; // 环防御：跳过已访问
    visited.add(id);
    const node = nodesMap(doc).get(id);
    if (!node || node.get('deleted') === true) continue; // 墓碑子树整枝剪除
    const children = node.get('children') as Y.Array<string> | undefined;
    const childIds = children ? children.toArray() : [];
    if (node.get('collapsed') === true && childIds.length > 0) n += 1;
    stack.push(...childIds);
  }
  return n;
}

/** 内部取节点：缺失抛 NODE_NOT_FOUND，墓碑抛 NODE_DELETED。 */
export function requireAliveNode(doc: Y.Doc, id: string): Y.Map<unknown> {
  const node = nodesMap(doc).get(id);
  if (!node) throw new GmindCoreError('NODE_NOT_FOUND', '节点不存在');
  if (node.get('deleted') === true) throw new GmindCoreError('NODE_DELETED', '节点已删除');
  return node;
}
