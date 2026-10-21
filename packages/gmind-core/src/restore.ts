import * as Y from 'yjs';
import {
  ICON_GROUPS,
  MARKER_GROUP_MODE,
  MARKER_MULTI_MAX,
  iconValuesOf,
  type IconGroup,
} from './constants';
import { ROOT_NODE_ID } from './doc';
import { canvasesMap, canvasOrderArr } from './canvas';
import {
  addChild,
  deleteNodes,
  moveNode,
  setCollapsed,
  setHref,
  setImage,
  setIcon,
  setNodeTask,
  setNote,
  setStyle,
  setText,
  withTransaction,
  type WriteOrigin,
} from './operations';
import { getNode, type NodeSnapshot } from './read';

/** 恢复写来源（M4 Task 7，FR-VER-004）：撤销栈仅跟踪 ORIGIN_USER（undo.ts），
 *  restore 事务整体不进任何客户端的撤销栈——恢复是文档级事实修正，Ctrl+Z 不回滚。 */
export const ORIGIN_RESTORE: WriteOrigin = 'restore';

/** 恢复结果计数（计划 op 口径，事务内执行时累加；**节点 op 口径**——画布级操作
 * （画布置墓碑/整画布重建/画布名与结构主题回滚）是文档级事实修正，不计入下列四元组，
 * 见 restoreFromSnapshot 头注「画布集合回滚」）：
 * - deleted：顶层删除 op 数（父同被删的深层随子树整枝，不逐节点计）；
 * - created：重建节点数（快照存活而当前墓碑/缺失的节点以新 ULID 重建，Yjs 墓碑永久）；
 * - moved：实际执行的 moveNode 数（落位检查通过者不计）；
 * - updated：内容字段（④ 全字段）有写入的交集节点数；重建节点的字段回填计入 created，
 *   不计 updated。 */
export interface RestoreResult {
  deleted: number;
  created: number;
  moved: number;
  updated: number;
}

/** 画布集合口径：并集迭代用的画布只读视图（规划期零写入）。 */
interface CanvasView {
  canvasId: string;
  /** 画布 Y.Map（源 doc 内）；undefined = 该 doc 无此画布（含畸形值按缺失——
   *  crafted doc_state 防御，对齐 repair 规则⑩ 的畸形值按墓碑口径）。 */
  canvas: Y.Map<unknown> | undefined;
  /** 存活 = Y.Map 且 deleted !== true。 */
  alive: boolean;
  rootId: string;
}

/** 单画布节点恢复计划（画布内「可达集先序 diff」逻辑①-④的参数化产物；
 *  快照视图 snapById/sAlive 随计划携带，执行期不再回读 snapshot）。 */
interface CanvasNodePlan {
  canvasId: string;
  rootId: string;
  /** 快照存活节点先序集 + 快照视图（id → NodeSnapshot）。 */
  sAlive: string[];
  snapById: Map<string, NodeSnapshot>;
  /** 快照 id → target id 映射：交集节点预映射自身；重建者在 ② 执行期回填。 */
  idMap: Map<string, string>;
  deleteIds: string[];
  createSnapIds: string[];
  places: Array<{ snapId: string; snapIndex: number }>;
  fieldDiffs: Array<{ snapId: string; snap: NodeSnapshot }>;
  /** 零操作短路门（事务前状态判定；执行期 ③ 以现场状态复核）。 */
  moveNeeded: boolean;
}

/** 画布集合回滚计划（多画布 Task 6）：集合级操作（画布置墓碑/整画布重建/画布元数据）。 */
interface CanvasSetPlan {
  /** target 存活而 snapshot 无（缺失/墓碑/畸形）→ 置墓碑 deleted=true＋移出 order。 */
  tombstones: string[];
  /** snapshot 存活而 target 缺失/墓碑/畸形/rootId 不配 → 整画布深拷贝重建＋补入 order。
   *  copy 为规划期建好的深拷贝（未接入 target，事务内 set 接入）。 */
  rebuilds: Array<{ canvasId: string; copy: Y.Map<unknown> }>;
  /** 配对画布（id 相同、双存活、rootId 相同）的 name/structureType/themeId 回滚。 */
  metaPatches: Array<{ canvas: Y.Map<unknown>; patch: CanvasMetaPatch }>;
}

