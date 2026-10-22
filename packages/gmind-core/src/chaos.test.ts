import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { ulid } from 'ulid';
import { ICON_GROUPS, iconValuesOf } from './constants';
import { createTemplateDoc, docFromState, docToState } from './doc';
import type { TemplateNodeSpec } from './doc';
import { canvasNodesMap, canvasOrderArr, listCanvases, rootIdOf } from './canvas';
import {
  ORIGIN_SYSTEM,
  ORIGIN_USER,
  addChild,
  deleteNodes,
  moveNode,
  setIcon,
  setStyle,
  setText,
  toggleCollapse,
} from './operations';
import { childrenIds, countAliveReachable, getNode, subtreeIds } from './read';
import type { NodeSnapshot } from './read';
import { attachRemoteNormalization, normalizeTree } from './repair';

/**
 * 并发混沌测试套件（PRD 风险表第一项缓解，FR-COL-003/NFR-REL-005）。
 *
 * M1a 的 repair.test.ts 覆盖了成对（2 客户端）定向交错场景；本套件是其上的
 * **随机化组合层**：3 客户端（docA/docB/docC，同源于 docFromState 克隆）各自挂
 * attachRemoteNormalization（被测接线件，远端事务与本地写统一过闸），按固定种子
 * 的 LCG 随机脚本执行 addChild/setText/moveNode/deleteNodes/setIcon/setStyle/
 * toggleCollapse，每端每批操作后两两交换 update；最终交换后断言收敛三件套：
 *  ① 三端 getNode 全量快照（text/parentId/childIds/note/href/image/icons/style/
 *     collapsed/deleted 全字段）deep-equal；
 *  ② normalizeTree 各端 0 残留（增量治愈无死角的全量复扫收口）；
 *  ③ 服务端口径 countAliveReachable 三端一致。
 *
 * 确定性（崩溃即复现）：节点 id 经 mock ulid 全序计数器生成、三端 clientID 由种子
 * 推导（LWW 裁决可复现）、操作序列出自种子化 LCG——同一种子完整重放同一场景；
 * 任何断言失败都会打印种子与**逐操作执行日志**（操作执行时即时记录）。
 *
 * 操作生成纪律：任何操作不得抛错——候选只从本地存活集抽取；moveNode 目标父落自身
 * 子树时重抽样（8 次不成则跳过）；删除只选存活非 root 节点。
 *
 * 场景偏置种子（确定性复现 PRD FR-COL-003 验收语义）：同文本 LWW、移动 vs 删除、
 * 换父 vs 换父、墓碑上编辑——M1a 已覆盖其成对形态，本套件把它们放回 3 客户端混沌
 * 循环内：预热混沌轮（保护靶）→ 冲突轮（三端并发、延迟到全员完成后一次交换）→
 * 冲突语义定向断言 → 再叠混沌轮 → 最终交换 → 收敛三件套。冲突靶 X 与兜底父 P1
 * 在随机轮中不可被移动/删除（见 preserve），保证脚本化冲突在任何种子下都合法可演。
 */

// ulid 是随机量（时间+随机数），会破坏「同种子 ⇒ 同场景」的重放性；测试内替换为
// 全序计数器（仅本文件生效，vitest 按文件隔离）。id 只参与排序/唯一性，任意全序
// 字符串等价（normalize 的「最大 ULID 断环」等规则对可观测状态排序，语义不变）。
let ulidCounter = 0;
vi.mock('ulid', () => ({
  ulid: () => `T${String(++ulidCounter).padStart(8, '0')}`,
}));

// ── 确定性随机源与抽样 ────────────────────────────────────────────────────────

/** 确定性 32 位 LCG（同 bench.test.ts 口径：Math.imul 精确无溢出）。 */
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function randInt(rnd: () => number, n: number): number {
  return rnd() % n;
}

function pick<T>(rnd: () => number, arr: readonly T[]): T {
  return arr[randInt(rnd, arr.length)] as T;
}

const TEXT_ALPHABET = ['a', 'b', '字']; // 小字母表 ⇒ 高频同文本碰撞（放大 LWW 面）
const FILL_PALETTE: Array<string | null> = ['#e74c3c', '#2ecc71', '#3498db', null];

