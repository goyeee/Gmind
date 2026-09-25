import { Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { env } from '../config/env';
import { UserGuard } from '../auth/user.guard';
import { VersionsService } from './versions.service';

/**
 * 版本域端点（M4 Task 7，FR-VER-004）。
 *
 * 挂 /api/files/:id/versions（REST 层级隶属文件资源；与 FilesController 的 :id/open、
 * CommentsController 的 :id/comments 等 兄弟路径互不重叠，Express 精确匹配无歧义）。
 * 列表/取态 canAccess 口径、恢复 owner/editor 口径，无权限/不存在统一 404（service 内
 * 判定）。恢复是幂等动作而非资源创建 → 200（trash restore 同款裁定）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/files')
@UseGuards(UserGuard)
export class VersionsController {
  constructor(@Inject(VersionsService) private readonly versions: VersionsService) {}

  @Get(':id/versions')
  list(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.versions.list(req.user.id, id);
  }

  @Get(':id/versions/:versionId')
  state(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.getState(req.user.id, id, versionId);
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(200)
  restore(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    return this.versions.restore(req.user.id, id, versionId);
  }

  /**
   * dev/e2e 专用快照触发（M4 Task 8）：按需落一行 auto 快照（不看 3 分钟节流），
   * 供 web e2e 造数与手动验收共用。生产不生效——一行可读守卫（NODE_ENV!=='production'
   * 才放行，等价于「生产一律 404」）；与 dev-e2e 的 fail-closed 纪律同方向，且本路由
   * 另受 UserGuard + canAccess（service 内 findAliveOr404）双闸，无鉴权不可达。
   * 生产模式下路由不可用不可在本套件内断言（vitest 恒为 test 环境），守卫为单行
   * 直读 env 的纯比较，回归由代码评审钉死。
   */
  @Post(':id/versions/snapshot')
  @HttpCode(200)
  async snapshotDev(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
  ): Promise<{ created: boolean }> {
    if (env.NODE_ENV === 'production') throw new NotFoundException();
    return this.versions.snapshotDev(req.user.id, id);
  }
}
