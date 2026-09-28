import * as Y from 'yjs';
import { ulid } from 'ulid';
import { ROOT_NODE_ID } from './doc';
import { MAX_TEXT_LENGTH } from './constants';
import { GmindCoreError } from './errors';
import { getNode } from './read';
import { withTransaction } from './operations';
import { ORIGIN_USER, type WriteOrigin } from './undo';

/**
 * 概要（summary bracket，FR-EDT-023 / M6 Task 6 企微对标）。
 *
 * 数据口径（M6 Global Constraints 裁定）：doc 级 `summaries` Y.Map
 * （id → {nodeIds: string[], label: string}），nodeIds 为**同父连续兄弟片段**，
 * 按父 children 序规范化存储。写入走 withTransaction（唯一写入口、校验先于事务）；
 * 片段断裂（节点删除/换父）由 repair 在每次 normalize 时收敛（见 planSummaryRepair，
 * repair.ts 的 normalizeTree / normalizeTreeFor 统一接线）：
 * 片段内全部消失 → 删概要；部分 → 保留存活子段（label 不动）。
 *
 * 模块环说明：本模块 import operations（withTransaction），operations import repair，
 * repair import 本模块（planSummaryRepair/applySummaryRepair）——三方均为函数调用期
 * 取值、不在模块求值期解引用，ESM 语义下无 TDZ 风险（与 doc ↔ repair 已登记的
 * 良性环同理）。
 */

/** 概要只读快照（listSummaries 输出；按 id 升序，畸形条目确定性跳过）。 */
export interface SummarySnapshot {
  id: string;
  nodeIds: string[];
  label: string;
}

function summariesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('summaries');
}

/** 与 read.ts/repair.ts 同款类型化访问（Y.Map 泛型丢失问题）。 */
function nodesMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
  return doc.getMap('nodes');
}

/** 条目防御读取：形状不符（远端坏数据）返回 null，绝不抛错（镜像 read.ts 风格）。 */
function readEntry(entry: unknown): SummarySnapshot | null {
  if (!(entry instanceof Y.Map)) return null;
  const nodeIds = entry.get('nodeIds');
  const label = entry.get('label');
  if (!(nodeIds instanceof Y.Array)) return null;
  const ids = nodeIds.toArray().filter((v): v is string => typeof v === 'string');
  if (ids.length !== nodeIds.length) return null;
  if (typeof label !== 'string') return null;
  return { id: '', nodeIds: ids, label };
}

/**
 * 校验片段并返回规范化顺序（父 children 序）的 nodeIds；非法返回 null。
 * 规则（M6 口径）：≥1 个成员、全部存在且存活、不含 root、互不重复、同父，
 * 且各成员在父 childIds 中的下标构成连续区间。
 */
export function validSummarySegment(doc: Y.Doc, nodeIds: string[]): string[] | null {
  if (nodeIds.length === 0) return null;
  if (new Set(nodeIds).size !== nodeIds.length) return null;
  const first = getNode(doc, nodeIds[0] as string);
  if (!first || first.deleted || nodeIds[0] === ROOT_NODE_ID) return null;
  const parentId = first.parentId;
  if (parentId === '') return null; // 无父（root）不成片段
  const parent = getNode(doc, parentId);
  if (!parent || parent.deleted) return null;
  const indexed: Array<{ id: string; idx: number }> = [];
  for (const id of nodeIds) {
    if (id === ROOT_NODE_ID) return null;
    const snap = getNode(doc, id);
    if (!snap || snap.deleted || snap.parentId !== parentId) return null;
    const idx = parent.childIds.indexOf(id);
    if (idx === -1) return null;
    indexed.push({ id, idx });
  }
  indexed.sort((a, b) => a.idx - b.idx);
  for (let i = 1; i < indexed.length; i += 1) {
    if ((indexed[i] as { idx: number }).idx !== (indexed[i - 1] as { idx: number }).idx + 1) {
      return null; // 同父不同段（中间隔着未选中的兄弟）
    }
  }
  return indexed.map((e) => e.id);
}

/**
 * 创建/更新概要，返回概要 id。
 * 校验（先于 transact，拒绝即零变更，SUMMARY_INVALID）：片段合法（见
 * validSummarySegment）；label 长度 ≤ MAX_TEXT_LENGTH。同片段重复提交（label 行内
 * 编辑口径）复用既有条目仅改 label；nodeIds 一致性按规范化序比较。
 */
export function setSummary(
  doc: Y.Doc,
  nodeIds: string[],
  label: string,
  origin: WriteOrigin = ORIGIN_USER,
): string {
  if (label.length > MAX_TEXT_LENGTH) {
    throw new GmindCoreError('SUMMARY_INVALID', '概要标签长度已达上限');
  }
  const segment = validSummarySegment(doc, nodeIds);
  if (segment === null) {
    throw new GmindCoreError('SUMMARY_INVALID', '概要需选择同一父节点下的连续节点');
  }
  // 既有同片段条目复用（先于事务的只读探测；并发窗口内两侧各建一条也可收敛——
  // repair 不删重叠概要，渲染层各自成 bracket）
  let reuseId: string | null = null;
  for (const [id, entry] of summariesMap(doc).entries()) {
    const snap = readEntry(entry);
    if (snap && snap.nodeIds.length === segment.length && snap.nodeIds.every((v, i) => v === segment[i])) {
      reuseId = id;
      break;
    }
  }
  const id = reuseId ?? ulid();
  withTransaction(doc, origin, () => {
    const summaries = summariesMap(doc);
    let entry = summaries.get(id);
    if (entry === undefined) {
      entry = new Y.Map<unknown>();
      const ids = new Y.Array<string>();
      ids.insert(0, segment);
      entry.set('nodeIds', ids);
      entry.set('label', label);
      summaries.set(id, entry);
      return;
    }
    entry.set('label', label);
    const ids = entry.get('nodeIds');
    if (!(ids instanceof Y.Array) || ids.length !== segment.length || ids.toArray().some((v, i) => v !== segment[i])) {
      const next = new Y.Array<string>();
      next.insert(0, segment);
      entry.set('nodeIds', next);
    }
  });
  return id;
}

