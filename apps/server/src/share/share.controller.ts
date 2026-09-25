import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';
import { ShareService } from './share.service';

/**
 * 分享链接端点（M3b Task 4，FR-SHR-001）。
 *
 * ShareManageController 挂 /api/files/:id/share（REST 层级隶属文件资源；路径与
 * FilesController 的 :id/open、:id/copy 等互不重叠，Express 精确匹配无歧义）：
 * 创建/关闭均 owner only，非 owner 与不存在同口径 404（service 内统一判定）。
 *
 * SharePublicController 挂 /api/share/:token：GET 公开（落地页需在登录前探测，
 * closed/missing 统一 200 {status:'closed'}）；join 需登录（UserGuard）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/files')
@UseGuards(UserGuard)
export class ShareManageController {
  constructor(@Inject(ShareService) private readonly share: ShareService) {}

  @Post(':id/share')
  create(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.share.createForOwner(req.user.id, id);
  }

  @Delete(':id/share')
  @HttpCode(200) // 关闭是幂等动作（重复关 404 除外），非资源创建语义
  close(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.share.closeForOwner(req.user.id, id);
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
