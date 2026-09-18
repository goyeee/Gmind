import * as Y from 'yjs';
import type { StructureType } from '@gmind/shared';
import { ROOT_NODE_ID } from './doc';
import type { IconGroup } from './constants';
import { GmindCoreError } from './errors';
// undo 是叶子模块（仅依赖 yjs），此导入不构成新环（无 cycle 风险，评审轮已核）。
import { ORIGIN_USER, type WriteOrigin } from './undo';

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

/** 内部取节点：缺失抛 NODE_NOT_FOUND，墓碑抛 NODE_DELETED。 */
export function requireAliveNode(doc: Y.Doc, id: string): Y.Map<unknown> {
  const node = nodesMap(doc).get(id);
  if (!node) throw new GmindCoreError('NODE_NOT_FOUND', '节点不存在');
  if (node.get('deleted') === true) throw new GmindCoreError('NODE_DELETED', '节点已删除');
  return node;
}
