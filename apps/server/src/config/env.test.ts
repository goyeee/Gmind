import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * env 生产守卫单测（2026-11-12 账号体系重做）：SMTP 四项 fail-closed。
 * env.ts 在模块加载时 parse + 守卫，故每用例 vi.resetModules + 改写 process.env 后
 * 动态 import 重放模块顶层逻辑；用例结束整体还原 process.env，防泄漏到其他测试。
 */
const REAL_ENV = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('env 生产守卫（SMTP fail-closed）', () => {
  beforeEach(() => {
    vi.resetModules();
    // production 基线：先满足既有 DEV_SMS_CODE 守卫，避免混淆本守卫的断言
    setEnv({ NODE_ENV: 'production', DEV_SMS_CODE: 'prod-sms-placeholder' });
  });

  afterEach(() => {
    process.env = { ...REAL_ENV };
  });

  it('production 缺 SMTP_HOST：拒绝启动', async () => {
    setEnv({ SMTP_HOST: undefined, SMTP_PORT: '25', SMTP_USER: 'u', SMTP_PASS: 'p' });
    await expect(import('./env')).rejects.toThrow(/SMTP_HOST/);
  });

  it('production 缺 SMTP_USER：拒绝启动', async () => {
    setEnv({ SMTP_HOST: 'smtp.gmind.dev', SMTP_PORT: '25', SMTP_USER: undefined, SMTP_PASS: 'p' });
    await expect(import('./env')).rejects.toThrow(/SMTP_USER/);
  });

  it('production SMTP 四项齐备：正常启动', async () => {
    setEnv({ SMTP_HOST: 'smtp.gmind.dev', SMTP_PORT: '25', SMTP_USER: 'u', SMTP_PASS: 'p' });
    await expect(import('./env')).resolves.toBeTruthy();
  });
});
