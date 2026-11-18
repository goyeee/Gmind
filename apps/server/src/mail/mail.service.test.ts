import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service';

/**
 * MailService 传输层单测 — M3b Task 5（FR-SHR-004 邀请邮件接线 nodemailer）。
 *
 * 口径（M3a Task 7 裁定延续）：SMTP_HOST 缺省 → transport null → 仅 log 不发送；
 * 配置后经 nodemailer 明文 SMTP；sendMail 永不抛错（邮件为尽力而为旁路）。
 * 2026-11-12 账号体系重做追加：transport auth（SMTP_USER/PASS）与 from（SMTP_FROM）断言，
 * 动态 import 重放模块顶层（env 为模块单例），用例结束整体还原 process.env。
 */
const REAL_ENV = { ...process.env };
describe('MailService（SMTP 传输层）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('SMTP 未配置：sendMail 仅 log 不发送，返回 false', async () => {
    const svc = new MailService();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(svc.sendMail('a@b.dev', 'subject', 'body')).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();
  });

  it('SMTP 已配置（transport 就绪）：sendMail 经 nodemailer 发送 from/to/subject/text，返回 true', async () => {
    const svc = new MailService();
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'm1' });
    (svc as unknown as { transport: unknown }).transport = { sendMail };
    await expect(svc.sendMail('a@b.dev', '邀请', '正文')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledWith({
      from: expect.any(String),
      to: 'a@b.dev',
      subject: '邀请',
      text: '正文',
    });
  });

  it('SMTP 发送抛错：吞掉异常返回 false，不波及调用方主流程', async () => {
    const svc = new MailService();
    (svc as unknown as { transport: unknown }).transport = {
      sendMail: vi.fn().mockRejectedValue(new Error('smtp down')),
    };
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(svc.sendMail('a@b.dev', 's', 'b')).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});

describe('MailService（e2e 测试域名发信闸，2026-11-18 发件额度事故防线）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...REAL_ENV };
  });

  /** 按当前 process.env 重放模块构造，再把 transport 换成 spy（断言是否真发）。 */
  async function makeSpiedService(): Promise<{ svc: MailService; sendMail: ReturnType<typeof vi.fn> }> {
    vi.resetModules();
    const { MailService: Reloaded } = await import('./mail.service');
    const svc = new Reloaded();
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'm1' });
    (svc as unknown as { transport: unknown }).transport = { sendMail };
    return { svc, sendMail };
  }

  it('非生产 + e2e 测试域名：只 log 不真发（即使 SMTP 已配置），返回 false 走 dev 容错', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    const { svc, sendMail } = await makeSpiedService();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(svc.sendMail('e2e-abc@e2e.gmind.dev', '验证码', '正文')).resolves.toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
  });

  it('非生产 + 真实邮箱域名：不受影响照常发送', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    const { svc, sendMail } = await makeSpiedService();
    await expect(svc.sendMail('someone@163.com', '验证码', '正文')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('生产环境不设此闸：e2e 域名也按正常流程发送（防误伤真实语义）', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DEV_SMS_CODE = 'prod-test-only-random-code'; // env 生产启动守卫要求显式配置
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_USER = 'mailer@gmind.dev'; // 生产守卫要求 SMTP 认证齐备（仅构造校验，不真连）
    process.env.SMTP_PASS = 'secret';
    process.env.SMTP_PORT = '25';
    const { svc, sendMail } = await makeSpiedService();
    await expect(svc.sendMail('e2e-abc@e2e.gmind.dev', '验证码', '正文')).resolves.toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('MailService（SMTP 认证与发件人，2026-11-12 账号体系重做）', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...REAL_ENV };
  });

  /** resetModules 后按当前 process.env 重放 env/mail 模块，构造真实 transport。 */
  async function makeServiceWithRealTransport(): Promise<MailService> {
    vi.resetModules();
    const { MailService: Reloaded } = await import('./mail.service');
    return new Reloaded();
  }

  function transportOptions(svc: MailService): { auth?: unknown } {
    return (svc as unknown as { transport: { options: { auth?: unknown } } }).transport.options;
  }

  it('SMTP_USER/PASS 已配置：transport 携带 auth', async () => {
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    process.env.SMTP_USER = 'mailer@gmind.dev';
    process.env.SMTP_PASS = 'secret';
    const svc = await makeServiceWithRealTransport();
    expect(transportOptions(svc).auth).toEqual({ user: 'mailer@gmind.dev', pass: 'secret' });
  });

  it('SMTP_USER/PASS 未配置：transport 不带 auth（匿名连接，本地 MailHog 同款）', async () => {
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    const svc = await makeServiceWithRealTransport();
    expect(transportOptions(svc).auth).toBeUndefined();
  });

  it('from 取 env.SMTP_FROM，缺省维持「Gmind <noreply@gmind.local>」', async () => {
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    delete process.env.SMTP_FROM;
    const svc = await makeServiceWithRealTransport();
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'm1' });
    (svc as unknown as { transport: unknown }).transport = { sendMail };
    await svc.sendMail('a@b.dev', 's', 'b');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Gmind <noreply@gmind.local>' }),
    );
  });

  it('from 可被 SMTP_FROM 覆写', async () => {
    process.env.SMTP_HOST = 'smtp.gmind.dev';
    process.env.SMTP_PORT = '25';
    process.env.SMTP_FROM = 'Gmind <hi@gmind.dev>';
    const svc = await makeServiceWithRealTransport();
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'm1' });
    (svc as unknown as { transport: unknown }).transport = { sendMail };
    await svc.sendMail('a@b.dev', 's', 'b');
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'Gmind <hi@gmind.dev>' }),
    );
  });
});
