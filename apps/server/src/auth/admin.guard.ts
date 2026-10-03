import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { SystemRole } from '@gmind/shared';

/**
 * 系统级权限门（账号管理，移植 mindgrid requireSuperAdmin）：仅 super_admin 放行。
 * 依赖 UserGuard 先行——角色从 req.user.systemRole 读取（UserGuard 每请求查库装配，
 * 降级后旧 token 即时失去超管权限，不必等会话过期）。用法：@UseGuards(UserGuard, AdminGuard)。
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as { systemRole?: SystemRole } | undefined;
    // 防御：未挂 UserGuard 直接误用 AdminGuard 时按未登录拒绝，不静默放行
    if (!user) throw new UnauthorizedException('未登录或会话已过期');
    if (user.systemRole !== 'super_admin') {
      throw new ForbiddenException('仅超级管理员可执行该操作，请联系管理员');
    }
    return true;
  }
}