function randText(rnd: () => number): string {
  const len = 1 + randInt(rnd, TEXT_ALPHABET.length + 1);
  let out = '';
  for (let i = 0; i < len; i += 1) out += pick(rnd, TEXT_ALPHABET);
  return out;
}

// ── 快照 / 存活集 / 同步辅助 ─────────────────────────────────────────────────

/** 单画布节点快照（getNode 全量逐节点，收敛断言的 deep-equal 口径）。 */
function fullSnapshot(doc: Y.Doc, canvasId?: string): Record<string, NodeSnapshot | null> {
  const out: Record<string, NodeSnapshot | null> = {};
  for (const id of canvasNodesMap(doc, canvasId).keys()) out[id] = getNode(doc, id, canvasId);
  return out;
}

/** 本副本某画布存活节点 id 集（该画布 root 恒存活；includeRoot=false 供结构操作选靶）。 */
function aliveIds(doc: Y.Doc, includeRoot: boolean, canvasId?: string): string[] {
  const out: string[] = [];
  const rootId = rootIdOf(doc, canvasId);
  for (const [id, node] of canvasNodesMap(doc, canvasId).entries()) {
    if (id === rootId) {
      if (includeRoot) out.push(id);
      continue;
    }
    if ((node as Y.Map<unknown>).get('deleted') !== true) out.push(id);
  }
  return out;
}

/** 按文本查节点 id（仅用于克隆后、任何写操作前的基线节点定位；模板生成的 id 不可预知）。 */
function findIdByText(doc: Y.Doc, text: string, canvasId?: string): string {
  for (const [id, node] of canvasNodesMap(doc, canvasId).entries()) {
    if ((node as Y.Map<unknown>).get('text') === text) return id;
  }
  throw new Error(`test helper: node with text "${text}" not found`);
}

/**
 * 在 doc 本地给 id 挑一个合法换父目标：存活、非自身、不在自身子树（该画布 root 恒合法兜底）。
 * 偏置场景经 preserve 保底（root + P1 恒在候选），候选为空属测试基建问题，显式报错。
 */
function legalNewParent(doc: Y.Doc, id: string, rnd: () => number, exclude?: string, canvasId?: string): string {
  const banned = new Set([id, ...(exclude ? [exclude] : []), ...subtreeIds(doc, id, canvasId)]);
  const candidates = aliveIds(doc, true, canvasId).filter((p) => !banned.has(p));
  if (candidates.length === 0) {
    throw new Error('bias: 换父无合法目标（preserve 保底失效）——测试基建问题，非收敛缺陷');
  }
  return pick(rnd, candidates);
}

/** from 的全量 update 广播到其余各端（裸 applyUpdate 直入，触发接线 heal）。 */
function broadcast(from: Y.Doc, others: Y.Doc[]): void {
  const update = Y.encodeStateAsUpdate(from);
  for (const o of others) Y.applyUpdate(o, update);
}

/** 全员两两交换（含最终交换）：每端全量 update 广播给其余两端。 */
function exchangeAll(clients: Y.Doc[]): void {
  for (let i = 0; i < clients.length; i += 1) {
    broadcast(clients[i]!, clients.filter((_, j) => j !== i));
  }
}

// ── 收敛三件套断言 ───────────────────────────────────────────────────────────

/** 收敛三件套（多画布口径，Task 5）：逐存活画布全量快照 deep-equal + 画布序/画布清单
 *  一致 + normalizeTree 全量复扫零残留 + 逐画布 countAliveReachable 一致。 */
