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
    // 停用即刻失效（账号管理）：guard 本就每请求查 users 表，此处仅加一条件即实现
    // 「停用后既有 token 立即 401」——Redis 里的会话不需吊销，恢复启用后原 token 自然复通。
    if (user.status !== 'active') throw new UnauthorizedException('账号已被停用，请联系管理员');
    // systemRole 供 AdminGuard 二段校验（须紧跟 UserGuard 使用）；fullUser 同步带出供前端渲染管理入口
    req.user = { id: user.id, systemRole: user.systemRole };
    req.sessionToken = token;
    // phone/email/hasPassword（M5 Task 1）：账号设置页按身份形态渲染改密区
    // （有密码=旧密码验证 / 无密码=验证码核身）与换绑区（展示当前绑定）
    req.fullUser = {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      email: user.email,
      hasPassword: user.passwordHash !== null,
      systemRole: user.systemRole,
    };
    return true;
  }
}
