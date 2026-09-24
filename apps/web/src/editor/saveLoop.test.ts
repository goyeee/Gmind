import { describe, expect, it } from 'vitest';
import { shouldPut } from './saveLoop';

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
