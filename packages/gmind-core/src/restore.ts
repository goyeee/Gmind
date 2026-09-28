import * as Y from 'yjs';
import { ICON_GROUPS, type IconGroup } from './constants';
import { ROOT_NODE_ID } from './doc';
import {
  addChild,
  deleteNodes,
  moveNode,
  setCollapsed,
  setHref,
  setImage,
  setIcon,
  setNote,
  setStyle,
  setText,
  withTransaction,
  type WriteOrigin,
} from './operations';
import { getMeta, getNode, setDocMeta, type DocMeta, type NodeSnapshot } from './read';

/** 恢复写来源（M4 Task 7，FR-VER-004）：撤销栈仅跟踪 ORIGIN_USER（undo.ts），
 *  restore 事务整体不进任何客户端的撤销栈——恢复是文档级事实修正，Ctrl+Z 不回滚。 */
export const ORIGIN_RESTORE: WriteOrigin = 'restore';

/** 恢复结果计数（计划 op 口径，事务内执行时累加）：
 * - deleted：顶层删除 op 数（父同被删的深层随子树整枝，不逐节点计）；
 * - created：重建节点数（快照存活而当前墓碑/缺失的节点以新 ULID 重建，Yjs 墓碑永久）；
 * - moved：实际执行的 moveNode 数（落位检查通过者不计）；
 * - updated：内容字段（④ 全字段）有写入的交集节点数；重建节点的字段回填计入 created，
 *   不计 updated；meta 的 structureType/themeId 属文档级，不进节点计数。 */
export interface RestoreResult {
  deleted: number;
  created: number;
  moved: number;
  updated: number;
}

/**
 * 将 target 就地恢复为 snapshot 的内容（结构 op-diff，单事务，ORIGIN_RESTORE）。
 * 前置：两 doc 均为已 normalize 的本项目文档。快照中存活而当前墓碑的节点以新 ULID 重建。
 *
 * ── 算法（binding，plan 全部在事务外算好——校验先于事务纪律）────────────────
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
 *   比；icons 按 ICON_GROUPS 全组对比（组值不同 setIcon(value|null)）；image 按 key 对比
 *   （key 变更时 w/h 随快照值一并写回）；style 按键集对比（补/改/删键，value null 删）。
 *   重建节点的字段回填 = addChild 后立即走同一 diff 例程（新节点必全量不同）。
 * ⑤ meta：structureType/themeId diff → setDocMeta。**title 排除**——meta.title 镜像的
 *   是工作区文件名（useEditorDoc.setTitle 同步 meta 与 PATCH /files），版本恢复是文档
 *   内容回滚，若回写快照 title 会把用户在快照之后的改名一并吃掉，且 files.title 行值
 *   不随之变更（画布与列表名号劈叉）——恢复不改名，title 恒保留 target 现值。
 *
 * ── 概要（summaries）×恢复口径（M6 终审登记，未实现 diff）── 恢复 diff 范围＝
 *   nodes + meta（title 排除先例见⑤）；doc 级 summaries Y.Map **不在恢复范围**——
 *   恢复不回滚概要集、快照概要也不随版本重生。恢复后经 withTransaction 事务后
 *   normalize 的 summary repair（repair.ts 规则⑦ planSummaryRepair）按**存活片段**
 *   收敛：成员被①删除/换父断裂即收敛存活子段，全失效即删概要（summary.ts 三态）；
 *   ②重建节点为新 ULID，不在任何既有概要的 nodeIds 内，不复活旧概要。口径待需求方
 *   裁定（纳入恢复 or 维持现状），裁定前不实现 summaries diff——登记于
 *   docs/m6-acceptance.md 待裁定清单。
 *
 * ── 零操作短路 ── diff 为空（无删/无建/无字段差/meta 差/无落位需求）直接返回全零，
 * 不开事务。落位需求按事务前状态判定——其余四类全空时事务前后状态一致，判定精确；
 * 任一非空则必然开事务，该判定仅作短路门，不影响执行路径（③执行期以现场状态复核）。
 */
