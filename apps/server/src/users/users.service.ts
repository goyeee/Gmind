import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { compare, hash } from 'bcryptjs';
import { EmailCodeService } from '../auth/email-code.service';
import { UserEntity } from './user.entity';
import { EMAIL_OPT_OUT_TYPES, type EmailOptOutType } from './users-request.schema';

/** 通知偏好（FR-CMT-006 + 2026-10-28 P1 总开关）：邮件退订类型集合 + 站内通知总开关
 *  （notifyEnabled，缺省 true）+ 邮件摘要开关（digestEnabled，缺省 true）。 */
export interface NotifyPrefs {
  emailOptOut: EmailOptOutType[];
  notifyEnabled?: boolean;
  digestEnabled?: boolean;
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

/** 通知总开关读取（2026-10-28 P1）：notify_prefs.notifyEnabled !== false——缺省 true
 *  （历史 JSON 无此键视为开）。 */
export function notifyEnabledOf(raw: string | null): boolean {
  if (!raw) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    return (parsed as { notifyEnabled?: unknown }).notifyEnabled !== false;
  } catch {
    return true;
  }
}

/** 邮件摘要开关读取（2026-10-28 P1）：notify_prefs.digestEnabled !== false——缺省 true。 */
export function digestEnabledOf(raw: string | null): boolean {
  if (!raw) return true;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    return (parsed as { digestEnabled?: unknown }).digestEnabled !== false;
  } catch {
    return true;
  }
}

/** 账号视图（GET/PATCH /users/me 返回形状）：不外泄 passwordHash。UserGuard 的
 *  req.fullUser 用同一函数装配（单点，改字段两处同步）。 */
export function fullUserView(user: UserEntity) {
  return {
    id: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    email: user.email,
    hasPassword: user.passwordHash !== null,
    systemRole: user.systemRole,
  };
}

@Injectable()
export class UsersService {
  // tsx 无 DI 元数据：类 token 注入显式 @Inject；EmailCodeService（Task 2 产出）供换绑邮箱验码
  constructor(
    @InjectRepository(UserEntity) private readonly repo: Repository<UserEntity>,
    @Inject(EmailCodeService) private readonly emailCode: EmailCodeService,
  ) {}

