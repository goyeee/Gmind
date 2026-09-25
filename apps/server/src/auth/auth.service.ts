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
      // 注册回填（FR-SHR-004）：仅新用户创建路径（二次登录不重复触发）——按 email/phone
      // 接受登记中的 pending 邀请并写 editor 协作者行；owner 侧零通知（仅登记，无感知）。
      await this.invites.acceptPendingForNewUser(user);
    }
    const { token, expiresAt } = await this.sessions.create(user.id, rememberMe);
    return { token, expiresAt, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }
}
