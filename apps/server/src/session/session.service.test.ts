import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { DAY, MAX_SESSIONS, SessionService } from './session.service';

async function makeService(): Promise<{ svc: SessionService; redis: Redis }> {
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock 的数据在同一模块域内的所有实例间共享，先清空以保证用例间隔离
  await redis.flushall();
  return { svc: new SessionService(redis), redis };
}

beforeEach(() => {
  // 恢复真实时钟，避免上一用例的 fake Date 泄漏到 ioredis-mock 内部
  vi.useRealTimers();
});

describe('SessionService', () => {
  it('create 后可 validate 出 userId', async () => {
    const { svc } = await makeService();
    const { token } = await svc.create('u1', false);
    const data = await svc.validate(token);
    expect(data?.userId).toBe('u1');
  });

  it('rememberMe 时 expiresAt 为 30 天，否则 7 天（FR-ACC-002）', async () => {
    // 冻结时钟：真实时钟下两次 create 跨毫秒会使 expiresAt 差值漂移 ±1ms，断言偶发失败
    vi.useFakeTimers({ toFake: ['Date'] });
    const { svc } = await makeService();
    const short = await svc.create('u1', false);
    const long = await svc.create('u1', true);
    expect(long.expiresAt - short.expiresAt).toBe(23 * DAY * 1000);
  });

  it(`第 ${MAX_SESSIONS + 1} 个会话踢除最早会话`, async () => {
    // 冻结并步进时钟：同一毫秒创建的会话 ZSET 分数并列，"最早"排序不确定
    vi.useFakeTimers({ toFake: ['Date'] });
    const { svc } = await makeService();
    const tokens: string[] = [];
    const base = 1_700_000_000_000;
    for (let i = 0; i < MAX_SESSIONS + 1; i++) {
      vi.setSystemTime(base + i * 1000);
      tokens.push((await svc.create('u1', false)).token);
    }
    expect(await svc.validate(tokens[0])).toBeNull();
    expect(await svc.validate(tokens[1])).not.toBeNull();
    expect(await svc.validate(tokens[MAX_SESSIONS])).not.toBeNull();
  });

  it('revoke 后 validate 返回 null', async () => {
    const { svc } = await makeService();
    const { token } = await svc.create('u1', false);
    await svc.revoke(token);
    expect(await svc.validate(token)).toBeNull();
  });

  it('无效 token 返回 null', async () => {
    const { svc } = await makeService();
    expect(await svc.validate('not-exist')).toBeNull();
  });
});
