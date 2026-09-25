import { Injectable } from '@nestjs/common';
import { env } from '../config/env';

/**
 * 邮件发送服务（M3a Task 7 裁定，FR-FIL-010）：SMTP 经 env 可配（SMTP_HOST/SMTP_PORT）。
 *
 * M0 裁定：MailHog 容器未起（镜像不可得）→ 当前默认无 SMTP 配置，sendMail 仅 log 不发送，
 * 调用方（CleanupService 等）照常落 notifications 行（「无 SMTP 仅通知不 crash」）。
 * MailHog 就绪后在本类内部接通传输层（nodemailer 或最小 SMTP 客户端），调用方零改动。
 *
 * sendMail 永不抛错：邮件是尽力而为的旁路，投递失败只影响送达与否，不得波及
 * 通知落库/定时清理主流程；返回布尔供调用方（将来）回写 notifications.emailed_at。
 */
@Injectable()
export class MailService {
  async sendMail(to: string, subject: string, body: string): Promise<boolean> {
    if (!env.SMTP_HOST || !env.SMTP_PORT) {
      console.log(`[mail] SMTP 未配置，仅记录不发送：to=${to} subject=${subject} body=${body.slice(0, 120)}`);
      return false;
    }
    // TODO(MailHog 就绪后接通)：SMTP 传输层（env.SMTP_HOST:env.SMTP_PORT，本地明文无 TLS）。
    console.log(`[mail] SMTP 传输层待 MailHog 接线：to=${to} subject=${subject} body=${body.slice(0, 120)}`);
    return false;
  }
}
