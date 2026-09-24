#!/usr/bin/env node
/**
 * 50 机器人延迟压测（FR-COL-001 / NFR-PERF-005）— M2 Task 9。
 *
 * 单 Node 进程持有 N 个 @hocuspocus/provider 机器人（Task 1 验证过的连接形态：
 * HocuspocusProvider + WebSocketPolyfill=ws），连同一文档；每 bot 以 ~500ms±100ms
 * 的节奏（bot 间错峰 10ms）对「自己名下」的种子节点做 setText 文本编辑，文本即
 * 操作标记 `b{bot}s{seq}`（op 内嵌序号，接收端解析，见下）。
 *
 * 延迟口径（精确相关，非近似）：
 *   - 发送端：每次 setText 前记 t0 = performance.now()，op 记为 {bot, seq, t0}；
 *   - 接收端：其余 bot 监听自己 Y.Doc 的 afterTransaction，tr.local === false（远端
 *     applyUpdate）且 changed 含某节点的 'text' 时，读该节点新文本解析出 `b{bot}s{seq}`
 *     → 记录到达时刻 arrivals[b][key]（单进程共享时钟，无跨机对时问题）；
 *   - 单 op 延迟 = 对每个其他 bot 取「该 op 的最早到达时刻 − t0」，再取全部接收端的
 *     中位数（抗单 bot 事件循环抖动）；汇总全 ops 输出 P50/P95/P99。
 *   - 说明：测量含客户端（本进程）事件循环的排队开销，即「模拟 50 客户端」口径
 *     （spec 验证方式）；单进程对全部 bot 一视同仁，不失偏。文本标记经全量替换
 *     （`^b\d+s\d+$`），与种子文本（`节点-i`）无碰撞；normalize 修复不写 text，无误报。
 *
 * 运行（先登录拿 token、建文件拿 fileId，见 docs/perf-m2.md）：
 *   cd apps/server && ./node_modules/.bin/tsx tools/latency-bots.mjs \
 *     --url ws://127.0.0.1:3001/collab --token <sessionToken> --file <fileId> \
 *     --bots 50 --duration 60000 [--docState <base64 Yjs 状态>]
 * （经 tsx 而非裸 node：@gmind/core 以 TS 源码为入口（main=src/index.ts），
 *   裸 node 无法解析其无扩展名 TS 导入；tsx 与 dev server 同一运行时，无新增依赖。）
 *
 * 退出码：0 = P95 < 100ms 且全部 bot sync 成功；1 = 超标 / 失败（附数据）。
 */
import { WebSocket as WsImpl } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { ROOT_NODE_ID, addChild, childrenIds, setText } from '@gmind/core';

const PERF_TARGET_MS = 100;

/** 手写 arg 解析（零依赖）：--key value；布尔开关无值时记 true。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`未知参数：${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const opts = parseArgs(process.argv.slice(2));
const url = typeof opts.url === 'string' ? opts.url : 'ws://127.0.0.1:3001/collab';
const token = typeof opts.token === 'string' ? opts.token : '';
const fileId = typeof opts.file === 'string' ? opts.file : '';
const botCount = opts.bots === undefined ? 50 : Number(opts.bots);
const durationMs = opts.duration === undefined ? 60_000 : Number(opts.duration);
const docStateB64 = typeof opts.docState === 'string' ? opts.docState : '';

if (!token || !fileId || !Number.isInteger(botCount) || botCount < 2 || !Number.isFinite(durationMs) || durationMs <= 0) {
  console.error(
    '用法：node latency-bots.mjs --url ws://127.0.0.1:3001/collab --token <sessionToken> ' +
      '--file <fileId> [--bots 50] [--duration 60000] [--docState <base64>]\n' +
      '（--bots ≥ 2：延迟定义为「到达其他连接」，单 bot 无远端可测）',
  );
  process.exit(2);
}

const percentile = (sorted, q) => {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[idx];
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询等待：条件成立或超时抛错。 */
async function until(pred, label, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`timeout: ${label}`);
}

// ─────────────────────────── 阶段 1：连接 N 个 bot ───────────────────────────

const now = () => performance.now();
const ops = []; // { bot, seq, t0 }
/** arrivals[bot] = Map<`${writer}:${seq}`, number[]（同一 op 重复到达取最早）> */
const arrivals = Array.from({ length: botCount }, () => new Map());
const failedBots = [];

const bots = [];
for (let i = 0; i < botCount; i += 1) {
  const provider = new HocuspocusProvider({
    url,
    name: fileId, // documentName = fileId（Task 1 裁定）
    token,
    WebSocketPolyfill: WsImpl,
  });
  provider.on('authenticationFailed', () => failedBots.push({ bot: i, reason: 'authenticationFailed' }));
  // 远端更新到达即计时：tr.local === false 表示经 Y.applyUpdate 合入（非本地 transact）
  provider.document.on('afterTransaction', (tr) => {
    if (tr.local) return;
    const t = now();
    for (const [type, keys] of tr.changed) {
      if (!keys.has('text')) continue;
      const text = type.get('text');
      if (typeof text !== 'string') continue;
      const m = /^b(\d+)s(\d+)$/.exec(text);
      if (!m) continue; // 种子文本等非 op 写入
      const key = `${m[1]}:${m[2]}`;
      const list = arrivals[i].get(key);
      if (list) list.push(t);
      else arrivals[i].set(key, [t]);
    }
  });
  bots.push(provider);
}

