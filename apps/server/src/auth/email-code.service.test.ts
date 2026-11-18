import { beforeEach, describe, expect, it, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { MailService } from '../mail/mail.service';
import { EmailCodeService } from './email-code.service';

/**
 * EmailCodeService 单测（2026-11-12 账号体系重做；2026-11-14 需求方：dev 真发信+万能码并存）：
 * 发码/验码全走 Redis（键与 TTL 逐字对齐简报），MailService 以假 sendMail 注入。
 * ioredis-mock 用法镜像 session.service.test.ts。
 *
 * 2026-11-14 语义：全环境恒随机 6 位码并尝试真实发信；production 发信失败 → 500+解锁。
 * 2026-11-18：dev/test 未配 SMTP 仍容错成功；已配 SMTP 但失败 → 500+解锁、写码供万能码
 * 兜底，前端不倒计时。万能码 env.DEV_MAIL_CODE（默认 '123456'）在**存在存量码**时可作为
 * 通行证（production 不认万能码）；无存量码时万能码无效（防未发码直通）。
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

/** 从 sendMail mock 的调用参数（to, subject, text）里提取 6 位验证码。 */
function lastCode(mail: MailService): string {
  const calls = (mail.sendMail as ReturnType<typeof vi.fn>).mock.calls as unknown as string[][];
  const body = calls.at(-1)![2] ?? '';
  const m = body.match(/\d{6}/);
  if (!m) throw new Error(`sendMail 正文里没有 6 位验证码：${body}`);
  return m[0];
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
  it('issue 后 Redis 写入随机码（EX 600）与 60s 重发锁，不同场景/邮箱互不可见，且真实发信', async () => {
    const { svc, redis, mail } = await makeService();
    await svc.issue('register', 'a@b.dev');
    // 2026-11-14：dev 也恒随机码（不再是 '123456'），真实码经 sendMail 发出
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toMatch(/^\d{6}$/);
    expect(mail.sendMail).toHaveBeenCalledTimes(1);
    expect(lastCode(mail)).toBe(await redis.get(codeKey('register', 'a@b.dev')));
    expect(await redis.ttl(codeKey('register', 'a@b.dev'))).toBeLessThanOrEqual(600);
    expect(await redis.ttl(codeKey('register', 'a@b.dev'))).toBeGreaterThan(0);
    expect(await redis.ttl(waitKey('register', 'a@b.dev'))).toBeLessThanOrEqual(60);
    expect(await redis.ttl(waitKey('register', 'a@b.dev'))).toBeGreaterThan(0);
    expect(await redis.get(codeKey('password_reset', 'a@b.dev'))).toBeNull();
    expect(await redis.get(codeKey('register', 'other@b.dev'))).toBeNull();
  });

  it('dev 未配 SMTP（sendMail false）→ 容错成功，码照常写入', async () => {
    vi.resetModules();
    const real = { ...process.env };
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.SMTP_HOST;
      const { EmailCodeService: DevWithoutSmtp } = await import('./email-code.service');
      const redis = new RedisMock() as unknown as Redis;
      await redis.flushall();
      const mail = { sendMail: vi.fn(async () => false) } as unknown as MailService;
      const svc = new DevWithoutSmtp(redis, mail);

      await svc.issue('register', 'a@b.dev');
      expect(await redis.get(codeKey('register', 'a@b.dev'))).toMatch(/^\d{6}$/);
      expect(mail.sendMail).toHaveBeenCalledTimes(1); // 尝试了发信，但未配置 SMTP 不致命
    } finally {
      process.env = real;
    }
  });

  it('dev 已配 SMTP 但发信失败 → 500、不倒计时所需的重发锁被解除，仍可用本地万能码', async () => {
    vi.resetModules();
    const real = { ...process.env };
    try {
      process.env.NODE_ENV = 'development';
      process.env.SMTP_HOST = 'smtp.gmind.dev';
      process.env.SMTP_PORT = '465';
      process.env.SMTP_USER = 'u';
      process.env.SMTP_PASS = 'p';
      const { EmailCodeService: Dev } = await import('./email-code.service');
      const redis = new RedisMock() as unknown as Redis;
      await redis.flushall();
      const svc = new Dev(redis, { sendMail: vi.fn(async () => false) } as unknown as MailService);

      await expectStatus(
        svc.issue('register', 'dev-failure@b.dev'),
        500,
        '邮件发送失败，请检查 SMTP 配置；本地开发可使用万能验证码 123456',
      );
      expect(await redis.get(waitKey('register', 'dev-failure@b.dev'))).toBeNull();
      expect(await redis.get(codeKey('register', 'dev-failure@b.dev'))).toMatch(/^\d{6}$/);
      await svc.verify('register', 'dev-failure@b.dev', '123456');
      expect(await redis.get(codeKey('register', 'dev-failure@b.dev'))).toBeNull();
    } finally {
      process.env = real;
    }
  });

  it('60s 内二次 issue → 429「验证码发送过于频繁，请 60 秒后再试」', async () => {
    const { svc } = await makeService();
    await svc.issue('register', 'a@b.dev');
    await expectStatus(svc.issue('register', 'a@b.dev'), 429, '验证码发送过于频繁，请 60 秒后再试');
  });

  it('production sendMail false → 500「邮件发送失败…」，重发锁解除、码未写（仅 production 视发信失败为失败）', async () => {
    vi.resetModules();
    const real = { ...process.env };
    try {
      // 满足 production 既有守卫（DEV_SMS_CODE + SMTP 四项）后重放模块
      process.env.NODE_ENV = 'production';
      process.env.DEV_SMS_CODE = 'prod-sms-placeholder';
      process.env.SMTP_HOST = 'smtp.gmind.dev';
      process.env.SMTP_PORT = '25';
      process.env.SMTP_USER = 'u';
      process.env.SMTP_PASS = 'p';
      const { EmailCodeService: Prod } = await import('./email-code.service');
      const redis = new RedisMock() as unknown as Redis;
      await redis.flushall();
      const svc = new Prod(redis, { sendMail: vi.fn(async () => false) } as unknown as MailService);
      await expectStatus(svc.issue('register', 'p@b.dev'), 500, '邮件发送失败，请稍后重试；若持续失败请联系管理员');
      expect(await redis.get(waitKey('register', 'p@b.dev'))).toBeNull();
      expect(await redis.get(codeKey('register', 'p@b.dev'))).toBeNull();
    } finally {
      process.env = real;
    }
  });
});

