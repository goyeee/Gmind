import { Inject, Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
import { InviteService } from '../share/invite.service';
import { SessionService } from '../session/session.service';
import { FilesService } from '../files/files.service';
import { UsersService } from '../users/users.service';
import type { LoginIdentity } from '../users/users.service';
import type { LoginResponse } from '@gmind/shared';

@Injectable()
export class AuthService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  /** 登录即注册（FR-ACC-001）：新身份建用户并种 3 个示例文件。 */
  async login(identity: LoginIdentity, rememberMe: boolean, registerPassword?: string): Promise<LoginResponse> {
    let user = await this.users.findByIdentity(identity);
    if (!user) {
      user = await this.users.create(identity);
      if (registerPassword && identity.method === 'email') {
        user.passwordHash = await hash(registerPassword, 10);
        await this.users.save(user);
      }
      await this.files.createSeedFiles(user.id);
    }
    // 准入 7.10 裁定：回填对已注册用户同样生效（每次登录尽力触发，天然重试）；
    // 幂等由 acceptPendingForNewUser 的 pending 过滤 + uk_invite 保证。失败隔离：
    // 事务化且捕获记录，不波及登录主流程（口径同邮件旁路）。
    try {
      await this.invites.acceptPendingForNewUser(user);
    } catch (err) {
      // user 上下文（M5 清偿，恢复 T1 形态）：排查「哪个账号回填失败」必需——
      // 回填按 user 的 email/phone 匹配，丢 user 即丢定位线索。log-only，无测试。
      console.error(`[invite-backfill] 登录回填失败（已隔离）user=${user.id}`, err);
    }
    const { token, expiresAt } = await this.sessions.create(user.id, rememberMe);
    return { token, expiresAt, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }
}