export function restoreFromSnapshot(target: Y.Doc, snapshot: Y.Doc): RestoreResult {
  // ——全部读取与 diff 计算在事务外（校验先于事务纪律）——
  const tAlive = reachableAliveIds(target); // root 先序遍历 childIds（visited 防环）
  const sAlive = reachableAliveIds(snapshot);
  const tAliveSet = new Set(tAlive);
  const sAliveSet = new Set(sAlive);
  const snapById = new Map<string, NodeSnapshot>();
  for (const id of sAlive) snapById.set(id, getNode(snapshot, id)!);
  // parent 映射表：快照 id → target id。交集节点（存活于双方）映射自身；重建节点在
  // ② 执行期以 addChild 返回的新 id 回填——因此 ③ 的 mappedParent 统一执行期解析。
  const idMap = new Map<string, string>();
  for (const id of sAlive) {
    if (tAliveSet.has(id)) idMap.set(id, id);
  }
  const mappedParentOf = (snapId: string): string | undefined =>
    snapById.get(snapId)!.parentId === ROOT_NODE_ID
      ? ROOT_NODE_ID
      : idMap.get(snapById.get(snapId)!.parentId);

  // ① 删除计划：删除对象 = target 存活（可达口径）而快照无、非 root；顶层 = 父不在
  //   删除对象集合（父也删 → 随子树整枝，不重复计）。
  const deleteCandidates = tAlive.filter(
    (id) => id !== ROOT_NODE_ID && !sAliveSet.has(id),
  );
  const deleting = new Set(deleteCandidates);
  const deleteIds = deleteCandidates.filter((id) => !deleting.has(getNode(target, id)!.parentId));

  // ② 重建计划：快照先序（sAlive 即先序），父必已映射（先序 + 交集预映射）。
  const createSnapIds = sAlive.filter((id) => !idMap.has(id));

  // ③ 落位计划：快照存活节点按先序逐一登记（交集 + 重建者）；mappedParent/snapIndex
  //   执行期解析（重建父的事务内 id 事务前未知）。
  const places = sAlive
    .filter((id) => id !== ROOT_NODE_ID)
    .map((id) => ({ snapId: id, snapIndex: snapIndexInSnapshot(snapById, id) }));

  // ④ 字段 diff 计划（交集，root 的中心主题文本等字段同为文档内容、一并参与）：
  //   重建者的回填在 ② 执行期走同一例程，不入本表。
  const fieldDiffs = sAlive
    .filter((id) => idMap.has(id))
    .map((id) => ({ snapId: id, snap: snapById.get(id)! }))
    .filter(({ snapId, snap }) => hasFieldDiff(getNode(target, snapId)!, snap));

  // ⑤ meta diff（title 排除，见函数头裁定注释）。
  const metaPatch = metaDiff(getMeta(target), getMeta(snapshot));

  // 落位需求的零操作门（事务前状态判定；精确性论证见「零操作短路」注释）。
  const moveNeeded = sAlive.some((id) => {
    if (id === ROOT_NODE_ID || !idMap.has(id)) return false; // 重建者必伴随 ②，门已开
    const mappedParent = mappedParentOf(id);
    if (mappedParent === undefined) return true; // 父为重建节点：必落位
    const t = getNode(target, id)!;
    if (t.parentId !== mappedParent) return true;
    return (getNode(target, mappedParent)?.childIds.indexOf(id) ?? -1) !== snapIndexInSnapshot(snapById, id);
  });

  // ——diff 为空：直接返回全零，不开事务——
  if (
    deleteIds.length === 0 &&
    createSnapIds.length === 0 &&
    fieldDiffs.length === 0 &&
    Object.keys(metaPatch).length === 0 &&
    !moveNeeded
  ) {
    return { deleted: 0, created: 0, moved: 0, updated: 0 };
  }

  return withTransaction(target, ORIGIN_RESTORE, () => {
    const result: RestoreResult = { deleted: 0, created: 0, moved: 0, updated: 0 };
    // ① 删除：一次批量（deleteNodes 单事务语义，墓碑整枝 + 摘除父 children）
    if (deleteIds.length > 0) {
      deleteNodes(target, deleteIds, ORIGIN_RESTORE);
      result.deleted = deleteIds.length;
    }
    // ② 重建（快照先序；父先于子 → mappedParent 必已就绪）：addChild 落位快照下标，
    //    字段回填走 ④ 同一 diff 例程（计入 created，不计 updated）。
    for (const snapId of createSnapIds) {
      const snap = snapById.get(snapId)!;
      const mappedParent = mappedParentOf(snapId);
      if (mappedParent === undefined) {
        throw new Error(`restore: parent of ${snapId} not resolvable (plan broken)`);
      }
      const newId = addChild(target, mappedParent, { text: snap.text, index: snapIndexInSnapshot(snapById, snapId) }, ORIGIN_RESTORE);
      idMap.set(snapId, newId);
      applyFieldDiff(target, newId, snap);
      result.created += 1;
    }
    // ③ 落位（快照先序；现场复核父映射与同层位置，不符才 moveNode）
    for (const place of places) {
      const id = idMap.get(place.snapId)!;
      const mappedParent = mappedParentOf(place.snapId);
      if (mappedParent === undefined) {
        throw new Error(`restore: parent of ${place.snapId} not resolvable (plan broken)`);
      }
      const t = getNode(target, id)!;
      if (
        t.parentId === mappedParent &&
        getNode(target, mappedParent)?.childIds.indexOf(id) === place.snapIndex
      ) {
        continue; // 已在位（重建节点常态）：零写入
      }
      moveNode(target, id, mappedParent, place.snapIndex, ORIGIN_RESTORE);
      result.moved += 1;
    }
    // ④ 内容字段（交集，事务前 diff 就位的节点逐个执行）
    for (const diff of fieldDiffs) {
      if (applyFieldDiff(target, diff.snapId, diff.snap)) result.updated += 1;
    }
    // ⑤ meta（title 恒不动）
    if (Object.keys(metaPatch).length > 0) setDocMeta(target, metaPatch, ORIGIN_RESTORE);
    return result;
  });
}

