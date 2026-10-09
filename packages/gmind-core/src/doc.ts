import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { StructureType } from '@gmind/shared';
import { applySideBackfill, normalizeTree, planSideBackfill } from './repair';
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
  /**
   * root 节点文本覆盖（需求方 2026-10-09 裁定「中心主题」）：仅新建空白文档的装载
   * 通道传；缺省回退 title（种子模板/测试等既有调用方行为不变）。meta.title 恒为
   * title——文件标题与中心节点文本自此解耦（改名只写 meta，不同步 root）。
   */
  rootText?: string;
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
    root.set('text', spec.rootText ?? spec.title);
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
  // 旧文档 side 回填（顺时针落位修正，需求方 2026-10-09 二次裁定）：side 特性
  //（2026-09-30）前的存量文档 root 子级无 side 键——引擎按文档序索引兜底定侧，
  // 索引随插入/重排漂移会让有效侧翻转（Enter 左下角 bug 根因）。入口处按当前
  // 索引一次性回填持久 side（回填值 = 兜底渲染值，视觉零变化），此后侧别稳定。
  // 归一先行（非法值已删键、墓碑已离列），回填在收敛后的干净状态下执行；产品流
  // 新写经 addChild 恒带 side，此处只治愈外部直入的存量状态（normalizeTree 的
  // 「干净文档零修复」契约不受影响）。
  const backfill = planSideBackfill(doc);
  if (backfill.length > 0) {
    // 单事务统一应用（无修复不开事务纪律；system origin 不进撤销栈——回填是
    // 收敛性写入而非用户编辑）。
    doc.transact(() => applySideBackfill(doc, backfill), ORIGIN_SYSTEM);
  }
  return doc;
}

export function countNodes(doc: Y.Doc): number {
  return doc.getMap('nodes').size;
}
