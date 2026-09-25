import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailService } from './mail.service';

/**
 * MailService 传输层单测 — M3b Task 5（FR-SHR-004 邀请邮件接线 nodemailer）。
 *
 * 口径（M3a Task 7 裁定延续）：SMTP_HOST 缺省 → transport null → 仅 log 不发送；
 * 配置后经 nodemailer 明文 SMTP；sendMail 永不抛错（邮件为尽力而为旁路）。
 */
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
