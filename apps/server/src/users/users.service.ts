import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import type { LoginMethod } from '@gmind/shared';
import { env } from '../config/env';
import { UserEntity } from './user.entity';
import {
  rebindEmailIdentitySchema,
  rebindPhoneIdentitySchema,
  EMAIL_OPT_OUT_TYPES,
  type EmailOptOutType,
} from './users-request.schema';

export interface LoginIdentity {
  method: LoginMethod;
  phone?: string;
  email?: string;
  wechatOpenid?: string;
  nickname?: string;
}

/** 换绑请求（已过 rebindRequestSchema 基础校验；格式在 rebind() 内按 channel 二次解析）。 */
export interface RebindInput {
  channel: 'phone' | 'email';
  newIdentity: string;
  code: string;
}

/** 通知偏好（FR-CMT-006）：邮件退订类型集合，PATCH 全量替换。 */
export interface NotifyPrefs {
  emailOptOut: EmailOptOutType[];
}

/** notify_prefs 列容错解析（M0 预留 text 列，历史值可能为空/坏 JSON）：形状不符 → []。 */
export function parseEmailOptOut(raw: string | null): EmailOptOutType[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const list = (parsed as { emailOptOut?: unknown }).emailOptOut;
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is EmailOptOutType => (EMAIL_OPT_OUT_TYPES as readonly string[]).includes(v));
  } catch {
    return [];
  }
}

@Injectable()
export class UsersService {
  constructor(@InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>) {}

  findById(id: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ id });
  }

  findByIdentity(identity: LoginIdentity): Promise<UserEntity | null> {
    if (identity.method === 'phone') return this.repo.findOneBy({ phone: identity.phone });
    if (identity.method === 'email') return this.repo.findOneBy({ email: identity.email });
    return this.repo.findOneBy({ wechatOpenid: identity.wechatOpenid });
  }

  save(user: UserEntity): Promise<UserEntity> {
    return this.repo.save(user);
  }

  async create(identity: LoginIdentity): Promise<UserEntity> {
    const user = this.repo.create();
    if (identity.method === 'phone') user.phone = identity.phone ?? null;
    if (identity.method === 'email') user.email = identity.email ?? null;
    if (identity.method === 'wechat') user.wechatOpenid = identity.wechatOpenid ?? null;
    user.nickname = identity.nickname ?? this.defaultNickname(identity);
    return this.repo.save(user);
  }

  // ---- 账号设置（M5 Task 1，FR-ACC-002 收口）------------------------------

  /** 改密：有密码（password_hash 非空）须 currentPassword 验证；无密码（手机号注册）
   *  须 code 核身——开发环境固定 123456，与登录通道同语义（spec §5.2 DevProvider）。
   *  成功 204。不吊销其他会话（PRD 未要求，登记：既有会话保持有效）。 */
  async changePassword(
    userId: string,
    input: { newPassword: string; currentPassword?: string; code?: string },
  ): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    if (user.passwordHash) {
      // 有密码：旧密码验证（防会话劫持者改密）
      if (!input.currentPassword) throw new BadRequestException('请输入当前密码');
      if (!(await compare(input.currentPassword, user.passwordHash))) {
        throw new BadRequestException('当前密码不正确，请重新输入');
      }
    } else {
      // 无密码：验证码核身（通道语义与登录一致）
      this.verifyDevCode(input.code);
    }
    user.passwordHash = await hash(input.newPassword, 10);
    await this.repo.save(user);
  }

  /** 换绑（FR-ACC-002）：code 校验 → 新身份格式校验（同登录 zod 口径）→ 占用检查
   *  （被占 409「该手机号/邮箱已绑定其他账号」）→ 改绑落列。不吊销其他会话（登记同改密）。 */
  async rebind(userId: string, input: RebindInput): Promise<void> {
    this.verifyDevCode(input.code);
    if (input.channel === 'phone') {
      rebindPhoneIdentitySchema.parse(input.newIdentity);
    } else {
      rebindEmailIdentitySchema.parse(input.newIdentity);
    }
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    const occupied =
      input.channel === 'phone'
        ? await this.repo.findOneBy({ phone: input.newIdentity })
        : await this.repo.findOneBy({ email: input.newIdentity });
    if (occupied && occupied.id !== userId) {
      throw new ConflictException(input.channel === 'phone' ? '该手机号已绑定其他账号' : '该邮箱已绑定其他账号');
    }
    if (input.channel === 'phone') user.phone = input.newIdentity;
    else user.email = input.newIdentity;
    await this.repo.save(user);
  }

  /** 通知偏好读取（FR-CMT-006）：空/坏列 → {emailOptOut: []}。 */
  async getNotifyPrefs(userId: string): Promise<NotifyPrefs> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    return { emailOptOut: parseEmailOptOut(user.notifyPrefs) };
  }

  /** 通知偏好全量替换（FR-CMT-006）：users.notify_prefs 存 JSON {"emailOptOut":[...]}。 */
  async setNotifyPrefs(userId: string, prefs: NotifyPrefs): Promise<NotifyPrefs> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    user.notifyPrefs = JSON.stringify({ emailOptOut: prefs.emailOptOut });
    await this.repo.save(user);
    return { emailOptOut: [...prefs.emailOptOut] };
  }

  /** 开发环境验证码核身（与登录 DevProvider 同源 env.DEV_SMS_CODE；失败文案按
   *  NFR-USE-005 给原因 + 下一步动作）。 */
  private verifyDevCode(code: string | undefined): void {
    if (code !== env.DEV_SMS_CODE) throw new BadRequestException('验证码错误，请重新输入');
  }

  private defaultNickname(identity: LoginIdentity): string {
    if (identity.nickname) return identity.nickname;
    if (identity.phone) return `用户${identity.phone.slice(-4)}`;
    if (identity.email) return identity.email.split('@')[0] ?? '用户';
    return '微信用户';
  }
}