function assertConvergenceTrio(clients: Y.Doc[], label: string, canvasIds: string[]): void {
  for (const canvasId of canvasIds) {
    const snapA = fullSnapshot(clients[0]!, canvasId);
    expect(snapA, `${label}：三端画布 ${canvasId} 全量快照 A/B deep-equal`).toEqual(
      fullSnapshot(clients[1]!, canvasId),
    );
    if (clients.length > 2) {
      expect(snapA, `${label}：三端画布 ${canvasId} 全量快照 A/C deep-equal`).toEqual(
        fullSnapshot(clients[2]!, canvasId),
      );
    }
    const counts = clients.map((d) => countAliveReachable(d, canvasId));
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[0], `${label}：画布 ${canvasId} 服务端口径 countAliveReachable 一致`).toBe(counts[i]);
    }
  }
  // 画布级收敛：canvasOrder 与存活画布清单（name/rootId/structureType/themeId）一致
  const orderA = canvasOrderArr(clients[0]!).toArray();
  for (let i = 1; i < clients.length; i += 1) {
    expect(orderA, `${label}：canvasOrder 一致`).toEqual(canvasOrderArr(clients[i]!).toArray());
    expect(listCanvases(clients[0]!), `${label}：listCanvases 一致`).toEqual(listCanvases(clients[i]!));
  }
  for (let i = 0; i < clients.length; i += 1) {
    expect(normalizeTree(clients[i]!, ORIGIN_SYSTEM), `${label}：端 ${i} 全量复扫零残留`).toBe(0);
  }
}

// ── 随机操作生成器（绝不抛错）────────────────────────────────────────────────

/**
 * 在 doc 本地执行一个种子化随机操作并记录日志（操作执行时即时记录，崩溃可回放）。
 * preserve：偏置场景的保留靶（冲突节点/兜底父）——随机轮不得移动、不得（级联）删除，
 * 保证脚本化冲突在任何种子轨迹下都合法可演；主混沌场景为空集。
 */
function clientOp(
  doc: Y.Doc,
  rnd: () => number,
  logs: string[],
  label: string,
  preserve: ReadonlySet<string>,
  canvasIds: string[],
): void {
  // 跨画布维度（Task 5 新增）：每个操作先抽画布，后续全部读写限定该画布子图。
  const canvasId = pick(rnd, canvasIds);
  const aliveAll = aliveIds(doc, true, canvasId);
  const aliveNonRoot = aliveIds(doc, false, canvasId);
  switch (randInt(rnd, 7)) {
    case 0: {
      // addChild：随机存活父（含该画布 root）+ 随机下标（越界由 clamp 语义兜底）
      const parent = pick(rnd, aliveAll);
      const index = randInt(rnd, childrenIds(doc, parent, canvasId).length + 1);
      const text = randText(rnd);
      const id = addChild(doc, parent, { index, text }, ORIGIN_USER, canvasId);
      logs.push(`${label} addChild(canvas=${canvasId} parent=${parent} idx=${index} text="${text}") -> ${id}`);
      break;
    }
    case 1: {
      // setText：小字母表短串（含 root，高频同靶碰撞）
      const id = pick(rnd, aliveAll);
      const text = randText(rnd);
      setText(doc, id, text, ORIGIN_USER, canvasId);
      logs.push(`${label} setText(canvas=${canvasId} ${id} "${text}")`);
      break;
    }
    case 2: {
      // moveNode：目标父不得为自身/后代，保留靶不得被移动——重抽样 8 次不成则跳过
      let done = false;
      for (let t = 0; t < 8 && !done && aliveNonRoot.length > 0; t += 1) {
        const id = pick(rnd, aliveNonRoot);
        if (preserve.has(id)) continue;
        const newParent = pick(rnd, aliveAll);
        if (id === newParent || subtreeIds(doc, id, canvasId).includes(newParent)) continue;
        const index = randInt(rnd, childrenIds(doc, newParent, canvasId).length + 1);
        moveNode(doc, id, newParent, index, ORIGIN_USER, canvasId);
        logs.push(`${label} moveNode(canvas=${canvasId} ${id} -> ${newParent} idx=${index})`);
        done = true;
      }
      if (!done) logs.push(`${label} moveNode(canvas=${canvasId} 跳过：重抽样均命中自身子树/保留靶)`);
      break;
    }
    case 3: {
      // deleteNodes：随机存活非 root 单节点（级联墓碑子树）；波及保留靶则重抽样/跳过
      let done = false;
      for (let t = 0; t < 8 && !done && aliveNonRoot.length > 0; t += 1) {
        const id = pick(rnd, aliveNonRoot);
        if (subtreeIds(doc, id, canvasId).some((m) => preserve.has(m))) continue;
        deleteNodes(doc, [id], ORIGIN_USER, canvasId);
        logs.push(`${label} deleteNodes(canvas=${canvasId} [${id}])`);
        done = true;
      }
      if (!done) logs.push(`${label} deleteNodes(canvas=${canvasId} 跳过：重抽样均波及保留靶/无存活节点)`);
      break;
    }
    case 4: {
      // setIcon：随机组 + 组目录内随机值（M7a-T1 值校验；null 删该组）
      const id = pick(rnd, aliveAll);
      const group = pick(rnd, ICON_GROUPS);
      const value = rnd() % 4 === 0 ? null : pick(rnd, iconValuesOf(group));
      setIcon(doc, id, group, value, ORIGIN_USER, canvasId);
      logs.push(`${label} setIcon(canvas=${canvasId} ${id} ${group}=${String(value)})`);
      break;
    }
    case 5: {
      // setStyle：fill 取调色板或 null（删键）
      const id = pick(rnd, aliveAll);
      const fill = pick(rnd, FILL_PALETTE);
      setStyle(doc, id, { fill }, ORIGIN_USER, canvasId);
      logs.push(`${label} setStyle(canvas=${canvasId} ${id} fill=${String(fill)})`);
      break;
    }
    default: {
      // toggleCollapse（显式 user origin：本套件不涉及撤销栈，统一操作来源）
      const id = pick(rnd, aliveAll);
      toggleCollapse(doc, id, ORIGIN_USER, canvasId);
      logs.push(`${label} toggleCollapse(canvas=${canvasId} ${id})`);
      break;
    }
  }
}