/** 删除概要；不存在的 id 静默 no-op（零写入）。 */
export function removeSummary(doc: Y.Doc, id: string, origin: WriteOrigin = ORIGIN_USER): void {
  if (!summariesMap(doc).has(id)) return;
  withTransaction(doc, origin, () => {
    summariesMap(doc).delete(id);
  });
}

/** 全部概要快照（id 升序；畸形条目确定性跳过）。 */
export function listSummaries(doc: Y.Doc): SummarySnapshot[] {
  const out: SummarySnapshot[] = [];
  for (const [id, entry] of summariesMap(doc).entries()) {
    const snap = readEntry(entry);
    if (snap) out.push({ ...snap, id });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

// ══ repair 收敛（由 repair.ts 的 normalizeTree / normalizeTreeFor 统一接线）══════

/** 概要修复计划：删除条目 id 列表 + 收敛后的 nodeIds 更新（在调用方事务内应用）。 */
export interface SummaryRepairPlan {
  removeIds: string[];
  updates: Array<{ id: string; nodeIds: string[] }>;
}

/**
 * 规划概要收敛（文档状态纯函数，replica 一致）：
 * - 成员「离开片段」的判定 = 节点缺失 / 墓碑 / parentId 已变 / 不在父 childIds 中
 *   （父 id 取片段首个仍存在成员的 parentId——同父是片段不变量）；
 * - 全部离开 → 删除条目；部分离开 → nodeIds 收敛为存活成员（保持父序）；
 * - 收敛后若存活成员在父序中不再连续（如外来节点被移入中间），取**最长连续段**
 *   （并列取最前）——保证收敛结果仍是合法片段（validSummarySegment 通过）；
 * - label 一概不动；干净概要零计划（不产生写入）。
 * 返回 null 表示无需修复。
 */
export function planSummaryRepair(doc: Y.Doc): SummaryRepairPlan | null {
  const nodes = nodesMap(doc);
  const plan: SummaryRepairPlan = { removeIds: [], updates: [] };
  for (const [id, entry] of summariesMap(doc).entries()) {
    const snap = readEntry(entry);
    if (!snap) continue; // 畸形条目：repair 不治形状（读侧已防御跳过），确定性不动
    // 片段父：同父不变量下取首个仍存在成员的 parentId；全不存在时无法归属 → 删除。
    let parentId: string | null = null;
    for (const nodeId of snap.nodeIds) {
      const node = nodes.get(nodeId);
      if (node !== undefined) {
        const v = node.get('parentId');
        parentId = typeof v === 'string' ? v : '';
        break;
      }
    }
    if (parentId === null || parentId === '') {
      plan.removeIds.push(id);
      continue;
    }
    const parent = nodes.get(parentId);
    const childIds =
      parent !== undefined && parent.get('deleted') !== true
        ? (parent.get('children') instanceof Y.Array ? (parent.get('children') as Y.Array<string>).toArray() : [])
        : [];
    const alive: Array<{ id: string; idx: number }> = [];
    for (const nodeId of snap.nodeIds) {
      const node = nodes.get(nodeId);
      if (node === undefined || node.get('deleted') === true) continue;
      const pid = node.get('parentId');
      if (typeof pid !== 'string' || pid !== parentId) continue;
      const idx = childIds.indexOf(nodeId);
      if (idx === -1) continue;
      alive.push({ id: nodeId, idx });
    }
    if (alive.length === 0) {
      plan.removeIds.push(id); // 片段内全部消失 → 删概要
      continue;
    }
    alive.sort((a, b) => a.idx - b.idx);
    // 最长连续段（并列取最前）：正常删除流下存活成员天然连续，此步直接透传。
    let bestStart = 0;
    let bestLen = 0;
    let start = 0;
    for (let i = 1; i <= alive.length; i += 1) {
      const prev = alive[i - 1] as { idx: number };
      const cur = alive[i] as { idx: number } | undefined;
      if (cur === undefined || cur.idx !== prev.idx + 1) {
        if (i - start > bestLen) {
          bestLen = i - start;
          bestStart = start;
        }
        start = i;
      }
    }
    const converged = alive.slice(bestStart, bestStart + bestLen).map((e) => e.id);
    const unchanged =
      converged.length === snap.nodeIds.length && converged.every((v, i) => v === snap.nodeIds[i]);
    if (!unchanged) plan.updates.push({ id, nodeIds: converged });
  }
  if (plan.removeIds.length === 0 && plan.updates.length === 0) return null;
  return plan;
}

/** 应用概要修复计划（必须在调用方已开启的事务内执行）；返回修复计数。 */
export function applySummaryRepair(doc: Y.Doc, plan: SummaryRepairPlan | null): number {
  if (plan === null) return 0;
  const summaries = summariesMap(doc);
  for (const id of plan.removeIds) summaries.delete(id);
  for (const u of plan.updates) {
    const entry = summaries.get(u.id);
    if (entry === undefined) continue; // 防御：计划后理论不可达
    const ids = new Y.Array<string>();
    ids.insert(0, u.nodeIds);
    entry.set('nodeIds', ids);
  }
  return plan.removeIds.length + plan.updates.length;
}
