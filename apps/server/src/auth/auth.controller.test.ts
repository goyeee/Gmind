import { describe, expect, it, vi } from 'vitest';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import type { EmailCodeService } from './email-code.service';
import type { SessionService } from '../session/session.service';
import type { UsersService } from '../users/users.service';

/**
 * AuthController email-code 端点单测（2026-11-12 账号体系重做）：发码前的存在性闸
 * 钉在 controller（简报裁定）——scene=register 且邮箱已注册 → 409；scene=password_reset
 * 且邮箱未注册 → 404；两文案逐字。email_bind 无存在性前置（换绑场景由会话+密码核身
 * 把关）。邮箱归一由 shared emailCodeRequestSchema 单点承担（trim+lowercase）。
 */

/** 断言 rejects 的异常体：文案逐字 + HTTP 状态码（镜像 email-code.service.test.ts）。 */
async function expectStatus(promise: Promise<unknown>, status: number, message: string): Promise<void> {
  const err: { getStatus?: () => number; message?: string } = await promise.then(
    () => {
      throw new Error(`应当抛出 ${status}，却正常完成`);
    },
    (e: unknown) => e as { getStatus?: () => number; message?: string },
  );
  expect(err.message).toBe(message);
  expect(err.getStatus?.()).toBe(status);
}

function makeController(registered: boolean) {
  const users = { findByEmail: vi.fn(async () => (registered ? { id: 'u1' } : null)) };
  const emailCode = { issue: vi.fn(async () => undefined) };
  const controller = new AuthController(
    {} as AuthService,
    users as unknown as UsersService,
    emailCode as unknown as EmailCodeService,
    {} as SessionService,
  );
  return { controller, users, emailCode };
}

describe('POST /api/auth/email-code：发码前存在性闸', () => {
  it('scene=register 且邮箱已注册 → 409「该邮箱已注册，请直接登录或换用其他邮箱」，不发码', async () => {
    const { controller, emailCode } = makeController(true);
    await expectStatus(
      controller.issueEmailCode({ scene: 'register', email: 'a@x.dev' }),
      409,
      '该邮箱已注册，请直接登录或换用其他邮箱',
    );
    expect(emailCode.issue).not.toHaveBeenCalled();
  });

  it('scene=password_reset 且邮箱未注册 → 404「该邮箱尚未注册，请确认后重试或先注册」，不发码', async () => {
    const { controller, emailCode } = makeController(false);
    await expectStatus(
      controller.issueEmailCode({ scene: 'password_reset', email: 'nope@x.dev' }),
      404,
      '该邮箱尚未注册，请确认后重试或先注册',
    );
    expect(emailCode.issue).not.toHaveBeenCalled();
  });

  it('scene=register 且邮箱空闲 → 正常发码，email 经 schema 单点归一（trim+lowercase）', async () => {
    const { controller, emailCode } = makeController(false);
    await controller.issueEmailCode({ scene: 'register', email: ' A@X.com ' });
    expect(emailCode.issue).toHaveBeenCalledWith('register', 'a@x.com');
  });

  it('scene=password_reset 且已注册 → 正常发码', async () => {
    const { controller, emailCode } = makeController(true);
    await controller.issueEmailCode({ scene: 'password_reset', email: 'a@x.dev' });
    expect(emailCode.issue).toHaveBeenCalledWith('password_reset', 'a@x.dev');
  });

  it('scene=email_bind 无存在性前置（findByEmail 不触达），径直发码', async () => {
    const { controller, users, emailCode } = makeController(true);
    await controller.issueEmailCode({ scene: 'email_bind', email: 'bound@x.dev' });
    expect(users.findByEmail).not.toHaveBeenCalled();
    expect(emailCode.issue).toHaveBeenCalledWith('email_bind', 'bound@x.dev');
  });
});