// ── 场景骨架 ─────────────────────────────────────────────────────────────────

/** 8-12 节点、3 层基线文档（root → P0..P2 → G*），形状由种子决定。 */
function buildBaseSpec(rnd: () => number): { title: string; children: TemplateNodeSpec[] } {
  const target = 8 + randInt(rnd, 5); // 总节点数 8..12（含 root）
  const branches: TemplateNodeSpec[] = [0, 1, 2].map((i) => ({ text: `P${i}`, children: [] }));
  let used = 4; // root + 3 分支
  let k = 0;
  while (used < target) {
    branches[k % 3]!.children!.push({ text: `G${k}` });
    used += 1;
    k += 1;
  }
  return { title: '混沌基线', children: branches };
}

/** 同源三客户端：docFromState 克隆 base（导入即收敛），clientID 由种子推导（LWW 可复现）。 */
function makeClients(state: Uint8Array, seed: number): Y.Doc[] {
  return [1, 2, 3].map((i) => {
    const d = docFromState(state);
    d.clientID = 1000 + i * 10 + (seed % 10);
    return d;
  });
}

/**
 * 混沌轮：每端每轮 2-3 个种子化操作，**每批后立即两两广播**（A→B→C 传递扩散）。
 * 立即广播使后续操作总能看到前序客户端的换父，moveNode 的 CYCLE_FORBIDDEN
 * 本地校验因此始终有效——随机脚本天然合法。
 */
function chaosRounds(
  clients: Y.Doc[],
  rnd: () => number,
  logs: string[],
  rounds: number,
  phase: string,
  preserve: ReadonlySet<string> = new Set(),
  canvasIds?: string[],
): void {
  // 缺省 = 第一画布（既有单画布场景零感知）；跨画布场景显式传全部存活画布。
  const ids = canvasIds ?? [canvasOrderArr(clients[0]!).get(0) as string];
  for (let round = 1; round <= rounds; round += 1) {
    for (let ci = 0; ci < clients.length; ci += 1) {
      const doc = clients[ci]!;
      const nOps = 2 + randInt(rnd, 2);
      for (let k = 0; k < nOps; k += 1) {
        clientOp(doc, rnd, logs, `${phase} r${round} c${ci + 1}#${k + 1}`, preserve, ids);
      }
      broadcast(doc, clients.filter((_, j) => j !== ci));
    }
  }
}

