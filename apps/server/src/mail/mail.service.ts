import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * 邮件发送服务（M3a Task 7 裁定，FR-FIL-010）：SMTP 经 env 可配（SMTP_HOST/SMTP_PORT）。
 *
 * M0 裁定：MailHog 容器未起（镜像不可得）→ 当前默认无 SMTP 配置，sendMail 仅 log 不发送，
 * 调用方（CleanupService、InviteService 等）照常走主流程（「无 SMTP 仅通知不 crash」）。
 * M3b Task 5 接通传输层：SMTP_HOST 缺省 → transport null → 仅 log；配置后经 nodemailer。
 * 端口 465 使用隐式 SSL；其他端口保持 secure:false（本地 MailHog / STARTTLS 协商）。
 * 2026-11-12 账号体系重做：transport 增 SMTP 认证（SMTP_USER/SMTP_PASS，未配 → 匿名连接），
 * 发件人改取 SMTP_FROM（默认维持一期占位值）。
 *
 * sendMail 永不抛错：邮件是尽力而为的旁路，投递失败只影响送达与否，不得波及
 * 通知落库/邀请落库/定时清理主流程；返回布尔供调用方（将来）回写 notifications.emailed_at。
 * EmailCodeService 会把 production 及已配 SMTP 的 dev/test 真实发信失败显式返回给页面；
 * 未配 SMTP 的 dev/test 仍容错成功，便于本地使用万能码，详见 email-code.service.ts。
 *
 * 2026-11-18 发件额度事故防线：开发环境真发信后，每轮全量 web e2e 造号发码产生
 * 数百封真实邮件（收件人全为测试域名 @e2e.gmind.dev），打爆真实发件箱额度。
 * 裁定：非生产环境发往 E2E_MAIL_SUFFIX 域名的邮件一律只 log 不发送——单点收口
 * （验证码/通知/摘要/邀请全走本函数），真实邮箱与生产环境不受影响。测试域名的
 * 主动拦截属于预期行为，EmailCodeService 不得把它误判为 SMTP 故障。
 */
const E2E_MAIL_SUFFIX = '@e2e.gmind.dev';

/** 测试收件人判定单点：MailService 负责拦截，EmailCodeService 据此区分“主动拦截/真实失败”。 */
export function isE2eMailRecipient(to: string): boolean {
  return to.trim().toLowerCase().endsWith(E2E_MAIL_SUFFIX);
}

@Injectable()
export class MailService {
  private readonly transport: Transporter | null;

  constructor() {
    this.transport =
      env.SMTP_HOST && env.SMTP_PORT
        ? nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_PORT === 465,
            auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          })
        : null;
  }

  async sendMail(to: string, subject: string, body: string): Promise<boolean> {
    // e2e 测试域名闸（2026-11-18）：非生产环境只记录不真发，防测试打爆真实发件额度
    const e2eRecipient = env.NODE_ENV !== 'production' && isE2eMailRecipient(to);
    if (!this.transport || e2eRecipient) {
      console.log(`[mail] ${e2eRecipient ? 'e2e 测试域名拦截' : 'SMTP 未配置'}，仅记录不发送：to=${to} subject=${subject} body=${body.slice(0, 120)}`);
      return false;
    }
    try {
      await this.transport.sendMail({ from: env.SMTP_FROM, to, subject, text: body });
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`[mail] SMTP 发送失败（尽力而为，不波及主流程）：to=${to} subject=${subject} err=${reason}`);
      return false;
    }
  }
}
