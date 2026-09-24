import { describe, expect, it } from 'vitest';
import { MAX_DOC_NODES } from '@gmind/shared';
import { nextQuotaBlock, shouldPut } from './saveLoop';

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