/** 运行一个种子化混沌场景：10 轮随机交错 → 最终交换 → 收敛三件套。失败打印种子+操作日志。 */
function runChaosScenario(seed: number): void {
  const rnd = makeLcg(seed);
  ulidCounter = 0; // 同种子 ⇒ 同 id 序列 ⇒ 全场景可复现
  const base = createTemplateDoc(buildBaseSpec(rnd));
  const clients = makeClients(docToState(base), seed);
  const canvasIds = [canvasOrderArr(clients[0]!).get(0) as string];
  const detaches = clients.map((d) => attachRemoteNormalization(d));
  const logs: string[] = [];
  try {
    chaosRounds(clients, rnd, logs, 10, `[seed=${seed}]`);
    exchangeAll(clients); // 最终两两交换
    assertConvergenceTrio(clients, `chaos seed=${seed}`, canvasIds);
  } catch (e) {
    console.error(`[chaos] 收敛失败 seed=${seed}，完整操作日志（按执行序）：\n${logs.join('\n')}`);
    throw e;
  } finally {
    for (const detach of detaches) detach();
  }
}

/** 偏置冲突驱动器：三端各执行确定性并发操作（期间不交换），返回待定向断言的 id。 */
type ConflictDriver = (clients: Y.Doc[], xId: string, rnd: () => number, logs: string[]) => Record<string, string>;
/** 冲突语义定向断言（冲突交换完成后立即执行，钉死 PRD 验收语义的具体结局）。 */
type BiasAsserts = (clients: Y.Doc[], captured: Record<string, string>) => void;

/**
 * 偏置场景骨架：预热 2 轮混沌（preserve 保护冲突靶 X 与兜底父 P1）→ 冲突轮（三端
 * 并发、**延迟到全员完成后一次交换**，复现真并发窗口）→ 定向断言（此刻冲突结局
 * 尚未被后续随机操作合法改写）→ 再叠 2 轮混沌 → 最终交换 → 收敛三件套。
 */
function runBiasScenario(
  seed: number,
  caseName: string,
  conflict: ConflictDriver,
  asserts: BiasAsserts,
): void {
  const rnd = makeLcg(seed);
  ulidCounter = 0;
  const base = createTemplateDoc({
    title: 'T',
    children: [
      { text: 'P1', children: [{ text: 'P1a' }] },
      { text: 'P2', children: [{ text: 'P2a' }] },
      { text: 'P3', children: [{ text: 'P3a' }] },
      { text: 'X', children: [{ text: 'Xa' }] },
    ],
  });
  const clients = makeClients(docToState(base), seed);
  const canvasIds = [canvasOrderArr(clients[0]!).get(0) as string];
  // 冲突靶 X 与兜底父 P1 在克隆后即刻定位（文本尚 pristine）：preserve 保证二者在
  // 随机轮中恒存活且保持 root 直属（不被移动/级联删除），冲突脚本因此恒合法。
  const xId = findIdByText(clients[0]!, 'X');
  const preserve = new Set([xId, findIdByText(clients[0]!, 'P1')]);
  const detaches = clients.map((d) => attachRemoteNormalization(d));
  const logs: string[] = [];
  try {
    chaosRounds(clients, rnd, logs, 2, `[bias ${caseName} s${seed} 预热]`, preserve);
    const captured = conflict(clients, xId, rnd, logs);
    exchangeAll(clients); // 冲突轮一次性两两交换（真并发合并）
    asserts(clients, captured);
    chaosRounds(clients, rnd, logs, 2, `[bias ${caseName} s${seed} 叠加]`, preserve);
    exchangeAll(clients);
    assertConvergenceTrio(clients, `bias ${caseName} seed=${seed}`, canvasIds);
  } catch (e) {
    console.error(
      `[chaos] 偏置场景失败 ${caseName} seed=${seed}，完整操作日志（按执行序）：\n${logs.join('\n')}`,
    );
    throw e;
  } finally {
    for (const detach of detaches) detach();
  }
}

// ── 跨画布并发维度（多画布 Task 5 新增）──────────────────────────────────────

/**
 * 在 base 文档上追加一个画布（混沌跨画布维度造数）：root + n 个一级子节点，
 * id 走（mock 的）ulid 全序计数器——同种子 ⇒ 同 id 序列 ⇒ 全场景可复现。
 * 返回新画布 id。
 */