/** 画布级元数据 diff 补丁（对齐 meta⑤ 先例：title 恒排除的推广——画布级无 title）。 */
interface CanvasMetaPatch {
  name?: string;
  structureType?: string;
  themeId?: string;
}

/**
 * 将 target 就地恢复为 snapshot 的内容（结构 op-diff，单事务，ORIGIN_RESTORE）。
 * 前置：两 doc 均为已 normalize（= 已迁移多画布形状）的本项目文档——装载通道
 * docFromState 恒保证；旧形状窗口（顶层 nodes）不在恢复受理面（画布并集为空 →
 * 零操作，如实登记）。快照中存活而当前墓碑的节点以新 ULID 重建。
 *
 * ── 画布集合回滚（多画布 Task 6）────────────────────────────────────────
 * 画布集合并集按 canvasId 对齐（id 相同才配对——画布增删随快照回滚）：
 * - snapshot 存活、target 缺失/墓碑/畸形/rootId 不配 → **整画布深拷贝重建**
 *   （doc.ts deepCopyValue 先例：Yjs 共享类型不可换父，逐键自底向上重建）＋补入
 *   order 末尾；rootId 不配（同 id 不同根，crafted 边角）同属重建分支——逐画布
 *   节点 diff 以配对根为前提，根不配时整画布回滚是唯一收敛口径。
 * - target 存活、snapshot 无 → 画布置墓碑 deleted=true＋移出 order（对齐
 *   deleteCanvas 冻结口径：nodes/summaries 内容不动，作还原依据保留）；
 * - 双存活且 rootId 相同 → 画布内复用既有「可达集先序 diff」逻辑（根取画布
 *   rootId），画布的 name/structureType/themeId 纳入 diff（对齐 meta⑤ 先例）。
 * 画布序**位置**不做 diff（计划未列；repair 规则⑩ 保证集合与序的最低收敛）。
 * 上述画布级 op 是 core 内部文档级修正：直接写 canvases/canvasOrder 根类型（与
 * repair 规则⑩ 的 apply 同先例）；公开画布管理 op（addCanvas/deleteCanvas）在
 * Task 7 落地，届时可换回公开 op。画布级 op 不计入 RestoreResult 四元组。
 *
 * ── 画布内算法（binding，plan 全部在事务外算好——校验先于事务纪律）────────
 * ① 删除：target 存活而快照无。只删「顶层」= 删除对象中父级不是删除对象者（删除对象
 *   集合内父被删的深层随 deleteNodes 的整枝墓碑走，不重复落 op）——交集外的多余子树
 *   （父在快照中存活）正是靠本条移除。deleteNodes 墓碑整棵子树并从父 children 摘除。
 * ② 重建：快照存活而 target 缺失或墓碑者，按快照先序（父先于子）addChild 以新 ULID
 *   重建（旧 id 的 Yjs 墓碑永久保留——旧 id 上的评论锚点降级为「原节点已删除」，产品
 *   裁定），插入位置 = 快照同层下标（前序兄弟此时全部在位，index 恒不越界）。
 * ③ 落位：快照存活节点（交集 + 刚重建者）按快照先序逐一核对当前父映射与同层位置，
 *   不符才 moveNode(id, mappedParent, snapIndex)（父不同/位置不同）。快照先序保证
 *   处理到某节点时其前序兄弟已就位：moveNode 的 remove+insert 不触碰 < index 的位置
 *   （调用点当前位 ≥ index），先换父的祖先也已先移出后代子树（无 CYCLE_FORBIDDEN）。
 *   重建节点纳入落位核对（②已按快照下标插入，正常零操作）——防御 ②③ 交错移位的
 *   边角，保证收敛是构造性的而非论证性的。
 * ④ 内容字段逐项对比（getNode 的 NodeSnapshot 全字段）：text/note/href/collapsed 直接
 *   比；icons（M7b-W1 多值）按 ICON_GROUPS 全组数组对比——single 组 setIcon(值|null)、
 *   multi 组清组后逐枚 toggle 追加（等价整组覆写）；**快照组值为值域外旧标记——repair
 *   有意保留、setIcon 目录校验拒绝——时计划期（事务外）按 canonicalSnapIcons 目录过滤，
 *   组内全为值外值即跳过恢复该标记：不回写快照值、也不清除 target 现状，与 engine
 *   剪贴板 isWritableIcon 同策略**；task（M7a-T1）
 *   六字段逐项对比（全字段显式 patch 写回，doneDate 恒显式给值含 null →
 *   applyStatusRules 联动分支不触发，恢复结果即快照原值）；
 *   image 按 key 对比（key 变更时 w/h 随快照值一并写回）；style 按键集对比
 *   （补/改/删键，value null 删）。重建节点的字段回填 = addChild 后立即走同一 diff
 *   例程（新节点必全量不同）。
 * ⑤ 元数据：画布的 name/structureType/themeId 按画布 diff（见「画布集合回滚」）；
 *   meta.title 恒排除——meta.title 镜像的是工作区文件名（useEditorDoc.setTitle 同步
 *   meta 与 PATCH /files），版本恢复是文档内容回滚，若回写快照 title 会把用户在快照
 *   之后的改名一并吃掉，且 files.title 行值不随之变更（画布与列表名号劈叉）——
 *   恢复不改名，title 恒保留 target 现值。
 *
 * ── 概要（summaries）×恢复口径（裁定 6 钉死，2026-10-21，引
 *   docs/superpowers/specs/2026-10-21-multi-canvas-ruling.md §一.6＝m6-acceptance
 *   待裁定项 3 选项 B）── 恢复 diff 范围＝nodes＋画布级元数据（title 排除先例见⑤）；
 *   **summaries 不在恢复范围**——恢复不回滚概要集、快照概要也不随版本重生。恢复后
 *   概要保持 target 现状，经 repair 的概要收敛（repair.ts 规则⑦ planSummaryRepair）
 *   按**存活片段**自愈：成员被①删除/换父断裂即收敛存活子段，全失效即删概要
 *   （summary.ts 三态）；②重建节点为新 ULID，不在任何既有概要的 nodeIds 内，不复活
 *   旧概要。此口径已了结 M6 验收「待裁定项 3」（裁定记录 §一.6）。
 *
 * ── 零操作短路 ── diff 为空（无删/无建/无字段差/无画布级 op/无落位需求）直接返回
 * 全零，不开事务。落位需求按事务前状态判定——其余几类全空时事务前后状态一致，判定
 * 精确；任一非空则必然开事务，该判定仅作短路门，不影响执行路径（③执行期以现场状
 * 态复核）。
 */
