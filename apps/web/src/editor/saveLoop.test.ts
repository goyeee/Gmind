import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { markLastEditor } from '@gmind/core';
import { MAX_DOC_NODES } from '@gmind/shared';
import { track } from '../api/events';
import { STALE_DOC_STATUS, nextQuotaBlock, shouldPut, startSaveLoop } from './saveLoop';

// error_occur 埋点直测（评审修复轮 Important #1）：track 走 api/events（真实实现
// 在 node 单测环境因缺 sessionStorage 被 sync catch 静默吞掉），此处 mock 成 spy
// 使 saveLoop 三处 save-fail 生产点可断言。
vi.mock('../api/events', () => ({ track: vi.fn() }));

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
  const handle = startSaveLoop(doc, 'file-1', (s) => statuses.push(s), options);
  return { doc, statuses, stop: () => handle.stop() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.mocked(track).mockClear();
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

  it('409 → 终态文案、dirty=false、不再自动重试（镜像 403 非重试模式）；error_occur save-fail recovered:false 恰一次', async () => {
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
    // 已 mock track，不打 fetch——此处只钉住保存通道本身无重试）
    const docStatePuts = vi
      .mocked(fetch)
      .mock.calls.filter(([p]) => String(p).includes('/doc-state'));
    expect(docStatePuts).toHaveLength(1);

    // 埋点（评审修复轮 Important #1）：409 终态失败上报恰一次，recovered:false
    expect(track).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith('error_occur', { kind: 'save-fail', recovered: false }, 'file-1');
    stop();
    doc.destroy();
  });

  it('重试 1s/2s/4s 耗尽 → error_occur save-fail recovered:false；随后成功收尾 → recovered:true（成对上报）', async () => {
    vi.useFakeTimers();
    // 前 4 次 PUT（防抖首发 + 3 次退避）网络性失败；耗尽分支后的 0ms 立即补存成功收尾
    // （也正是这个补存让本用例确定性终止：成功后不再有新计时，无热循环悬置）
    let calls = 0;
    const { doc, statuses, stop } = await withMockedSave(async () => {
      calls += 1;
      return calls <= 4 ? Promise.reject(new TypeError('网络失败')) : jsonResponse(200, { nodeCount: 1 });
    });

    doc.getMap('m').set('k', 'v');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1000 + 2000 + 4000);
    // 耗尽分支的 finally 0ms 补存计时（恰在推进窗边缘）未被同次推进命中：再推 1ms
    // 触发它——第 5 次 PUT 成功收尾，不再有新计时，用例确定性终止（无热循环悬置）
    await vi.advanceTimersByTimeAsync(1);

    // 耗尽分支的终态文案随后被成功收尾覆盖：先见「保存失败，正在重试」再回「已保存」
    expect(statuses).toContain('保存失败，正在重试');
    expect(statuses.at(-1)).toMatch(/^已保存 /);

    // 埋点（评审修复轮 Important #1）：耗尽失败 recovered:false 与成功恢复 recovered:true
    // 成对到达（离线窗口为 null 的纯重试失败路径）
    expect(track).toHaveBeenCalledWith('error_occur', { kind: 'save-fail', recovered: false }, 'file-1');
    expect(track).toHaveBeenCalledWith('error_occur', { kind: 'save-fail', recovered: true }, 'file-1');
    // 成功收尾后复位：同一循环内不再有挂起的失败待报
    const failCalls = vi.mocked(track).mock.calls.filter(([, p]) => (p as { recovered?: boolean }).recovered === false);
    expect(failCalls).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// 「保存中」置位条件（M7c-E4，需求方 #4「内容没变化不该显示保存中」+ kimi 复验
// P3「打开文档即亮保存中挂满看门狗时长」）：WS 模式下仅 本地用户写（user origin）
// 且事务确有内容变更（tr.changed 非空）才亮；远端同步回声（provider origin）与
// 零变更事务不亮。看门狗同步收紧 6s→4s（回落实测贴 6s 上限）。
// ---------------------------------------------------------------------------

/** WS 模式装配：shouldPutNow=false（服务端持久化接管）、provider 恒已同步。 */
async function withWsSaveLoop(): Promise<{ doc: Y.Doc; statuses: string[]; stop: () => void }> {
  return withMockedSave(async () => jsonResponse(200, { nodeCount: 1 }), {
    collab: { shouldPutNow: () => false, offlineHint: () => null, hasUnsyncedChanges: () => false },
  });
}

describe('startSaveLoop（「保存中」置位条件，M7c-E4）', () => {
  it('远端同步回声（provider origin 事务）→ 不亮「保存中」（初始回放/协同更新无 ack 收尾）', async () => {
    vi.useFakeTimers();
    const { doc, statuses, stop } = await withWsSaveLoop();

    // 任意非 user/system origin（模拟 y-websocket 回声：applyUpdate 的 origin=provider 实例）
    doc.transact(() => {
      doc.getMap('m').set('k', 'v');
    }, 'provider-echo');
    await vi.advanceTimersByTimeAsync(1000);

    expect(statuses).not.toContain('保存中…');
    stop();
    doc.destroy();
  });

  it('user origin 但零变更事务（changed 空集）→ 不亮「保存中」（同值守卫外防线）', async () => {
    vi.useFakeTimers();
    const { doc, statuses, stop } = await withWsSaveLoop();

    doc.transact(() => {}, 'user'); // 空事务：afterTransaction 照发、changed 为空
    await vi.advanceTimersByTimeAsync(1000);

    expect(statuses).not.toContain('保存中…');
    stop();
    doc.destroy();
  });

  it('user origin 有变更 → 亮「保存中」，看门狗 4s 后 provider 无未同步变更 → 回落「已保存」', async () => {
    vi.useFakeTimers();
    const { doc, statuses, stop } = await withWsSaveLoop();

    doc.transact(() => {
      doc.getMap('m').set('k', 'v');
    }, 'user');
    expect(statuses).toContain('保存中…');

    await vi.advanceTimersByTimeAsync(3999);
    expect(statuses.at(-1)).toBe('保存中…');
    await vi.advanceTimersByTimeAsync(1);
    expect(statuses.at(-1)).toMatch(/^已保存 /);
    stop();
    doc.destroy();
  });

  it('看门狗期间 provider 仍有未同步变更 → 不回落（真保存中不误报已保存）', async () => {
    vi.useFakeTimers();
    const { doc, statuses, stop } = await withMockedSave(
      async () => jsonResponse(200, { nodeCount: 1 }),
      {
        collab: {
          shouldPutNow: () => false,
          offlineHint: () => null,
          hasUnsyncedChanges: () => true, // 模拟 ack 未到的真实保存窗口
        },
      },
    );

    doc.transact(() => {
      doc.getMap('m').set('k', 'v');
    }, 'user');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(statuses.at(-1)).toBe('保存中…');
    stop();
    doc.destroy();
  });
});
