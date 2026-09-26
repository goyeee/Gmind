import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { markLastEditor } from '@gmind/core';
import { MAX_DOC_NODES } from '@gmind/shared';
import { STALE_DOC_STATUS, nextQuotaBlock, shouldPut, startSaveLoop } from './saveLoop';

/**
 * 持久化通道真值表单测（M2 Task 3，binding）：
 * - WS 已连接（且曾成功同步）→ false：服务端持久化接管（onStoreDocument 防抖 +
 *   persisted ack），PUT 通道停用；
 * - 从未连接成功 → true：PUT 兜底（REST 或 IndexedDB 路径，M1 语义）；
 * - 曾连接后断开 → true：PUT 尝试兜底 REST。
 */

describe('shouldPut（WS/REST 持久化通道真值表）', () => {
  it('WS 已连接且曾成功同步 → false（服务端持久化接管）', () => {
    expect(shouldPut({ wsConnected: true, wsEverConnected: true })).toBe(false);
  });

  it('从未连接成功 → true（PUT 兜底）', () => {
    expect(shouldPut({ wsConnected: false, wsEverConnected: false })).toBe(true);
  });

  it('曾连接后断开 → true（PUT 尝试兜底 REST）', () => {
    expect(shouldPut({ wsConnected: false, wsEverConnected: true })).toBe(true);
  });

  it('forceFallback → 即使 WS 已连接也强制 PUT', () => {
    expect(
      shouldPut({ wsConnected: true, wsEverConnected: true, forceFallback: true }),
    ).toBe(true);
  });
});

/**
 * WS 路径配额拦截标志机单测（M2 终审修复轮，FR-ACC-003 P0 / M1b 终审裁定）：
 * 超限广播 → 拦截新增；删除解除；拦截中 persisted ack 按可达活跃数复查。
 * e2e 无法经济地构造 501 节点协同文档（裁定记录），客户端拦截行为以本单测钉死。
 */
describe('nextQuotaBlock（WS 路径配额拦截标志机）', () => {
  it("'quota' 广播 → 置拦截（未拦截与已拦截两态均然）", () => {
    expect(nextQuotaBlock(false, { type: 'quota' })).toBe(true);
    expect(nextQuotaBlock(true, { type: 'quota' })).toBe(true);
  });

  it("删除节点 → 解除拦截（用户唯一的主动解除通道）", () => {
    expect(nextQuotaBlock(true, { type: 'deleted' })).toBe(false);
  });

  it("未拦截时 saved（无论计数）→ 维持未拦截（saved 只复查、不设标志）", () => {
    expect(nextQuotaBlock(false, { type: 'saved', aliveCount: MAX_DOC_NODES + 10 })).toBe(false);
    expect(nextQuotaBlock(false, { type: 'saved', aliveCount: 0 })).toBe(false);
  });

  it("拦截中 saved 且可达活跃数 ≤ 上限 → 解除（删除后由 ack 收敛的裁定口径）", () => {
    expect(nextQuotaBlock(true, { type: 'saved', aliveCount: MAX_DOC_NODES })).toBe(false);
    expect(nextQuotaBlock(true, { type: 'saved', aliveCount: MAX_DOC_NODES - 1 })).toBe(false);
  });

  it("拦截中 saved 但仍超限 → 保持拦截（ack 不得解锁）", () => {
    expect(nextQuotaBlock(true, { type: 'saved', aliveCount: MAX_DOC_NODES + 1 })).toBe(true);
  });

  it('拦截状态序贯收敛：quota → 仍超限 ack → 删除 → 解除 → 再 quota（回落限内后可再拦截）', () => {
    let blocked = false;
    blocked = nextQuotaBlock(blocked, { type: 'quota' });
    expect(blocked).toBe(true);
    blocked = nextQuotaBlock(blocked, { type: 'saved', aliveCount: MAX_DOC_NODES + 3 });
    expect(blocked).toBe(true); // 期间 ack 不解锁、不清计数
    blocked = nextQuotaBlock(blocked, { type: 'deleted' });
    expect(blocked).toBe(false);
    blocked = nextQuotaBlock(blocked, { type: 'quota' });
    expect(blocked).toBe(true); // 再次收到 quota 广播（服务端边缘触发回落限内复位后）→ 再拦截
  });
});

