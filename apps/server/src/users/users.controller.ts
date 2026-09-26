import { Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';
import { UsersService } from './users.service';
import { changePasswordSchema, notifyPrefsSchema, rebindRequestSchema } from './users-request.schema';

@Controller('api/users')
@UseGuards(UserGuard)
export class UsersController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('me')
  me(@Req() req: { user: { id: string }; fullUser?: unknown }): unknown {
    // fullUser 由 UserGuard 装配：id/nickname/avatarUrl + phone/email/hasPassword
    // （M5 Task 1：账号设置页按身份形态渲染改密区与换绑区）
    return req.fullUser;
  }

  /** 改密（FR-ACC-002 收口）：有密码须 currentPassword，无密码须 code（开发 123456）。 */
  @Post('me/password')
  @HttpCode(204)
  async changePassword(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.changePassword(req.user.id, changePasswordSchema.parse(body));
  }

  /** 换绑（FR-ACC-002 收口）：code → 格式 → 占用（409）→ 落列。 */
  @Post('me/rebind')
  @HttpCode(204)
  async rebind(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.rebind(req.user.id, rebindRequestSchema.parse(body));
  }

  /** 通知偏好（FR-CMT-006）：GET 返回解析形态；PATCH 全量替换（非法成员 400）。 */
  @Get('me/notify-prefs')
  getNotifyPrefs(@Req() req: { user: { id: string } }): Promise<unknown> {
    return this.users.getNotifyPrefs(req.user.id);
  }

  @Patch('me/notify-prefs')
  setNotifyPrefs(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<unknown> {
    return this.users.setNotifyPrefs(req.user.id, notifyPrefsSchema.parse(body));
  }
}