try {
  await until(
    () => bots.every((p) => p.isSynced),
    `全部 ${botCount} 个 bot 完成首同步（30s）`,
    30_000,
  );
  console.log(`[1/4] ${botCount} 个 bot 已连接并同步：${url} doc=${fileId}`);
} catch (err) {
  console.error(`连接/同步失败：${err.message}; isSynced=${bots.map((p) => p.isSynced).join(',')}`);
  if (failedBots.length > 0) console.error(`authenticationFailed：${JSON.stringify(failedBots)}`);
  for (const p of bots) p.destroy();
  process.exit(1);
}

// ─────────────────────────── 阶段 2：种子内容（一次性） ───────────────────────────

const doc0 = bots[0].document;
if (docStateB64) {
  Y.applyUpdate(doc0, new Uint8Array(Buffer.from(docStateB64, 'base64')));
  await sleep(1_000); // 等 docState 传播到全部 bot
}
let kids = childrenIds(doc0, ROOT_NODE_ID);
if (kids.length < 2) {
  // 基线轮廓 ~30 个一级节点（@gmind/core addChild，与前端同一条领域写路径）
  for (let k = kids.length; k < 30; k += 1) addChild(doc0, ROOT_NODE_ID, { text: `节点-${k}` });
  kids = childrenIds(doc0, ROOT_NODE_ID);
}
const seedCount = kids.length;
await until(
  () => bots.every((p) => childrenIds(p.document, ROOT_NODE_ID).length >= seedCount),
  `种子内容传播到全部 bot（15s，seed=${seedCount}）`,
  15_000,
);
const ownedNodes = Array.from({ length: botCount }, (_, i) => kids[i % seedCount]);
console.log(`[2/4] 种子就绪：${seedCount} 个节点，bot i 编辑 kids[i % ${seedCount}]`);

// ─────────────────────────── 阶段 3：压测循环 ───────────────────────────

const endAt = Date.now() + durationMs;
const timers = [];
let opErrors = 0;

for (let i = 0; i < botCount; i += 1) {
  const nodeId = ownedNodes[i];
  let seq = 0;
  const tick = () => {
    if (Date.now() >= endAt) return;
    const t0 = now();
    try {
      setText(bots[i].document, nodeId, `b${i}s${seq}`);
      ops.push({ bot: i, seq, t0 });
      seq += 1;
    } catch {
      opErrors += 1;
    }
    // 500ms ± 100ms 抖动；bot 间 10ms 错峰由首延时实现
    timers[i] = setTimeout(tick, 400 + Math.random() * 200);
  };
  timers[i] = setTimeout(tick, i * 10);
}

console.log(`[3/4] 压测进行中：${durationMs / 1000}s × ${botCount} bots（~${botCount * 2} ops/s）…`);
await sleep(durationMs + 200);
for (const t of timers) clearTimeout(t);
await sleep(1_000); // 收尾：等在途 update 落到各副本

// ─────────────────────────── 阶段 4：统计与判定 ───────────────────────────

/** 每 op：各其他 bot 的最早到达 − t0 → 取接收端中位数（抗单点抖动）。 */
const latencies = [];
let uncovered = 0; // 无任何其他 bot 观测到的 op（理论不可达即异常，计入并单列）
for (const op of ops) {
  const key = `${op.bot}:${op.seq}`;
  const samples = [];
  for (let b = 0; b < botCount; b += 1) {
    if (b === op.bot) continue;
    const list = arrivals[b].get(key);
    if (!list || list.length === 0) continue;
    samples.push(Math.min(...list) - op.t0);
  }
  if (samples.length === 0) {
    uncovered += 1;
    continue;
  }
  samples.sort((a, b) => a - b);
  latencies.push(samples[Math.floor(samples.length / 2)]);
}
latencies.sort((a, b) => a - b);

const p50 = percentile(latencies, 50);
const p95 = percentile(latencies, 95);
const p99 = percentile(latencies, 99);
const max = latencies.length > 0 ? latencies[latencies.length - 1] : NaN;
const pass = latencies.length > 0 && p95 < PERF_TARGET_MS && failedBots.length === 0 && opErrors === 0;

console.log('\n===== 50 机器人延迟压测结果 =====');
console.log(`环境：${url} doc=${fileId}，bots=${botCount}，时长=${durationMs / 1000}s`);
console.log(`ops 总数：${ops.length}（~${(ops.length / (durationMs / 1000)).toFixed(1)} ops/s），写失败=${opErrors}，未被远端观测=${uncovered}`);
console.log(`样本（op 级，接收端中位）：${latencies.length}`);
console.log(
  `P50=${p50.toFixed(1)}ms  P95=${p95.toFixed(1)}ms  P99=${p99.toFixed(1)}ms  MAX=${max.toFixed(1)}ms  （目标 P95 < ${PERF_TARGET_MS}ms）`,
);
console.log(`鉴权失败 bot：${failedBots.length === 0 ? '无' : JSON.stringify(failedBots)}`);
console.log(`结论：${pass ? 'PASS（P95 < 100ms）' : 'FAIL（P95 ≥ 100ms 或存在失败）'}`);

for (const p of bots) p.destroy();
await sleep(300); // 等 destroyer 收尾，防悬挂句柄拖住退出
process.exit(pass ? 0 : 1);