export function restoreFromSnapshot(target: Y.Doc, snapshot: Y.Doc): RestoreResult {
  // ——全部读取与 diff 计算在事务外（校验先于事务纪律）——
  const tCanvases = canvasesMap(target);
  const sCanvases = canvasesMap(snapshot);

  /** 源 doc 画布只读视图。 */
  const viewOf = (canvases: Y.Map<Y.Map<unknown>>, canvasId: string): CanvasView => {
    const canvas = canvases.get(canvasId);
    if (!(canvas instanceof Y.Map)) {
      return { canvasId, canvas: undefined, alive: false, rootId: ROOT_NODE_ID };
    }
    const rootId = canvas.get('rootId');
    return {
      canvasId,
      canvas: canvas as Y.Map<unknown>,
      alive: canvas.get('deleted') !== true,
      rootId: typeof rootId === 'string' && rootId !== '' ? rootId : ROOT_NODE_ID,
    };
  };

  // 画布集合并集（按 canvasId 升序——Y.Map 迭代序是本地插入序，非 CRDT 收敛状态，
  // 不可依赖；对齐 repair.ts repairScopes 的排序纪律）。
  const unionIds = [...new Set([...tCanvases.keys(), ...sCanvases.keys()])].sort();

  const canvasSetPlan: CanvasSetPlan = { tombstones: [], rebuilds: [], metaPatches: [] };
  const nodePlans: CanvasNodePlan[] = [];

  for (const canvasId of unionIds) {
    const t = viewOf(tCanvases, canvasId);
    const s = viewOf(sCanvases, canvasId);
    if (s.alive && s.canvas !== undefined) {
      if (t.alive && t.canvas !== undefined && t.rootId === s.rootId) {
        // 双存活配对（rootId 同）：画布内可达集先序 diff + 画布级元数据 diff。
        nodePlans.push(planCanvasNodeDiff(target, snapshot, canvasId, s.rootId));
        const patch = canvasMetaDiff(t.canvas, s.canvas);
        if (Object.keys(patch).length > 0) canvasSetPlan.metaPatches.push({ canvas: t.canvas, patch });
      } else {
        // target 缺失/墓碑/畸形/rootId 不配 → 整画布深拷贝重建（副本规划期建好，
        // 事务内 set 接入——deepCopyValue 先例：新 Y 类型未接入前只写不读）。
        canvasSetPlan.rebuilds.push({ canvasId, copy: deepCopyValue(s.canvas) as Y.Map<unknown> });
      }
    } else if (t.alive && t.canvas !== undefined) {
      // snapshot 无（缺失/墓碑/畸形）而 target 存活 → 画布置墓碑＋移出 order。
      canvasSetPlan.tombstones.push(canvasId);
    }
    // 双无 / 双墓碑：零操作（冻结内容已是还原终态，如实不动）。
  }

  // 零操作短路：画布级 op 与全部画布节点 op 皆空 → 全零，不开事务。
  if (
    canvasSetPlan.tombstones.length === 0 &&
    canvasSetPlan.rebuilds.length === 0 &&
    canvasSetPlan.metaPatches.length === 0 &&
    nodePlans.every(
      (p) =>
        p.deleteIds.length === 0 &&
        p.createSnapIds.length === 0 &&
        p.fieldDiffs.length === 0 &&
        !p.moveNeeded,
    )
  ) {
    return { deleted: 0, created: 0, moved: 0, updated: 0 };
  }

  return withTransaction(target, ORIGIN_RESTORE, () => {
    const result: RestoreResult = { deleted: 0, created: 0, moved: 0, updated: 0 };
    // ── 画布集合回滚（先集合后节点：重建/墓碑的画布不在节点 diff 集合内，两不相交）
    const order = canvasOrderArr(target);
    for (const canvasId of canvasSetPlan.tombstones) {
      tCanvases.get(canvasId)?.set('deleted', true);
      for (let i = order.toArray().indexOf(canvasId); i !== -1; i = order.toArray().indexOf(canvasId)) {
        order.delete(i, 1); // 重复项一并移除（对齐规则⑩去重口径）
      }
    }
    for (const rb of canvasSetPlan.rebuilds) {
      tCanvases.set(rb.canvasId, rb.copy);
      if (!order.toArray().includes(rb.canvasId)) order.push([rb.canvasId]); // 补末尾（位置不做 diff）
    }
    for (const mp of canvasSetPlan.metaPatches) {
      if (mp.patch.name !== undefined) mp.canvas.set('name', mp.patch.name);
      if (mp.patch.structureType !== undefined) mp.canvas.set('structureType', mp.patch.structureType);
      if (mp.patch.themeId !== undefined) mp.canvas.set('themeId', mp.patch.themeId);
    }
    // ── 逐画布节点 diff（①-④；op 经 core 写 API，canvasId 作用域）
    for (const plan of nodePlans) {
      applyCanvasNodeDiff(target, plan, result);
    }
    return result;
  });
}

