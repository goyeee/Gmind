import { expect, test, type Page } from '@playwright/test';

/**
 * 500 节点编辑器性能压测（NFR-PERF-001/003）— M1b Task 13。
 *
 * **非 CI 门**：本地验证工具，仅 `PERF=1` 时运行（`pnpm --filter @gmind/web exec playwright test perf-editor.spec.ts`），
 * 结果记录于 docs/perf-m1.md；发布验收时需在 spec §6.1.1 基准机重跑。
 *
 * 流程（裁决：页面上下文内用 @gmind/core 直接构 doc，不经服务端测试辅助）：
 *  1. 注册登录（复用 editor spec 模式）→ 页面内 fetch POST /api/files 建空白文件 → 打开编辑器；
 *  2. EditorPage 在 dev 构建暴露 `window.__gmind.getDoc()`（import.meta.env.DEV 剔除）；
 *     页面上下文动态 import('/@id/@gmind/core')（vite dev 的 bare-id 路由）复用页面同一模块实例；
 *  3. outlineToSpec + insertSpec 写入 499 个节点（+root = 500，服务端 MAX_DOC_NODES 口径
 *     countNodes 含 root；编辑器脚标口径 countAlive 不含 root）→ 等待「已保存」；
 *  4. 连续 30s 混合编辑脚本（i%4：addChild / deleteNodes / setText / moveNode，均 ORIGIN_USER），
 *     每操作 performance.now 包裹「操作 → 下一帧」（含 doc update → rAF 内 layout+renderScene
 *     完整管线）；rAF 时间戳按 1s 窗口统计 FPS；
 *  5. 断言：中位 FPS ≥ 40（NFR-PERF-001）、操作延迟 P95 < 100ms（NFR-PERF-003）、操作零失败。
 *
 * 已知口径边界：连续编辑期间事务间隔 < 2s 防抖，保存循环不发起 PUT；混合增删产生墓碑使
 * nodes.size 超 500 上限，停止后的一次落库会被服务端 403 拒绝（QuotaError）——属预期，
 * 压测目标是渲染/编辑管线性能而非持久化（见 docs/perf-m1.md）。
 */

test.skip(!process.env.PERF, '需 PERF=1：本地性能验证工具，非 CI 门');

/** 写入节点数：+root 后 nodes.size 恰为服务端 500 上限（FR-ACC-003）。 */
const NODE_COUNT = 499;
/** 连续编辑时长（裁决：~30s）。 */
const RUN_MS = 30_000;
/** NFR-PERF-001：500 节点连续编辑中位 FPS 下限。 */
const MIN_MEDIAN_FPS = 40;
/** NFR-PERF-003：单人操作响应 P95 上限（ms）。 */
const MAX_OP_P95_MS = 100;

/** 页面内 Y.Doc 的不透明占位（方法全走 PerfCore，脚本不经手 Yjs API）。 */
interface PerfDoc {
  _opaque: string;
}

/** 压测用到的 @gmind/core 表面（结构化最小类型，避免 Node 侧解析 workspace TS 源码包）。 */
interface PerfCore {
  ROOT_NODE_ID: string;
  ORIGIN_USER: string;
  outlineToSpec(text: string): { text: string; children: unknown[] }[];
  insertSpec(doc: PerfDoc, parentId: string, index: number, spec: unknown, origin: string): string[];
  withTransaction<T>(doc: PerfDoc, origin: string, fn: () => T): T;
  docToState(doc: PerfDoc): Uint8Array;
  addChild(doc: PerfDoc, parentId: string, opts: { text?: string }, origin: string): string;
  deleteNodes(doc: PerfDoc, ids: string[], origin: string): void;
  setText(doc: PerfDoc, id: string, text: string, origin: string): void;
  moveNode(doc: PerfDoc, id: string, newParentId: string, index: number | undefined, origin: string): void;
  countAlive(doc: PerfDoc): number;
  countNodes(doc: PerfDoc): number;
  isAlive(doc: PerfDoc, id: string): boolean;
}

/** 页面钩子形态（EditorPage dev-only 副作用写入）。 */
interface GmindWindowHook {
  getDoc: () => PerfDoc;
}

interface BuildResult {
  total: number;
  alive: number;
  stateB64Bytes: number;
}

interface PerfMetrics {
  ops: number;
  failures: number;
  durationMs: number;
  fpsWindows: number[];
  latencies: number[];
  aliveAfter: number;
}

/** 登录 helper（内联自 editor.e2e.spec.ts 同款模式）。 */
async function registerAndLogin(page: Page): Promise<void> {
  await page.goto('/login');
  const phone = '138' + String(Math.floor(10000000 + Math.random() * 89999999));
  await page.getByPlaceholder('手机号').fill(phone);
  await page.getByPlaceholder('验证码（开发环境固定 123456）').fill('123456');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace/);
  await expect(page.locator('.file-list li')).toHaveCount(3);
}

