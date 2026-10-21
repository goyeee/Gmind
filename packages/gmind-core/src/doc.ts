import * as Y from 'yjs';
import { ulid } from 'ulid';
import type { StructureType } from '@gmind/shared';
import { applySideBackfill, normalizeTree, planSideBackfill } from './repair';
import { ORIGIN_SYSTEM } from './undo';
import { LEGACY_CANVAS_ID, canvasNodesMap, canvasOrderArr, canvasesMap } from './canvas';

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

/** 旧形状判定：顶层 nodes 非空且 canvases 为空（迁移幂等的基础）。 */
export function isLegacyDocShape(doc: Y.Doc): boolean {
  return canvasesMap(doc).size === 0 && doc.getMap('nodes').size > 0;
}

/** 递归深拷贝一个已接入文档的 Y 值（Yjs 共享类型不可换父/不可多重引用——迁移必须
 *  逐键逐元素重建，否则旧壳删键 GC 后新画布引用变空壳，远端副本解码发散）。
 *  纪律：新 Y 类型未接入前只写不读，故一律自底向上构建（子值先拷好再 set/push 进
 *  父级），最外层由调用方接入文档。 */
function deepCopyValue(value: unknown): unknown {
  if (value instanceof Y.Map) {
    const m = new Y.Map<unknown>();
    value.forEach((v, k) => {
      m.set(k, deepCopyValue(v));
    });
    return m;
  }
  if (value instanceof Y.Array) {
    const arr = new Y.Array<unknown>();
    // value 是源文档已接入类型，读取合法；元素可能是标量或 Y.Map（嵌套 map 同理递归）
    arr.push(value.toArray().map(deepCopyValue));
    return arr;
  }
  return value; // 标量原样（text/parentId/side/task/icons/custom 的叶子字段…）
}

/** 深拷贝 nodes/summaries 根 Map（值为节点/概要 Map，逐节点 deepCopyValue 重建）。 */
function copyNodesDeep(src: Y.Map<unknown>, dst: Y.Map<unknown>): void {
  src.forEach((value, key) => {
    if (value instanceof Y.Map) dst.set(key, deepCopyValue(value));
  });
}

/** 旧文档 → 多画布迁移（装载通道，ORIGIN_SYSTEM；确定性：id/name 常量，structure/theme 取 meta 现值）。 */
export function migrateLegacyToCanvases(doc: Y.Doc): void {
  if (!isLegacyDocShape(doc)) return; // 幂等
  doc.transact(() => {
    const meta = doc.getMap('meta');
    const canvas = new Y.Map<unknown>();
    canvas.set('name', '画布 1');
    canvas.set('rootId', ROOT_NODE_ID);
    canvas.set('structureType', meta.get('structureType') ?? 'mindmap');
    canvas.set('themeId', meta.get('themeId') ?? 'gmind-light');
    const nodes = new Y.Map<unknown>();
    copyNodesDeep(doc.getMap('nodes'), nodes);
    canvas.set('nodes', nodes);
    const summaries = new Y.Map<unknown>();
    const legacySummaries = doc.getMap('summaries');
    // 旧文档可能没有 summaries 根类型内容——判空再拷（空壳不重建）。
    if (legacySummaries.size > 0) copyNodesDeep(legacySummaries, summaries);
    canvas.set('summaries', summaries);
    canvasesMap(doc).set(LEGACY_CANVAS_ID, canvas);
    canvasOrderArr(doc).push([LEGACY_CANVAS_ID]);
    meta.set('activeCanvasId', LEGACY_CANVAS_ID);
    // 旧根类型清空（Yjs 根类型不可删除，空壳残留无害）
    const legacyNodes = doc.getMap('nodes');
    legacyNodes.forEach((_, k) => legacyNodes.delete(k));
    legacySummaries.forEach((_, k) => legacySummaries.delete(k));
  }, ORIGIN_SYSTEM);
}

/** 按 spec §4.1 的 Y.Doc 结构构建文档（M0 仅写入用到的字段，字段名与 §4.1 严格一致）。
 *  多画布化（Task 2）：产物为新形状——单画布承载 nodes/summaries，rootId 恒 'root'
 *  （第一画布兼容纪律），画布 id 用 ulid（新建路径非迁移路径，允许 ulid）；顶层
 *  `nodes` 根类型不再写（保持不存在）。 */
export function createTemplateDoc(spec: TemplateSpec): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const meta = doc.getMap('meta');
    meta.set('title', spec.title);
    meta.set('structureType', spec.structure ?? 'mindmap');
    meta.set('themeId', spec.theme ?? 'gmind-light');

    const canvasId = ulid();
    const canvas = new Y.Map<unknown>();
    canvas.set('name', '画布 1');
    canvas.set('rootId', ROOT_NODE_ID);
    canvas.set('structureType', spec.structure ?? 'mindmap');
    canvas.set('themeId', spec.theme ?? 'gmind-light');
    const nodes = new Y.Map<unknown>();
    const root = new Y.Map();
    nodes.set(ROOT_NODE_ID, root);
    root.set('text', spec.rootText ?? spec.title);
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    for (const child of spec.children) {
      buildSubtree(nodes, rootChildren, child, ROOT_NODE_ID);
    }
    canvas.set('nodes', nodes);
    canvas.set('summaries', new Y.Map<unknown>());
    canvasesMap(doc).set(canvasId, canvas);
    canvasOrderArr(doc).push([canvasId]);
    meta.set('activeCanvasId', canvasId);
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
  // 旧形状 → 多画布迁移（多画布 Task 2）：必须在 normalizeTree 之前执行——迁移后
  // 顶层 nodes 已清空，旧规则⑥会把 top-level root 重建回来污染文档（repair 守卫
  // 见 repair.ts 前置守卫，Task 5 多画布口径接管后删除）。确定性：画布 id/name
  // 常量、structure/theme 取 meta 现值，两副本装载结果一致。
  migrateLegacyToCanvases(doc);
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

export function countNodes(doc: Y.Doc, canvasId?: string): number {
  // 多画布口径：canvasId 缺省走 resolveCanvasId 兼容层（第一画布）。
  return canvasNodesMap(doc, canvasId).size;
}