/** 单画布「可达集先序 diff」计划（①-④ + 落位门；全部在事务外算好）。 */
function planCanvasNodeDiff(
  target: Y.Doc,
  snapshot: Y.Doc,
  canvasId: string,
  rootId: string,
): CanvasNodePlan {
  const tAlive = reachableAliveIds(target, canvasId, rootId); // 根先序遍历 childIds（visited 防环）
  const sAlive = reachableAliveIds(snapshot, canvasId, rootId);
  const tAliveSet = new Set(tAlive);
  const snapById = new Map<string, NodeSnapshot>();
  for (const id of sAlive) snapById.set(id, getNode(snapshot, id, canvasId)!);
  // parent 映射表：快照 id → target id。交集节点（存活于双方）映射自身；重建节点在
  // ② 执行期以 addChild 返回的新 id 回填——因此 ③ 的 mappedParent 统一执行期解析。
  const idMap = new Map<string, string>();
  for (const id of sAlive) {
    if (tAliveSet.has(id)) idMap.set(id, id);
  }
  const mappedParentOf = (snapId: string): string | undefined =>
    snapById.get(snapId)!.parentId === rootId ? rootId : idMap.get(snapById.get(snapId)!.parentId);

  // ① 删除计划：删除对象 = target 存活（可达口径）而快照无、非根；顶层 = 父不在
  //   删除对象集合（父也删 → 随子树整枝，不重复计）。
  const deleteCandidates = tAlive.filter((id) => id !== rootId && !snapById.has(id));
  const deleting = new Set(deleteCandidates);
  const deleteIds = deleteCandidates.filter(
    (id) => !deleting.has(getNode(target, id, canvasId)!.parentId),
  );

  // ② 重建计划：快照先序（sAlive 即先序），父必已映射（先序 + 交集预映射）。
  const createSnapIds = sAlive.filter((id) => !idMap.has(id));

  // ③ 落位计划：快照存活节点按先序逐一登记（交集 + 重建者）；mappedParent/snapIndex
  //   执行期解析（重建父的事务内 id 事务前未知）。
  const places = sAlive
    .filter((id) => id !== rootId)
    .map((id) => ({ snapId: id, snapIndex: snapIndexInSnapshot(snapById, id) }));

  // ④ 字段 diff 计划（交集，根的中心主题文本等字段同为文档内容、一并参与）：
  //   重建者的回填在 ② 执行期走同一例程，不入本表。
  const fieldDiffs = sAlive
    .filter((id) => idMap.has(id))
    .map((id) => ({ snapId: id, snap: snapById.get(id)! }))
    .filter(({ snapId, snap }) => hasFieldDiff(getNode(target, snapId, canvasId)!, snap));

  // 落位需求的零操作门（事务前状态判定；精确性论证见 restoreFromSnapshot 头注）。
  const moveNeeded = sAlive.some((id) => {
    if (id === rootId || !idMap.has(id)) return false; // 重建者必伴随 ②，门已开
    const mappedParent = mappedParentOf(id);
    if (mappedParent === undefined) return true; // 父为重建节点：必落位
    const t = getNode(target, id, canvasId)!;
    if (t.parentId !== mappedParent) return true;
    return (getNode(target, mappedParent, canvasId)?.childIds.indexOf(id) ?? -1) !== snapIndexInSnapshot(snapById, id);
  });

  return { canvasId, rootId, sAlive, snapById, idMap, deleteIds, createSnapIds, places, fieldDiffs, moveNeeded };
}

