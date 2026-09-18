import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { StructureType } from '@gmind/shared';
import { normalizeTree } from './repair';
import { ORIGIN_SYSTEM } from './undo';

// doc.test.ts 与消费方统一从 './doc' 导入全部公开 API；数据本体在 templates.ts（import type 单向依赖，无运行时环）。
export { SEED_TEMPLATES } from './templates';

/** 中心主题固定 id（spec §4.1）：不可删除、不可换父。 */
export const ROOT_NODE_ID = 'root';

export interface TemplateNodeSpec {
  text: string;
  children?: TemplateNodeSpec[];
}

export interface TemplateSpec {
  title: string;
  structure?: StructureType;
  theme?: string;
  children: TemplateNodeSpec[];
}

/** 按 spec §4.1 的 Y.Doc 结构构建文档（M0 仅写入用到的字段，字段名与 §4.1 严格一致）。 */
export function createTemplateDoc(spec: TemplateSpec): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', spec.title);
    meta.set('structureType', spec.structure ?? 'mindmap');
    meta.set('themeId', spec.theme ?? 'gmind-light');

    const nodes = doc.getMap('nodes');
    const root = new Y.Map();
    nodes.set(ROOT_NODE_ID, root);
    root.set('text', spec.title);
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    for (const child of spec.children) {
      buildSubtree(nodes, rootChildren, child, ROOT_NODE_ID);
    }
  });
  return doc;
}

function buildSubtree(
  nodes: Y.Map<unknown>,
  parentChildren: Y.Array<string>,
  spec: TemplateNodeSpec,
  parentId: string,
): void {
  const id = ulid();
  const node = new Y.Map();
  nodes.set(id, node);
  node.set('text', spec.text);
  node.set('parentId', parentId);
  const children = new Y.Array<string>();
  node.set('children', children);
  parentChildren.push([id]);
  for (const child of spec.children ?? []) {
    buildSubtree(nodes, children, child, id);
  }
}

export function docToState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  // 导入即收敛（Task 9 修复轮 2）：导入/恢复是唯一「外部状态直入」的入口，状态可能
  // 携带残缺写入的规则违例（换父败者侧、孤儿等）——入口处全量 normalize 一次，
  // 保证 docFromState 返回的文档恒满足 §4.2 全部不变量。
  normalizeTree(doc, ORIGIN_SYSTEM);
  return doc;
}

export function countNodes(doc: Y.Doc): number {
  return doc.getMap('nodes').size;
}