// ---------------------------------------------------------------------------
// startSaveLoop 的陈旧写序守卫客户端语义（M3a 准入 7.1，Task 2）：
// - PUT body 携带 baseUpdatedAt（GET/persisted ack 记录的 base；缺省不携带）；
// - 409 是确定性拒绝（快照已陈旧，重试同样陈旧）→ 终态文案、dirty=false、不重试
//   （镜像 403 配额拒绝的非重试模式）。
// 真实 PUT 的接线由 e2e 钉死；这里用 mock fetch 在单测内钉住请求体与收敛行为。
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 2000;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 装配 mock fetch 的保存循环（node 环境无 localStorage，api() 读 token 需打桩）。 */
async function withMockedSave(
  fetchImpl: (path: string, init?: { body?: string }) => Promise<Response>,
  options?: Parameters<typeof startSaveLoop>[3],
): Promise<{ doc: Y.Doc; statuses: string[]; stop: () => void }> {
  vi.stubGlobal('fetch', vi.fn(fetchImpl));
  vi.stubGlobal('localStorage', { getItem: () => 'token', setItem: () => undefined, removeItem: () => undefined });
  const doc = new Y.Doc();
  const statuses: string[] = [];
  const stop = startSaveLoop(doc, 'file-1', (s) => statuses.push(s), options);
  return { doc, statuses, stop };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startSaveLoop（陈旧写序守卫客户端语义）', () => {
  it('PUT body 携带 getBaseUpdatedAt 提供的 baseUpdatedAt（准入 7.1）', async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const { doc, stop } = await withMockedSave(async (_path, init) => {
      bodies.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined);
      return jsonResponse(200, { nodeCount: 1 });
    }, { getBaseUpdatedAt: () => '2026-09-22T01:02:03.456Z' });

    doc.getMap('m').set('k', 'v'); // 任意事务 → 防抖后 PUT
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(bodies[0]).toMatchObject({ baseUpdatedAt: '2026-09-22T01:02:03.456Z' });
    stop();
    doc.destroy();
  });

  it('未提供 getBaseUpdatedAt → PUT body 不带 baseUpdatedAt（旧调用方兼容）', async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const { doc, stop } = await withMockedSave(async (_path, init) => {
      bodies.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined);
      return jsonResponse(200, { nodeCount: 1 });
    });

    doc.getMap('m').set('k', 'v');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(bodies[0]).toHaveProperty('docState');
    expect(bodies[0]).not.toHaveProperty('baseUpdatedAt');
    stop();
    doc.destroy();
  });

  it('409 → 终态文案、dirty=false、不再自动重试（镜像 403 非重试模式）', async () => {
    vi.useFakeTimers();
    const { doc, statuses, stop } = await withMockedSave(async () =>
      jsonResponse(409, { message: STALE_DOC_STATUS }),
    );

    doc.getMap('m').set('k', 'v');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // 第一次 PUT（409）
    // 超过 1s/2s/4s 全部退避窗：不得有任何重试请求
    await vi.advanceTimersByTimeAsync(10_000);

    expect(statuses.at(-1)).toBe(STALE_DOC_STATUS);
    // 仅一次 doc-state PUT（M5 Task 4 起 409 另发一条 error_occur 埋点 POST /api/events，
    // 非浏览器单测环境该埋点静默失败不打 fetch——此处只钉住保存通道本身无重试）
    const docStatePuts = vi
      .mocked(fetch)
      .mock.calls.filter(([p]) => String(p).includes('/doc-state'));
    expect(docStatePuts).toHaveLength(1);
    stop();
    doc.destroy();
  });
});

describe('startSaveLoop（last_editor 补报，M3a Task 4）', () => {
  it('PUT body 携带 doc meta 的 lastEditorUserId（离线兜底补报）', async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const { doc, stop } = await withMockedSave(async (_path, init) => {
      bodies.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined);
      return jsonResponse(200, { nodeCount: 1 });
    });

    markLastEditor(doc, 'USER_A');
    doc.getMap('m').set('k', 'v');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(bodies[0]).toMatchObject({ lastEditorUserId: 'USER_A' });
    stop();
    doc.destroy();
  });

  it('doc 无 lastEditorUserId → PUT body 不带该字段（旧调用方兼容）', async () => {
    vi.useFakeTimers();
    const bodies: Array<Record<string, unknown> | undefined> = [];
    const { doc, stop } = await withMockedSave(async (_path, init) => {
      bodies.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined);
      return jsonResponse(200, { nodeCount: 1 });
    });

    doc.getMap('m').set('k', 'v');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(bodies[0]).not.toHaveProperty('lastEditorUserId');
    stop();
    doc.destroy();
  });
});