function appendChaosCanvas(doc: Y.Doc, name: string, childCount: number): string {
  const canvasId = ulid();
  const rootId = ulid();
  doc.transact(() => {
    const canvas = new Y.Map<unknown>();
    canvas.set('name', name);
    canvas.set('rootId', rootId);
    canvas.set('structureType', 'mindmap');
    canvas.set('themeId', 'gmind-light');
    const nodes = new Y.Map<Y.Map<unknown>>();
    const root = new Y.Map<unknown>();
    root.set('text', name);
    root.set('parentId', '');
    const rootChildren = new Y.Array<string>();
    root.set('children', rootChildren);
    nodes.set(rootId, root);
    for (let i = 0; i < childCount; i += 1) {
      const childId = ulid();
      const child = new Y.Map<unknown>();
      child.set('text', `${name}-${i}`);
      child.set('parentId', rootId);
      child.set('children', new Y.Array<string>());
      nodes.set(childId, child);
      rootChildren.push([childId]);
    }
    canvas.set('nodes', nodes);
    canvas.set('summaries', new Y.Map<unknown>());
    (doc.getMap('canvases') as Y.Map<Y.Map<unknown>>).set(canvasId, canvas);
    canvasOrderArr(doc).push([canvasId]);
  });
  return canvasId;
}

/**
 * 跨画布并发写场景（Task 5 混沌新维度）：双画布基线（c1 来自模板，c2 追加），
 * 两副本（brief 口径「双副本收敛一致」）各自挂接线后执行 10 轮随机操作——每个
 * 操作独立抽画布（addChild/moveNode/deleteNodes 等在两个画布上并发交错），
 * 每批后立即广播；最终交换 → 逐画布收敛三件套。
 */
function runCrossCanvasScenario(seed: number): void {
  const rnd = makeLcg(seed);
  ulidCounter = 0;
  const base = createTemplateDoc(buildBaseSpec(rnd));
  const c2 = appendChaosCanvas(base, '画布二', 2 + randInt(rnd, 3));
  const clients = [1, 2].map((i) => {
    const d = docFromState(docToState(base));
    d.clientID = 2000 + i * 10 + (seed % 10);
    return d;
  });
  const canvasIds = canvasOrderArr(clients[0]!).toArray();
  if (canvasIds.length !== 2 || canvasIds[1] !== c2) {
    throw new Error('跨画布场景基建失败：基线应为恰好两个画布');
  }
  const detaches = clients.map((d) => attachRemoteNormalization(d));
  const logs: string[] = [];
  try {
    chaosRounds(clients, rnd, logs, 10, `[xcanvas seed=${seed}]`, new Set(), canvasIds);
    exchangeAll(clients);
    assertConvergenceTrio(clients, `xcanvas seed=${seed}`, canvasIds);
  } catch (e) {
    console.error(`[chaos] 跨画布收敛失败 seed=${seed}，完整操作日志（按执行序）：\n${logs.join('\n')}`);
    throw e;
  } finally {
    for (const detach of detaches) detach();
  }
}

// ── 套件本体 ─────────────────────────────────────────────────────────────────

describe('并发混沌：三客户端随机交错收敛（FR-COL-003/NFR-REL-005）', () => {  const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
  for (const seed of SEEDS) {
    it(`seed=${seed}：10 轮 × 3 端 × 2-3 随机操作，两两交换后收敛三件套`, () => {
      runChaosScenario(seed);
    });
  }
});

describe('并发混沌：跨画布并发写（多画布 Task 5 新维度）', () => {
  const SEEDS = Array.from({ length: 5 }, (_, i) => i + 201);
  for (const seed of SEEDS) {
    it(`seed=${seed}：双画布上并发 addChild/moveNode/deleteNodes，双副本 10 轮交错后收敛一致`, () => {
      runCrossCanvasScenario(seed);
    });
  }
});