describe('EmailCodeService.verify（验码）', () => {
  it('真实收到的码通过，且码与失败计数一并删除', async () => {
    const { svc, redis, mail } = await makeService();
    await svc.issue('register', 'a@b.dev');
    const real = lastCode(mail);
    // 先错一次留下计数，验证成功路径连计数一起清
    await expect(svc.verify('register', 'a@b.dev', '000000')).rejects.toThrow();
    await svc.verify('register', 'a@b.dev', real);
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBeNull();
  });

  it('dev 万能码 DEV_MAIL_CODE 在存在存量码时通过（并存语义），码一并删除', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev'); // 存量=随机码
    const stored = await redis.get(codeKey('register', 'a@b.dev'));
    await svc.verify('register', 'a@b.dev', '123456'); // DEV_MAIL_CODE 默认值
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
    expect(stored).not.toBe('123456'); // 确证走的是万能码分支而非巧合命中
  });

  it('dev 无存量码时万能码无效（防未发码直通）', async () => {
    const { svc, redis } = await makeService();
    await redis.set(codeKey('register', 'a@b.dev'), ''); // 模拟键不存在（显式清空）
    await redis.del(codeKey('register', 'a@b.dev'));
    await expectStatus(svc.verify('register', 'a@b.dev', '123456'), 400, '验证码错误或已过期，请重新获取后再试');
  });

  it('production 万能码不被接受：输入 DEV_MAIL_CODE → 400，真实码才通过', async () => {
    vi.resetModules();
    const real = { ...process.env };
    try {
      process.env.NODE_ENV = 'production';
      process.env.DEV_SMS_CODE = 'prod-sms-placeholder';
      process.env.SMTP_HOST = 'smtp.gmind.dev';
      process.env.SMTP_PORT = '25';
      process.env.SMTP_USER = 'u';
      process.env.SMTP_PASS = 'p';
      const { EmailCodeService: Prod } = await import('./email-code.service');
      const redis = new RedisMock() as unknown as Redis;
      await redis.flushall();
      const svc = new Prod(redis, { sendMail: vi.fn(async () => true) } as unknown as MailService);
      await svc.issue('register', 'p@b.dev');
      await expectStatus(svc.verify('register', 'p@b.dev', '123456'), 400, '验证码错误或已过期，请重新获取后再试');
      const realCode = await redis.get(codeKey('register', 'p@b.dev'));
      expect(realCode).toMatch(/^\d{6}$/);
      await svc.verify('register', 'p@b.dev', realCode!);
    } finally {
      process.env = real;
    }
  });

  it('错码 → 400「验证码错误或已过期…」，失败计数 INCR（EX 600）', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    await expectStatus(svc.verify('register', 'a@b.dev', '000000'), 400, '验证码错误或已过期，请重新获取后再试');
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBe('1');
    expect(await redis.ttl(failKey('register', 'a@b.dev'))).toBeGreaterThan(0);
  });

  it('重发新码清空失败计数（Ruling B）：错码后重发，计数归零且万能码可用', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    await expect(svc.verify('register', 'a@b.dev', '000000')).rejects.toThrow();
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBe('1');
    await redis.del(waitKey('register', 'a@b.dev')); // 模拟 60s 重发冷却已过
    await svc.issue('register', 'a@b.dev');
    expect(await redis.get(failKey('register', 'a@b.dev'))).toBeNull();
    await svc.verify('register', 'a@b.dev', '123456'); // 万能码走 dev 分支
  });

  it('连错 5 次后码被删，之后真实码与万能码都 400（防爆破；万能码须有存量码）', async () => {
    const { svc, redis } = await makeService();
    await svc.issue('register', 'a@b.dev');
    for (let i = 0; i < 5; i++) {
      await expect(svc.verify('register', 'a@b.dev', '000000')).rejects.toThrow('验证码错误或已过期，请重新获取后再试');
    }
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
    await expectStatus(svc.verify('register', 'a@b.dev', '123456'), 400, '验证码错误或已过期，请重新获取后再试');
    expect(await redis.get(codeKey('register', 'a@b.dev'))).toBeNull();
  });
});