/** 页面上下文内建空白文件（Bearer 取自 localStorage，同 api client 口径）。 */
async function createFileViaApi(page: Page, title: string): Promise<string> {
  return page.evaluate(async (t: string) => {
    const token = localStorage.getItem('gmind.token') ?? '';
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: t }),
    });
    if (!res.ok) throw new Error(`建文件失败（${res.status}）`);
    const data = (await res.json()) as { id: string };
    return data.id;
  }, title);
}

/** 生成 499 节点缩进大纲：20 分支 ×（1 分支头 + 23 子项 + 1 孙项），守卫截断到 NODE_COUNT。 */
function buildOutline(): string {
  const lines: string[] = [];
  let n = 0;
  for (let b = 1; n < NODE_COUNT; b += 1) {
    lines.push(`分支 ${b}`);
    n += 1;
    for (let k = 1; k <= 23 && n < NODE_COUNT; k += 1) {
      lines.push(`\t子项 ${b}-${k}`);
      n += 1;
    }
    if (n < NODE_COUNT) {
      lines.push(`\t\t孙项 ${b}`);
      n += 1;
    }
  }
  return lines.join('\n');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)] ?? Number.POSITIVE_INFINITY;
}

test('perf：500 节点连续编辑 30s —— 中位 FPS ≥ 40 且操作 P95 < 100ms', async ({ page }) => {
  test.setTimeout(240_000);

  await registerAndLogin(page);
  const fileId = await createFileViaApi(page, 'perf-500');
  await page.goto(`/edit/${fileId}`);
  await expect(page.locator('.editor-canvas svg .gm-text')).toHaveCount(1); // 空 doc 仅 root

  // 等 dev 钩子就绪（doc 装载完成后 EditorPage 副作用写入）
  await page.waitForFunction(
    () => Boolean((window as unknown as { __gmind?: GmindWindowHook }).__gmind),
  );

  // —— 建 500 节点文档（页面上下文内 @gmind/core 直写 doc，触发既有渲染管线）——
  // 单事务包裹（一次 doc update / 一次重渲染调度，也与 bench.test.ts 的组合原子用法一致）
  const built = await page.evaluate(async (outline: string): Promise<BuildResult> => {
    const bare = ['/@id/', '@gmind/core'].join(''); // 动态拼串：vite dev 的 bare-id 路由
    const core = (await import(bare)) as unknown as PerfCore;
    const hook = (window as unknown as { __gmind?: GmindWindowHook }).__gmind;
    if (!hook) throw new Error('window.__gmind 未就绪');
    const doc = hook.getDoc();
    core.withTransaction(doc, core.ORIGIN_USER, () => {
      core.insertSpec(doc, core.ROOT_NODE_ID, 0, core.outlineToSpec(outline), core.ORIGIN_USER);
    });
    const state = core.docToState(doc);
    return {
      total: core.countNodes(doc),
      alive: core.countAlive(doc),
      stateB64Bytes: Math.ceil(state.byteLength / 3) * 4, // toBase64 后体积（PUT body 主体）
    };
  }, buildOutline());
  console.log(`[perf] 建图：alive=${built.alive} total(含root)=${built.total} docState(b64)≈${built.stateB64Bytes}B`);
  expect(built.total, '服务端上限口径（含 root）恰为 500').toBe(500);
  expect(built.alive, '编辑器脚标口径（不含 root）').toBe(NODE_COUNT);

  // 初次落库结果只记录不强断言：满额 docState(b64)≈110KB，在 JSON body 限 100KB 的
  // 服务端（main.ts 限宽修复前启动的进程）会 413 →「保存失败，正在重试」；修复后的
  // 服务端则为「已保存」。压测目标是渲染/编辑管线，两种起点下 FPS/延迟口径一致。
  await expect(page.getByTestId('save-status')).toHaveText(/已保存|保存失败，正在重试/, {
    timeout: 15_000,
  });
  const savedOutcome = await page.getByTestId('save-status').textContent();
  console.log(`[perf] 首存结果：${savedOutcome}（docState(b64)≈${built.stateB64Bytes}B）`);
  await expect(page.getByTestId('node-count')).toHaveText(`${NODE_COUNT} 节点`);

  // 适应画布（用户打开大图的现实起点），稍候渲染稳定
  await page.getByTestId('fit-btn').click();
  await page.waitForTimeout(500);

  // —— 30s 混合编辑脚本：i%4 轮转 增/删/改文本/移动，每操作包「操作 → 下一帧」——
  const metrics = await page.evaluate(
    async ({ durationMs }: { durationMs: number }): Promise<PerfMetrics> => {
      const bare = ['/@id/', '@gmind/core'].join('');
      const core = (await import(bare)) as unknown as PerfCore;
      const hook = (window as unknown as { __gmind?: GmindWindowHook }).__gmind;
      if (!hook) throw new Error('window.__gmind 未就绪');
      const doc = hook.getDoc();
      const alive = (id: string): boolean => core.isAlive(doc, id);

      const pool: string[] = [core.ROOT_NODE_ID]; // 父候选（含历史节点，alive 校验兜底）
      const added: string[] = []; // 近期新增（LIFO 删除候选）
      const latencies: number[] = [];
      let ops = 0;
      let failures = 0;

      // FPS 采样：rAF 帧时间戳全量记录，事后按 1s 窗口统计
      const stamps: number[] = [];
      let sampling = true;
      const sample = (t: number): void => {
        stamps.push(t);
        if (sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);

      const startedAt = performance.now();
      const deadline = startedAt + durationMs;
      let i = 0;
      while (performance.now() < deadline) {
        const t0 = performance.now();
        const kind = i % 4;
        try {
          if (kind === 0) {
            // 增：确定性伪随机父（走 pool 轮转）
            const parent = pool[(i * 13) % pool.length] as string;
            const id = core.addChild(
              doc,
              alive(parent) ? parent : core.ROOT_NODE_ID,
              { text: `压测 ${i}` },
              core.ORIGIN_USER,
            );
            added.push(id);
            pool.push(id);
          } else if (kind === 1) {
            // 删：最近新增的存活叶
            let victim = added.pop();
            while (victim !== undefined && !alive(victim)) victim = added.pop();
            if (victim !== undefined) core.deleteNodes(doc, [victim], core.ORIGIN_USER);
          } else if (kind === 2) {
            // 改文本：短字符串（目标命中失效则退回 root）
            const id = pool[(i * 7) % pool.length] as string;
            core.setText(doc, alive(id) ? id : core.ROOT_NODE_ID, `改写 ${i % 97}`, core.ORIGIN_USER);
          } else {
            // 移动：存活候选换父到 root
            const id = pool[(i * 11) % pool.length] as string;
            if (id !== core.ROOT_NODE_ID && alive(id)) {
              core.moveNode(doc, id, core.ROOT_NODE_ID, undefined, core.ORIGIN_USER);
            }
          }
          ops += 1;
        } catch {
          failures += 1;
        }
        i += 1;
        // 每操作等一帧：渲染管线的 rAF 回调（先注册）先于本回调执行，
        // 故该延迟覆盖 op → layout + renderScene 完整管线
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        latencies.push(performance.now() - t0);
      }
      const endedAt = performance.now();
      sampling = false;

      const fpsWindows: number[] = [];
      let cursor = 0;
      for (let w = startedAt; w + 1000 <= endedAt; w += 1000) {
        let frames = 0;
        for (; cursor < stamps.length && (stamps[cursor] as number) < w + 1000; cursor += 1) {
          if ((stamps[cursor] as number) >= w) frames += 1;
        }
        fpsWindows.push(frames);
      }

      return {
        ops,
        failures,
        durationMs: Math.round(endedAt - startedAt),
        fpsWindows,
        latencies,
        aliveAfter: core.countAlive(doc),
      };
    },
    { durationMs: RUN_MS },
  );

  const medianFps = median(metrics.fpsWindows);
  const p95Ms = p95(metrics.latencies);
  const medMs = median(metrics.latencies);
  console.log(
    `[perf] 500节点 连续编辑 ${metrics.durationMs}ms：` +
      `中位FPS=${medianFps.toFixed(1)} 窗口FPS=[${metrics.fpsWindows.join(',')}] ` +
      `操作数=${metrics.ops} 失败=${metrics.failures} 存活节点=${metrics.aliveAfter} | ` +
      `操作延迟 P50=${medMs.toFixed(1)}ms P95=${p95Ms.toFixed(1)}ms`,
  );

  expect(metrics.failures, '压测操作零失败').toBe(0);
  expect(
    medianFps,
    `NFR-PERF-001：中位 FPS ≥ ${MIN_MEDIAN_FPS}（实测 ${medianFps.toFixed(1)}）`,
  ).toBeGreaterThanOrEqual(MIN_MEDIAN_FPS);
  expect(
    p95Ms,
    `NFR-PERF-003：操作延迟 P95 < ${MAX_OP_P95_MS}ms（实测 ${p95Ms.toFixed(1)}ms）`,
  ).toBeLessThan(MAX_OP_P95_MS);
});
