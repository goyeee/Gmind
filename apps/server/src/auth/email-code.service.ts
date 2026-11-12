import { BadRequestException, HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import Redis from 'ioredis';
import type { EmailCodeScene } from '@gmind/shared';
import { env } from '../config/env';
import { MailService } from '../mail/mail.service';

/** 验证码有效期（秒）：`email_code:{scene}:{email}` EX 600。 */
export const EMAIL_CODE_TTL_SEC = 600;
/** 重发冷却（秒）：`email_code_wait:{scene}:{email}` SET NX EX 60。 */
export const EMAIL_CODE_WAIT_SEC = 60;
/** 验码连错上限：失败计数达 5 删除验证码（防爆破，正确码也作废须重新获取）。 */
export const EMAIL_CODE_MAX_FAILS = 5;

/**
 * 邮箱验证码服务（2026-11-12 账号体系重做）：发码/验码全走 Redis，无新表。
 *
 * 三个键（scene ∈ register/password_reset/email_bind，见 @gmind/shared EMAIL_CODE_SCENES）：
 * - `email_code:{scene}:{email}`——验证码本体，EX 600；
 * - `email_code_wait:{scene}:{email}`——60s 重发冷却，SET NX EX 60 原子占位，命中 → 429；
 * - `email_code_fail:{scene}:{email}`——验码失败计数，每次错码 INCR + EXPIRE 600，达 5 删码。
 *
 * 码值：dev/test 恒 env.DEV_MAIL_CODE（默认 '123456'，e2e/本地联调可预判）；
 * production 恒随机 6 位数字——不读 DEV_MAIL_CODE，即使设置了也忽略。
 *
 * sendMail 永不抛错的例外：验证码是唯一把 false 当失败的调用方（发信失败 → 500，
 * 并解除 60s 冷却放行重试——否则一次 SMTP 抖动 = 用户 60s 拿不到码）。
 */
@Injectable()
export class EmailCodeService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（同 session.service.ts）
  constructor(
    @Inject(Redis) private readonly redis: Redis,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  private codeKey(scene: EmailCodeScene, email: string): string {
    return `email_code:${scene}:${email}`;
  }

  private waitKey(scene: EmailCodeScene, email: string): string {
    return `email_code_wait:${scene}:${email}`;
  }

  private failKey(scene: EmailCodeScene, email: string): string {
    return `email_code_fail:${scene}:${email}`;
  }

  private generateCode(): string {
    if (env.NODE_ENV === 'production') return String(randomInt(0, 1_000_000)).padStart(6, '0');
    return env.DEV_MAIL_CODE;
  }

  /** 发码：60s 冷却 → 生成码 → 发信 → 写码（EX 600）。冷却占位后发信失败须删占位。 */
  async issue(scene: EmailCodeScene, email: string): Promise<void> {
    const acquired = await this.redis.set(this.waitKey(scene, email), '1', 'EX', EMAIL_CODE_WAIT_SEC, 'NX');
    if (!acquired) {
      throw new HttpException('验证码发送过于频繁，请 60 秒后再试', HttpStatus.TOO_MANY_REQUESTS);
    }
    const code = this.generateCode();
    const sent = await this.mail.sendMail(
      email,
      'Gmind 邮箱验证码',
      `你的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
    );
    if (!sent) {
      await this.redis.del(this.waitKey(scene, email));
      throw new HttpException('邮件发送失败，请稍后重试；若持续失败请联系管理员', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    await this.redis.set(this.codeKey(scene, email), code, 'EX', EMAIL_CODE_TTL_SEC);
  }

  /** 验码：不符/过期 → 失败计数 INCR（EXPIRE 600，达 5 删码）并 throw 400；成功删码删计数。 */
  async verify(scene: EmailCodeScene, email: string, code: string): Promise<void> {
    const stored = await this.redis.get(this.codeKey(scene, email));
    if (!stored || stored !== code) {
      const fails = await this.redis.incr(this.failKey(scene, email));
      await this.redis.expire(this.failKey(scene, email), EMAIL_CODE_TTL_SEC);
      if (fails >= EMAIL_CODE_MAX_FAILS) await this.redis.del(this.codeKey(scene, email));
      throw new BadRequestException('验证码错误或已过期，请重新获取后再试');
    }
    await this.redis.del(this.codeKey(scene, email));
    await this.redis.del(this.failKey(scene, email));
  }
}