describe('场景偏置种子（确定性并发语义，3 客户端混沌循环内复现）', () => {
  for (const seed of [101, 102, 103]) {
    it(`同文本 LWW：三端同节点并发写不同文本 → 收敛为唯一胜者（seed=${seed}）`, () => {
      runBiasScenario(
        seed,
        '同文本LWW',
        (clients, xId, _rnd, logs) => {
          setText(clients[0]!, xId, '甲侧文本', ORIGIN_USER);
          setText(clients[1]!, xId, '乙侧文本', ORIGIN_USER);
          setText(clients[2]!, xId, '丙侧文本', ORIGIN_USER);
          logs.push(`bias 同文本LWW：A/B/C setText(${xId}) 三方并发`);
          return { xId };
        },
        (clients, { xId }) => {
          const texts = new Set(clients.map((d) => getNode(d, xId)!.text));
          expect(texts.size, '三端文本必须收敛为唯一 LWW 胜者').toBe(1);
          expect(
            texts.has('甲侧文本') || texts.has('乙侧文本') || texts.has('丙侧文本'),
            `胜者必为并发写入之一（实际：${[...texts][0]}）`,
          ).toBe(true);
        },
      );
    });

    it(`移动 vs 删除：A 换父 X、B 级联删 X 并发 → 三端墓碑且 children 无残留引用（seed=${seed}）`, () => {
      runBiasScenario(
        seed,
        '移动vs删除',
        (clients, xId, rnd, logs) => {
          const newParent = legalNewParent(clients[0]!, xId, rnd);
          moveNode(clients[0]!, xId, newParent, 0, ORIGIN_USER);
          deleteNodes(clients[1]!, [xId], ORIGIN_USER);
          logs.push(`bias 移动vs删除：A moveNode(${xId} -> ${newParent})，B deleteNodes([${xId}]) 并发`);
          return { xId };
        },
        (clients, { xId }) => {
          for (const d of clients) {
            expect(getNode(d, xId)!.deleted, '删除方写墓碑键、移动方从不写 → 三端均墓碑').toBe(true);
            for (const [id, snap] of Object.entries(fullSnapshot(d))) {
              expect(snap?.childIds ?? [], `节点 ${id} 的 children 不再引用墓碑 X`).not.toContain(xId);
            }
          }
        },
      );
    });

    it(`换父 vs 换父：A/B 并发把 X 挂到不同父 → LWW 定唯一胜者、败者侧清理（seed=${seed}）`, () => {
      runBiasScenario(
        seed,
        '换父vs换父',
        (clients, xId, rnd, logs) => {
          const paId = legalNewParent(clients[0]!, xId, rnd);
          const pbId = legalNewParent(clients[1]!, xId, rnd, paId); // 强制与 A 异父，构成真冲突
          moveNode(clients[0]!, xId, paId, 0, ORIGIN_USER);
          moveNode(clients[1]!, xId, pbId, 0, ORIGIN_USER);
          logs.push(`bias 换父vs换父：A moveNode(${xId} -> ${paId})，B moveNode(${xId} -> ${pbId}) 并发`);
          return { xId, paId, pbId };
        },
        (clients, { xId, paId, pbId }) => {
          const winner = getNode(clients[0]!, xId)!.parentId;
          expect([paId, pbId], `胜者必为并发换父之一（实际：${winner}）`).toContain(winner);
          for (const d of clients) {
            const holders = Object.values(fullSnapshot(d))
              .filter((s) => s?.childIds.includes(xId))
              .map((s) => s!.id);
            expect(holders, 'X 恰挂于唯一胜者父级（败者侧已清理）').toEqual([winner]);
          }
        },
      );
    });

    it(`墓碑上编辑：A 级联删 X、B 同时刻编辑 X 文本 → 墓碑胜出、编辑键并存、结构无残留（seed=${seed}）`, () => {
      runBiasScenario(
        seed,
        '墓碑上编辑',
        (clients, xId, _rnd, logs) => {
          deleteNodes(clients[0]!, [xId], ORIGIN_USER);
          setText(clients[1]!, xId, '墓碑上编辑', ORIGIN_USER); // 延迟交换 ⇒ B 本地仍存活，合法
          logs.push(`bias 墓碑上编辑：A deleteNodes([${xId}])，B setText(${xId}) 并发`);
          return { xId };
        },
        (clients, { xId }) => {
          for (const d of clients) {
            const snap = getNode(d, xId)!;
            expect(snap.deleted, '墓碑键无人回写 false → 三端均墓碑').toBe(true);
            expect(snap.text, '编辑写入的 text 键与墓碑键不同槽，两写并存且三端一致').toBe('墓碑上编辑');
            for (const [id, s] of Object.entries(fullSnapshot(d))) {
              expect(s?.childIds ?? [], `节点 ${id} 的 children 不再引用墓碑 X`).not.toContain(xId);
            }
          }
        },
      );
    });
  }
});