/** 单画布节点 diff 执行（①-④；必须在恢复事务内执行，op 经 core 写 API）。 */
function applyCanvasNodeDiff(target: Y.Doc, plan: CanvasNodePlan, result: RestoreResult): void {
  const { canvasId, rootId, snapById, idMap } = plan;
  const mappedParentOf = (snapId: string): string | undefined =>
    snapById.get(snapId)!.parentId === rootId ? rootId : idMap.get(snapById.get(snapId)!.parentId);
  // ① 删除：一次批量（deleteNodes 单事务语义，墓碑整枝 + 摘除父 children）
  if (plan.deleteIds.length > 0) {
    deleteNodes(target, plan.deleteIds, ORIGIN_RESTORE, canvasId);
    result.deleted += plan.deleteIds.length;
  }
  // ② 重建（快照先序；父先于子 → mappedParent 必已就绪）：addChild 落位快照下标，
  //    字段回填走 ④ 同一 diff 例程（计入 created，不计 updated）。
  for (const snapId of plan.createSnapIds) {
    const snap = snapById.get(snapId)!;
    const mappedParent = mappedParentOf(snapId);
    if (mappedParent === undefined) {
      throw new Error(`restore: parent of ${snapId} not resolvable (plan broken)`);
    }
    const newId = addChild(
      target,
      mappedParent,
      { text: snap.text, index: snapIndexInSnapshot(snapById, snapId) },
      ORIGIN_RESTORE,
      canvasId,
    );
    idMap.set(snapId, newId);
    applyFieldDiff(target, newId, snap, canvasId);
    result.created += 1;
  }
  // ③ 落位（快照先序；现场复核父映射与同层位置，不符才 moveNode）
  for (const place of plan.places) {
    const id = idMap.get(place.snapId)!;
    const mappedParent = mappedParentOf(place.snapId);
    if (mappedParent === undefined) {
      throw new Error(`restore: parent of ${place.snapId} not resolvable (plan broken)`);
    }
    const t = getNode(target, id, canvasId)!;
    if (
      t.parentId === mappedParent &&
      getNode(target, mappedParent, canvasId)?.childIds.indexOf(id) === place.snapIndex
    ) {
      continue; // 已在位（重建节点常态）：零写入
    }
    moveNode(target, id, mappedParent, place.snapIndex, ORIGIN_RESTORE, canvasId);
    result.moved += 1;
  }
  // ④ 内容字段（交集，事务前 diff 就位的节点逐个执行）
  for (const diff of plan.fieldDiffs) {
    if (applyFieldDiff(target, diff.snapId, diff.snap, canvasId)) result.updated += 1;
  }
}

