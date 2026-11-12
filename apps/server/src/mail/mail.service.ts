import { Injectable } from '@nestjs/common';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { env } from '../config/env';

/**
 * 邮件发送服务（M3a Task 7 裁定，FR-FIL-010）：SMTP 经 env 可配（SMTP_HOST/SMTP_PORT）。
 *
 * M0 裁定：MailHog 容器未起（镜像不可得）→ 当前默认无 SMTP 配置，sendMail 仅 log 不发送，
 * 调用方（CleanupService、InviteService 等）照常走主流程（「无 SMTP 仅通知不 crash」）。
 * M3b Task 5 接通传输层：SMTP_HOST 缺省 → transport null → 仅 log；配置后经 nodemailer
 * 明文 SMTP（本地无 TLS，secure:false），调用方零改动。
 * 2026-11-12 账号体系重做：transport 增 SMTP 认证（SMTP_USER/SMTP_PASS，未配 → 匿名连接），
 * 发件人改取 SMTP_FROM（默认维持一期占位值）。
 *
 * sendMail 永不抛错：邮件是尽力而为的旁路，投递失败只影响送达与否，不得波及
 * 通知落库/邀请落库/定时清理主流程；返回布尔供调用方（将来）回写 notifications.emailed_at。
 * （例外见 EmailCodeService：验证码是唯一把 false 当失败的调用方。）
 */
@Injectable()
export class MailService {
  private readonly transport: Transporter | null;

  constructor() {
    this.transport =
      env.SMTP_HOST && env.SMTP_PORT
        ? nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: false,
            auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
          })
        : null;
  }

  async sendMail(to: string, subject: string, body: string): Promise<boolean> {
    if (!this.transport) {
      console.log(`[mail] SMTP 未配置，仅记录不发送：to=${to} subject=${subject} body=${body.slice(0, 120)}`);
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
