import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { MailService } from '../mail/mail.service';
import { EmailCodeService } from './email-code.service';

/**
 * EmailCodeService 单测（2026-11-12 账号体系重做）：发码/验码全走 Redis（键与 TTL 逐字
 * 对齐简报），MailService 以假 sendMail 注入。ioredis-mock 用法镜像 session.service.test.ts。
 */

const codeKey = (scene: string, email: string) => `email_code:${scene}:${email}`;
const waitKey = (scene: string, email: string) => `email_code_wait:${scene}:${email}`;
const failKey = (scene: string, email: string) => `email_code_fail:${scene}:${email}`;

async function makeService(sendMail: (...args: unknown[]) => Promise<boolean> = async () => true) {
  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock 的数据在同一模块域内的所有实例间共享，先清空以保证用例间隔离
  await redis.flushall();
  const mail = { sendMail: vi.fn(sendMail) } as unknown as MailService;
  return { svc: new EmailCodeService(redis, mail), redis, mail };
}

/** 断言 rejects 的异常体：文案逐字 + HTTP 状态码。 */
async function expectStatus(promise: Promise<void>, status: number, message: string): Promise<void> {
  const err: { getStatus?: () => number; message?: string } = await promise.then(
    () => {
      throw new Error(`应当抛出 ${status}，却正常完成`);
    },
    (e: unknown) => e as { getStatus?: () => number; message?: string },
  );
  expect(err.message).toBe(message);
  expect(err.getStatus?.()).toBe(status);
}

beforeEach(() => {
  // 恢复真实时钟，避免其他测试文件的 fake Date 泄漏进 ioredis-mock
  vi.useRealTimers();
});

describe('EmailCodeService.issue（发码）', () => {
  it('issue 后 Redis 写入码（EX 600）与 60s 重发锁，且不同场景/邮箱互不可见', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    // dev（NODE_ENV 默认 development）恒用 DEV_MAIL_CODE 默认值 '123456'
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBe('123456');
    expect(await redis.ttl(codeKey('register', 'a@b.dev'))).toBeLessThanOrEqual(600);
    expect(await redis.ttl(codeKey('register', 'a@b.dev'))).toBeGreaterThan(0);
    expect(await redis.ttl(waitKey('register', 'a@b.dev'))).toBeLessThanOrEqual(60);
    expect(await redis.ttl(waitKey('register', 'a@b.dev'))).toBeGreaterThan(0);
    expect(await redis.get(codeKey('password_reset', 'a@b.dev'))).toBeNull();
    expect(await redis.get(codeKey('register', 'other@b.dev'))).toBeNull();
  });

  it('60s 内二次 issue → 429「验证码发送过于频繁，请 60 秒后再试」', async () => {
    const { svc } = await makeService();
    await svc.issue('register', 'a@b.dev');
    await expectStatus(svc.issue('register', 'a@b.dev'), 429, '验证码发送过于频繁，请 60 秒后再试');
  });

  it('sendMail 返回 false → 500「邮件发送失败…」，且重发锁解除（可立即重试）、码未写入', async () => {
    const { svc, redis, mail } = await makeService(async () => false);
    await expectStatus(svc.issue('register', 'a@b.dev'), 500, '邮件发送失败，请稍后重试；若持续失败请联系管理员');
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(await redis.get(waitKey('register', 'a@b.dev'))).toBeNull();
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
  });

  it('production 忽略 DEV_MAIL_CODE，恒发随机 6 位数字码', async () => {
    vi.resetModules();
    const real = { ...process.env };
    try {
      // 满足 production 既有守卫（DEV_SMS_CODE + SMTP 四项），再设 DEV_MAIL_CODE 验证忽略
      process.env.NODE_ENV = 'production';
      process.env.DEV_SMS_CODE = 'prod-sms-placeholder';
      process.env.SMTP_HOST = 'smtp.gmind.dev';
      process.env.SMTP_PORT = '25';
      process.env.SMTP_USER = 'u';
      process.env.SMTP_PASS = 'p';
      process.env.DEV_MAIL_CODE = '999999';
      const { EmailCodeService: Prod } = await import('./email-code.service');
      const redis = new RedisMock() as unknown as Redis;
      await redis.flushall();
      const svc = new Prod(redis, { sendMail: vi.fn(async () => true) } as unknown as MailService);
      await svc.issue('register', 'p@b.dev');
      const code = await redis.get(codeKey('register', 'p@b.dev'));
      expect(code).toMatch(/^\d{6}$/);
      expect(code).not.toBe('999999');
    } finally {
      process.env = real;
    }
  });
});

describe('EmailCodeService.verify（验码）', () => {
  it('正确码通过，且码与失败计数一并删除', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    // 先错一次留下计数，验证成功路径连计数一起清
    await expect(svc.verify('register', 'a@b.dev', '000000')).rejects.toThrow();
    await svc.verify('register', 'a@b.dev', '123456');
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBeNull();
  });

  it('错码 → 400「验证码错误或已过期…」，失败计数 INCR（EX 600）', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    await expectStatus(svc.verify('register', 'a@b.dev', '000000'), 400, '验证码错误或已过期，请重新获取后再试');
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBe('1');
    expect(await redis.ttl(failKey('register', 'a@b.dev'))).toBeGreaterThan(0);
  });

  it('连错 5 次后码被删，之后正确码也 400（防爆破）', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    for (let i = 0; i < 5; i++) {
      await expect(svc.verify('register', 'a@b.dev', '000000')).rejects.toThrow('验证码错误或已过期，请重新获取后再试');
    }
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
    await expectStatus(svc.verify('register', 'a@b.dev', '123456'), 400, '验证码错误或已过期，请重新获取后再试');
  });
});
