import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { SessionService } from '../session/session.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const session = token ? await this.sessions.validate(token) : null;
    if (!session) throw new UnauthorizedException('未登录或会话已过期');
    const user = await this.users.findById(session.userId);
    if (!user) throw new UnauthorizedException('用户不存在');
    req.user = { id: user.id };
    req.sessionToken = token;
    req.fullUser = { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl };
    return true;
  }
}