// ── 文件内私有 helper ────────────────────────────────────────────────────────

/**
 * 递归深拷贝一个已接入文档的 Y 值（doc.ts deepCopyValue 先例：Yjs 共享类型不可
 * 换父/不可多重引用——必须逐键逐元素重建；新 Y 类型未接入前只写不读，故一律自底
 * 向上构建，最外层由调用方接入文档）。
 */
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
  return value; // 标量原样（name/rootId/structureType/themeId/text/parentId…）
}

/** 画布级元数据 diff（对齐 meta⑤ 先例）：name/structureType/themeId 按画布对比，
 *  读取侧规范化口径（listCanvases 同款回退：name『画布』/structureType『mindmap』/
 *  themeId『gmind-light』）——快照侧为已 normalize 文档，规范化值即回滚目标值。 */
function canvasMetaDiff(t: Y.Map<unknown>, s: Y.Map<unknown>): CanvasMetaPatch {
  const patch: CanvasMetaPatch = {};
  const nameOf = (c: Y.Map<unknown>): string => {
    const v = c.get('name');
    return typeof v === 'string' && v !== '' ? v : '画布';
  };
  const structureOf = (c: Y.Map<unknown>): string => {
    const v = c.get('structureType');
    return typeof v === 'string' && v !== '' ? v : 'mindmap';
  };
  const themeOf = (c: Y.Map<unknown>): string => {
    const v = c.get('themeId');
    return typeof v === 'string' && v !== '' ? v : 'gmind-light';
  };
  if (nameOf(t) !== nameOf(s)) patch.name = nameOf(s);
  if (structureOf(t) !== structureOf(s)) patch.structureType = structureOf(s);
  if (themeOf(t) !== themeOf(s)) patch.themeId = themeOf(s);
  return patch;
}

/** 根先序遍历 childIds 收集存活节点（visited 防环，口径同 countAliveReachable：
 *  只走 children、跳过墓碑；normalize 前置保证 parentId/children 一致）。
 *  多画布（Task 6）：自该画布 rootId 起算，节点读画布子图。 */
