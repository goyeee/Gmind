import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { AdminUserListItem } from '@gmind/shared';
import { AdminGuard } from '../auth/admin.guard';
import { UserGuard } from '../auth/user.guard';
import { AdminService } from './admin.service';
import { createAdminAccountSchema, updateAdminAccountSchema } from './admin-request.schema';

/**
 * 账号管理端点（/api/admin/users，移植 mindgrid admin 轨道）：
 * 全部 AdminGuard（UserGuard 先装 req.user.systemRole，本 guard 再校验超管）。
 * 契约见 shared AdminUserListItem；错误文案两段式（NFR-USE-005）。
 */
@Controller('api/admin/users')
@UseGuards(UserGuard, AdminGuard)
export class AdminController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(AdminService) private readonly admin: AdminService) {}

  @Get()
  list(): Promise<AdminUserListItem[]> {
    return this.admin.list();
  }

  /** 添加账号：手机号去重（409）；建号即 active member、无密码（开发态验证码登录）。 */
  @Post()
  create(@Body() body: unknown): Promise<AdminUserListItem> {
    return this.admin.createAccount(createAdminAccountSchema.parse(body));
  }

  /** 改角色/状态/昵称：自我保护 + 最后超管保护（409），详见 AdminService.updateAccount。 */
  @Patch(':id')
  update(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<AdminUserListItem> {
    return this.admin.updateAccount(req.user.id, id, updateAdminAccountSchema.parse(body));
  }
}
