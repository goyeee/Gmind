import { ConflictException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { compare } from 'bcryptjs';
import { InviteService } from '../share/invite.service';
import { SessionService } from '../session/session.service';
import { FilesService } from '../files/files.service';
import { UsersService } from '../users/users.service';
import { EmailCodeService } from './email-code.service';
import { isDuplicateKeyError } from '../utils/duplicate-key';
import type { UserEntity } from '../users/user.entity';
import type { LoginResponse } from '@gmind/shared';

/** POST /api/auth/register 请求体（已过 shared registerSchema 校验：email 归一、密码 6~64、昵称 1~32）。 */
export interface RegisterInput {
  email: string;
  code: string;
  password: string;
  nickname: string;
}

/** POST /api/auth/password-reset 请求体（已过 shared passwordResetSchema 校验）。 */
export interface ResetPasswordInput {
  email: string;
  code: string;
  newPassword: string;
}

@Injectable()
export class AuthService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(InviteService) private readonly invites: InviteService,
    @Inject(EmailCodeService) private readonly emailCode: EmailCodeService,
  ) {}

  /** 邮箱+密码登录（2026-11-12 重做）：查号 → 核密 → 停用闸 → 邀请回填 → 建会话。
   *  邮箱已由 shared loginSchema 归一，此处不再二次处理。 */
  async login(account: string, password: string, rememberMe: boolean): Promise<LoginResponse> {
    const user = await this.users.findByEmail(account);
    if (!user) throw new UnauthorizedException('账号不存在，请先注册');
    if (!(await compare(password, user.passwordHash ?? ''))) {
      throw new UnauthorizedException('密码错误，请重新输入或找回密码');
    }
    // 停用闸（账号管理，移植 mindgrid）：已停用账号拒绝登录（401，文案两段式）。
    // 登录成功不改动 systemRole/status（角色只在建号/管理端点变化）。
    if (user.status === 'disabled') throw new UnauthorizedException('账号已被停用，请联系管理员');
    await this.backfillInvites(user, '登录');
    return this.issueSession(user, rememberMe);
  }

  /** 邮箱注册（2026-11-12 重做，FR-ACC-001）：验码 → 建号 → 种 3 个示例文件 →
   *  邀请回填 → 建会话（注册即登录，rememberMe=false）。种文件改挂 register
   *  （原「登录即注册」通道已随三 Provider 删除）。 */
  async register(input: RegisterInput): Promise<LoginResponse> {
    await this.emailCode.verify('register', input.email, input.code);
    let user: UserEntity;
    try {
      user = await this.users.createByEmail({ email: input.email, nickname: input.nickname, password: input.password });
    } catch (err) {
      // 并发窗口内的重复注册由 uk_users_email 唯一键兜底（同 admin/files 先例）：
      // 发码端点已前置占用检查，此为双开竞态的收口，文案与前置检查一致。
      if (isDuplicateKeyError(err)) throw new ConflictException('该邮箱已注册，请直接登录');
      throw err;
    }
    await this.files.createSeedFiles(user.id);
    await this.backfillInvites(user, '注册');
    return this.issueSession(user, false);
  }

  /** 忘记密码重置（2026-11-12 重做）：验码(password_reset) → 覆写密码 → 吊销全部
   *  会话（踢端）。邮箱不存在是发码后账号被删的防御分支（发码端点已前置 404），同文案。 */
  async resetPassword(input: ResetPasswordInput): Promise<void> {
    await this.emailCode.verify('password_reset', input.email, input.code);
    const user = await this.users.findByEmail(input.email);
    if (!user) throw new NotFoundException('该邮箱尚未注册，请确认后重试或先注册');
    await this.users.setPasswordForReset(user.id, input.newPassword);
    await this.sessions.revokeAllForUser(user.id);
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }

  /** 邀请回填（准入 7.10 裁定：对已注册用户同样生效，登录/注册每次尽力触发，天然
   *  重试）；幂等由 acceptPendingForNewUser 的 pending 过滤 + uk_invite 保证。失败
   *  隔离：捕获记录，不波及登录/注册主流程（口径同邮件旁路）。 */
  private async backfillInvites(user: UserEntity, via: '登录' | '注册'): Promise<void> {
    try {
      await this.invites.acceptPendingForNewUser(user);
    } catch (err) {
      // user 上下文（M5 清偿，恢复 T1 形态）：排查「哪个账号回填失败」必需——
      // 回填按 user 的 email/phone 匹配，丢 user 即丢定位线索。log-only，无测试。
      console.error(`[invite-backfill] ${via}回填失败（已隔离）user=${user.id}`, err);
    }
  }

  /** 签发会话并组装 LoginResponse（login/register 共用出口，形状单点）。 */
  private async issueSession(user: UserEntity, rememberMe: boolean): Promise<LoginResponse> {
    const { token, expiresAt } = await this.sessions.create(user.id, rememberMe);
    return { token, expiresAt, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } };
  }
}