function reachableAliveIds(doc: Y.Doc, canvasId: string, rootId: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return; // 环防御：跳过已访问
    visited.add(id);
    const node = getNode(doc, id, canvasId);
    if (node === null || node.deleted) return;
    out.push(id);
    for (const childId of node.childIds) walk(childId);
  };
  walk(rootId);
  return out;
}

/** 节点在快照父 children 中的下标（normalize 前置保证 parentId 指回该父，找不到为 -1 的
 *  情形仅存在于畸形输入，届时 addChild/moveNode 的钳制语义兜底为 append）。 */
function snapIndexInSnapshot(snapById: Map<string, NodeSnapshot>, id: string): number {
  const snap = snapById.get(id)!;
  return snap.parentId === ROOT_NODE_ID
    ? (snapById.get(ROOT_NODE_ID)?.childIds.indexOf(id) ?? -1)
    : (snapById.get(snap.parentId)?.childIds.indexOf(id) ?? -1);
}

/** ④ 内容字段是否存在差异（计划期判定 + 执行期复用同一判定写入）。
 *  icons（M7b-W1 多值）：快照组值先经 canonicalSnapIcons 规范化（目录校验/去重/
 *  上限，emoji 组目录外字符保留）；快照组非空但规范化后为空（值域外旧标记——repair
 *  有意保留、setIcon 目录校验拒绝）时该组整体跳过（不写不清，恒视为无差异——见头注④）；
 *  task（M7a-T1）按归一化快照逐字段对比；恢复走全字段 patch（doneDate 恒显式给值含
 *  null，applyStatusRules 联动分支不触发——见 applyFieldDiff 注）。 */
function hasFieldDiff(t: NodeSnapshot, s: NodeSnapshot): boolean {
  return (
    t.text !== s.text ||
    t.note !== s.note ||
    t.href !== s.href ||
    t.collapsed !== s.collapsed ||
    diffImage(t.image, s.image) ||
    Object.keys(stylePatchOf(t.style, s.style)).length > 0 ||
    ICON_GROUPS.some((group) => iconGroupDiffers(group, t.icons[group], s.icons[group])) ||
    hasTaskDiff(t.task, s.task)
  );
}

/**
 * 快照组值的恢复口径规范化（M7b-W1）：目录校验（所有组严格——写入口 setIcon 的
 * 目录口径；repair 对旧 emoji 的「原样保留」只作用于存量文档，不构成可写值域）+
 * 去重保序 + multi 上限钳制。返回规范化数组（可能为空）。
 */
function canonicalSnapIcons(group: IconGroup, values: string[] | undefined): string[] {
  if (!values) return [];
  const catalog = iconValuesOf(group);
  const out: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string' || v === '' || !catalog.includes(v)) continue;
    if (!out.includes(v)) out.push(v);
    if (out.length >= MARKER_MULTI_MAX) break;
  }
  return out;
}

/** 组图标差异（B1，M7b-W1 数组版）：快照组非空而规范化后为空（值域外旧标记）时
 *  返回 false（跳过该组）；快照组缺失仍正常比对——target 多出的目录内值要清掉
 *  （恢复 = 回滚到快照态，setIcon(null) 合法）。 */
function iconGroupDiffers(
  group: IconGroup,
  tValue: string[] | undefined,
  sValue: string[] | undefined,
): boolean {
  const snap = canonicalSnapIcons(group, sValue);
  if (sValue !== undefined && sValue.length > 0 && snap.length === 0) return false;
  const target = canonicalSnapIcons(group, tValue);
  if (target.length !== snap.length) return true;
  return target.some((v, i) => v !== snap[i]);
}

/** task 差异判定（快照 task 恒为归一化对象，逐字段比即可）。 */
function hasTaskDiff(t: NodeSnapshot['task'], s: NodeSnapshot['task']): boolean {
  return (
    t.status !== s.status ||
    t.progress !== s.progress ||
    t.startDate !== s.startDate ||
    t.dueDate !== s.dueDate ||
    t.doneDate !== s.doneDate ||
    t.owners.length !== s.owners.length ||
    t.owners.some((v, i) => v !== s.owners[i])
  );
}

