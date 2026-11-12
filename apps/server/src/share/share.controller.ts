import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { UserGuard } from '../auth/user.guard';
import { InviteService } from './invite.service';
import { inviteRequestSchema } from './invite-request.schema';
import { ShareService } from './share.service';

/** 链接权限档位（2026-10-28 P0）：editor|viewer，缺省 editor（存量行为不变）。 */
const shareRoleSchema = z.object({ role: z.enum(['editor', 'viewer']).default('editor') });

/**
 * 分享域端点（M3b Task 4，FR-SHR-001 + Task 5，FR-SHR-004）。
 *
 * ShareManageController 挂 /api/files/:id/share 与 /api/files/:id/invites（REST 层级隶属
 * 文件资源；路径与 FilesController 的 :id/open、:id/copy 等互不重叠，Express 精确匹配无歧义）：
 * 创建/关闭/邀请均 owner only，非 owner 与不存在同口径 404（service 内统一判定）。
 *
 * SharePublicController 挂 /api/share/:token：GET 公开（落地页需在登录前探测，
 * closed/missing 统一 200 {status:'closed'}）；join 需登录（UserGuard）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/files')
@UseGuards(UserGuard)
export class ShareManageController {
  constructor(
    @Inject(ShareService) private readonly share: ShareService,
    @Inject(InviteService) private readonly invites: InviteService,
  ) {}

  @Post(':id/share')
  create(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    return this.share.createForOwner(req.user.id, id, shareRoleSchema.parse(body ?? {}).role);
  }

  /** 链接分享状态（2026-10-25 原型链接页签）：owner-only；无 active 行是合法态非错误。 */
  @Get(':id/share')
  describe(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.share.describeForOwner(req.user.id, id);
  }

  /** 修改权限档位（2026-10-28 P0）：token 不变即改即生效；无 active 行 404。 */
  @Patch(':id/share')
  setRole(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    return this.share.setRoleForOwner(req.user.id, id, shareRoleSchema.parse(body ?? {}).role);
  }

  @Delete(':id/share')
  @HttpCode(200) // 关闭是幂等动作（重复关 404 除外），非资源创建语义
  close(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.share.closeForOwner(req.user.id, id);
  }

  /** 批量邀请（FR-SHR-004）：数量边界在 schema 层 400，格式非法在 service 层 400 并逐条回列。 */
  @Post(':id/invites')
  invite(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    const { contacts } = inviteRequestSchema.parse(body);
    return this.invites.createBatch(req.user.id, id, contacts);
  }
}

@Controller('api/share')
export class SharePublicController {
  constructor(@Inject(ShareService) private readonly share: ShareService) {}

  @Get(':token')
  describe(@Param('token') token: string) {
    return this.share.describeByToken(token);
  }

  @Post(':token/join')
  @UseGuards(UserGuard)
  join(@Req() req: { user: { id: string } }, @Param('token') token: string) {
    return this.share.joinByToken(req.user.id, token);
  }
}