// ── 文件内私有 helper ────────────────────────────────────────────────────────

/** root 先序遍历 childIds 收集存活节点（visited 防环，口径同 countAliveReachable：
 *  只走 children、跳过墓碑；normalize 前置保证 parentId/children 一致）。 */
function reachableAliveIds(doc: Y.Doc): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return; // 环防御：跳过已访问
    visited.add(id);
    const node = getNode(doc, id);
    if (node === null || node.deleted) return;
    out.push(id);
    for (const childId of node.childIds) walk(childId);
  };
  walk(ROOT_NODE_ID);
  return out;
}

/** 节点在快照父 children 中的下标（normalize 前置保证parentId 指回该父，找不到为 -1 的
 *  情形仅存在于畸形输入，届时 addChild/moveNode 的钳制语义兜底为 append）。 */
function snapIndexInSnapshot(snapById: Map<string, NodeSnapshot>, id: string): number {
  const snap = snapById.get(id)!;
  return snap.parentId === ROOT_NODE_ID
    ? (snapById.get(ROOT_NODE_ID)?.childIds.indexOf(id) ?? -1)
    : (snapById.get(snap.parentId)?.childIds.indexOf(id) ?? -1);
}

/** ④ 内容字段是否存在差异（计划期判定 + 执行期复用同一判定写入）。 */
function hasFieldDiff(t: NodeSnapshot, s: NodeSnapshot): boolean {
  return (
    t.text !== s.text ||
    t.note !== s.note ||
    t.href !== s.href ||
    t.collapsed !== s.collapsed ||
    diffImage(t.image, s.image) ||
    Object.keys(stylePatchOf(t.style, s.style)).length > 0 ||
    ICON_GROUPS.some((group) => t.icons[group] !== s.icons[group])
  );
}

/** ④ 写入：逐项对比并经 core op 落写（origin 传 ORIGIN_RESTORE；本函数在恢复事务内
 *  调用，嵌套 withTransaction 复用外层事务）。返回是否有任何写入。 */
function applyFieldDiff(target: Y.Doc, id: string, s: NodeSnapshot): boolean {
  const t = getNode(target, id)!;
  let changed = false;
  if (t.text !== s.text) {
    setText(target, id, s.text, ORIGIN_RESTORE);
    changed = true;
  }
  if (t.note !== s.note) {
    setNote(target, id, s.note, ORIGIN_RESTORE);
    changed = true;
  }
  if (t.href !== s.href) {
    setHref(target, id, s.href, ORIGIN_RESTORE);
    changed = true;
  }
  if (t.collapsed !== s.collapsed) {
    setCollapsed(target, id, s.collapsed, ORIGIN_RESTORE);
    changed = true;
  }
  for (const group of ICON_GROUPS as readonly IconGroup[]) {
    if (t.icons[group] !== s.icons[group]) {
      setIcon(target, id, group, s.icons[group] ?? null, ORIGIN_RESTORE);
      changed = true;
    }
  }
  if (diffImage(t.image, s.image)) {
    setImage(target, id, s.image, ORIGIN_RESTORE);
    changed = true;
  }
  const stylePatch = stylePatchOf(t.style, s.style);
  if (Object.keys(stylePatch).length > 0) {
    setStyle(target, id, stylePatch, ORIGIN_RESTORE);
    changed = true;
  }
  return changed;
}

/** image 按 key 对比（key 变更时 w/h 随快照值一并写回；缺失 ↔ 存在视为差异）。 */
function diffImage(t: NodeSnapshot['image'], s: NodeSnapshot['image']): boolean {
  return (t?.key ?? null) !== (s?.key ?? null);
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

/** ⑤ meta diff：structureType/themeId 不同才写；title 恒排除（见 restoreFromSnapshot 头注）。 */
function metaDiff(t: DocMeta, s: DocMeta): Partial<DocMeta> {
  const patch: Partial<DocMeta> = {};
  if (t.structureType !== s.structureType) patch.structureType = s.structureType;
  if (t.themeId !== s.themeId) patch.themeId = s.themeId;
  return patch;
}