  findById(id: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ id });
  }

  /** 按邮箱查用户（register/login/换绑占用检查共用；email 已由 shared emailSchema
   *  归一 trim+lowercase，此处不再二次归一）。 */
  findByEmail(email: string): Promise<UserEntity | null> {
    return this.repo.findOneBy({ email });
  }

  save(user: UserEntity): Promise<UserEntity> {
    return this.repo.save(user);
  }

  /** 邮箱注册建号（2026-11-12 重做）：bcrypt hash 在内部做（cost=10，与 changePassword
   *  一致）；昵称必传（registerSchema 1~32），无默认昵称派生。首注册者=super_admin
   *  （对齐 mindgrid 语义）：空库建号（count=0）即超管，其余 member。存量库的超管由
   *  迁移升最早用户；并发首注册存在双双计 0 的竞态（本地单机规模可接受，登记）。
   *  邮箱占用由 uk_users_email 唯一键兜底（register 前置 findByEmail 检查 + 并发窗口
   *  兜底转 409 在 Task 4 auth.register）。 */
  async createByEmail(input: { email: string; nickname: string; password: string }): Promise<UserEntity> {
    const user = this.repo.create();
    user.email = input.email;
    user.nickname = input.nickname;
    user.passwordHash = await hash(input.password, 10);
    user.systemRole = (await this.repo.count()) === 0 ? 'super_admin' : 'member';
    return this.repo.save(user);
  }

  /** 当前密码核身（改密/换绑共用）：不匹配 → 400「当前密码错误，请重新输入」。
   *  无密码账号（历史手机号建号遗留）同文案 400——重做后新号注册即设密码。 */
  private async assertCurrentPassword(user: UserEntity, currentPassword: string): Promise<void> {
    if (!user.passwordHash || !(await compare(currentPassword, user.passwordHash))) {
      throw new BadRequestException('当前密码错误，请重新输入');
    }
  }

  /** 改密（2026-11-12 重做）：旧密码核身 → 覆写 passwordHash。旧验证码核身分支与
   *  verifyDevCode 已删（邮箱注册制人人有密码，恒走旧密码核身）。成功 204。
   *  校验全部在写之前完成；不吊销其他会话（PRD 未要求，登记：既有会话保持有效）。 */
  async changePassword(userId: string, input: { currentPassword: string; newPassword: string }): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    await this.assertCurrentPassword(user, input.currentPassword);
    user.passwordHash = await hash(input.newPassword, 10);
    await this.repo.save(user);
  }

  /** 换绑邮箱（2026-11-12 重做）：先验当前密码（防会话劫持者改绑）→
   *  emailCode.verify('email_bind', email, code) → 占用（他人）409 → 落列。
   *  顺序即契约；不吊销其他会话（登记同改密）。 */
  async rebindEmail(userId: string, input: { email: string; code: string; currentPassword: string }): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    await this.assertCurrentPassword(user, input.currentPassword);
    await this.emailCode.verify('email_bind', input.email, input.code);
    const occupied = await this.repo.findOneBy({ email: input.email });
    if (occupied && occupied.id !== userId) {
      throw new ConflictException('该邮箱已绑定其他账号，请换用其他邮箱');
    }
    user.email = input.email;
    await this.repo.save(user);
  }

  /** 换绑手机号（2026-11-12 重做）：仅密码核身（手机号无验证码通道）→ 占用（他人）
   *  409 → 落列。不吊销其他会话（登记同改密）。 */
  async rebindPhone(userId: string, input: { phone: string; currentPassword: string }): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    await this.assertCurrentPassword(user, input.currentPassword);
    const occupied = await this.repo.findOneBy({ phone: input.phone });
    if (occupied && occupied.id !== userId) {
      throw new ConflictException('该手机号已绑定其他账号，请换用其他手机号');
    }
    user.phone = input.phone;
    await this.repo.save(user);
  }

  /** 自助改昵称（2026-11-12 重做）：PATCH /users/me；返回落库后实体（controller 映射
   *  fullUserView 视图）。 */
  async updateNickname(userId: string, nickname: string): Promise<UserEntity> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    user.nickname = nickname;
    return this.repo.save(user);
  }

  /** 重置密码专用（忘记密码流，Task 4 resetPassword 消费）：验证码核身在 auth 侧完成，
   *  此处无当前密码校验直接覆写。调用方须随后 SessionService.revokeAllForUser 踢全部会话。 */
  async setPasswordForReset(userId: string, newPassword: string): Promise<void> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    user.passwordHash = await hash(newPassword, 10);
    await this.repo.save(user);
  }

  // ---- 通知偏好（FR-CMT-006）与头像 ---------------------------------------

  /** 通知偏好读取（FR-CMT-006）：空/坏列 → {emailOptOut: [], notifyEnabled: true, digestEnabled: true}。 */
  async getNotifyPrefs(userId: string): Promise<NotifyPrefs> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    return {
      emailOptOut: parseEmailOptOut(user.notifyPrefs),
      notifyEnabled: notifyEnabledOf(user.notifyPrefs),
      digestEnabled: digestEnabledOf(user.notifyPrefs),
    };
  }

  /** 通知偏好全量替换（FR-CMT-006）：users.notify_prefs 存 JSON——emailOptOut 数组 +
   *  notifyEnabled/digestEnabled 两开关（2026-10-28 P1，缺省 true）。 */
  async setNotifyPrefs(userId: string, prefs: NotifyPrefs): Promise<NotifyPrefs> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    user.notifyPrefs = JSON.stringify({
      emailOptOut: prefs.emailOptOut,
      notifyEnabled: prefs.notifyEnabled !== false,
      digestEnabled: prefs.digestEnabled !== false,
    });
    await this.repo.save(user);
    return this.getNotifyPrefs(userId);
  }

  /** 头像设置（2026-10-11 需求方裁定）：白名单 = 5 个预置 SVG 路径或本人上传键
   *  （users/{userId}/ 前缀，防指向他人对象）；其余 400 两段式。落列后返回视图。 */
  async setAvatar(userId: string, avatarUrl: string): Promise<{ avatarUrl: string }> {
    const user = await this.findById(userId);
    if (!user) throw new BadRequestException('用户不存在，请重新登录');
    const isPreset = /^\/avatars\/preset-[1-5]\.svg$/.test(avatarUrl);
    const isOwnUpload = avatarUrl.startsWith(`users/${userId}/`) && !avatarUrl.slice(`users/${userId}/`.length).includes('/');
    if (!isPreset && !isOwnUpload) {
      throw new BadRequestException('头像地址非法，请从预置头像中选择或重新上传');
    }
    user.avatarUrl = avatarUrl;
    await this.repo.save(user);
    return { avatarUrl };
  }
}