/** ④ 写入：逐项对比并经 core op 落写（origin 传 ORIGIN_RESTORE；本函数在恢复事务内
 *  调用，嵌套 withTransaction 复用外层事务）。返回是否有任何写入。 */
function applyFieldDiff(target: Y.Doc, id: string, s: NodeSnapshot, canvasId: string): boolean {
  const t = getNode(target, id, canvasId)!;
  let changed = false;
  if (t.text !== s.text) {
    setText(target, id, s.text, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  if (t.note !== s.note) {
    setNote(target, id, s.note, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  if (t.href !== s.href) {
    setHref(target, id, s.href, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  if (t.collapsed !== s.collapsed) {
    setCollapsed(target, id, s.collapsed, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  for (const group of ICON_GROUPS as readonly IconGroup[]) {
    const snapValue = canonicalSnapIcons(group, s.icons[group]);
    // B1：快照组非空而规范化后为空（值域外旧标记）→ 跳过恢复该标记（计划期已按同
    // 规则过滤出计划，此处执行期同判保证 setIcon 只收到目录内值或 null，事务内不再抛）。
    const snapRaw = s.icons[group];
    if (snapRaw !== undefined && snapRaw.length > 0 && snapValue.length === 0) continue;
    const tValue = canonicalSnapIcons(group, t.icons[group]);
    if (tValue.length !== snapValue.length || tValue.some((v, i) => v !== snapValue[i])) {
      if (snapValue.length === 0) {
        setIcon(target, id, group, null, ORIGIN_RESTORE, canvasId);
      } else if (MARKER_GROUP_MODE[group] === 'single') {
        setIcon(target, id, group, snapValue[0] as string, ORIGIN_RESTORE, canvasId);
      } else {
        // multi 组：先清组再逐枚 toggle 追加（setIcon 多值语义下等价于整组覆写）
        setIcon(target, id, group, null, ORIGIN_RESTORE, canvasId);
        for (const v of snapValue) setIcon(target, id, group, v, ORIGIN_RESTORE, canvasId);
      }
      changed = true;
    }
  }
  // task（M7a-T1）：全字段显式 patch——doneDate 恒显式给值（快照原值，含 null），
  // applyStatusRules 联动分支（status→done 自动 doneDate/progress=100）以
  // patch.doneDate === undefined 为触发前提，故联动不触发，恢复结果即快照原值。
  if (hasTaskDiff(t.task, s.task)) {
    setNodeTask(
      target,
      id,
      {
        status: s.task.status,
        progress: s.task.progress,
        owners: [...s.task.owners],
        startDate: s.task.startDate,
        dueDate: s.task.dueDate,
        doneDate: s.task.doneDate,
      },
      ORIGIN_RESTORE,
      canvasId,
    );
    changed = true;
  }
  if (diffImage(t.image, s.image)) {
    setImage(target, id, s.image, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  const stylePatch = stylePatchOf(t.style, s.style);
  if (Object.keys(stylePatch).length > 0) {
    setStyle(target, id, stylePatch, ORIGIN_RESTORE, canvasId);
    changed = true;
  }
  return changed;
}

/** image 按 key + 尺寸 + 位置对比（任一项差异即写回整份快照值——含 2026-10-20 图文
 *  四槽位 placement；缺失 ↔ 存在视为差异）。 */
function diffImage(t: NodeSnapshot['image'], s: NodeSnapshot['image']): boolean {
  if ((t?.key ?? null) !== (s?.key ?? null)) return true;
  if (!t || !s) return false;
  return t.w !== s.w || t.h !== s.h || (t.placement ?? null) !== (s.placement ?? null);
}

/** style 键集对比：并集内值不同者进 patch（快照缺失键 → null 删除）。 */
function stylePatchOf(
  t: NodeSnapshot['style'],
  s: NodeSnapshot['style'],
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const key of new Set([...Object.keys(t), ...Object.keys(s)])) {
    if (t[key] !== s[key]) patch[key] = s[key] ?? null;
  }
  return patch;
}
