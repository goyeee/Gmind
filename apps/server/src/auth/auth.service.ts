import { Inject, Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';
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
    const { token, expiresAt } = await this.sessions.create(user.id, rememberMe);
    return { token, expiresAt, user: { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl } };
  }

  async logout(token: string): Promise<void> {
    await this.sessions.revoke(token);
  }
}
