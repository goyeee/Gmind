import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { TrashItem } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { TrashService } from './trash.service';

/** 回收站域（M3a Task 7，FR-FIL-005~007/010）。全端点 owner=me（UserGuard 鉴权 +
 *  service 层 owner 校验双层）；文件本体仍走 /api/files（软删入口不变）。 */
@Controller('api/trash')
@UseGuards(UserGuard)
export class TrashController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(TrashService) private readonly trash: TrashService) {}

  /** 我的回收站：删除时间/删除人昵称/原文件夹名/nodeCount，按删除时间倒序。 */
  @Get()
  list(@Req() req: { user: { id: string } }): Promise<TrashItem[]> {
    return this.trash.listTrash(req.user.id);
  }

  @Post(':fileId/restore')
  @HttpCode(200) // 还原是幂等动作而非资源创建，返回 200
  restore(@Req() req: { user: { id: string } }, @Param('fileId') fileId: string): Promise<{ ok: true }> {
    return this.trash.restore(req.user.id, fileId);
  }

  @Delete(':fileId')
  @HttpCode(200) // 彻底删除是幂等动作（重复删 404 除外），非资源创建
  async purge(@Req() req: { user: { id: string } }, @Param('fileId') fileId: string): Promise<{ ok: true }> {
    await this.trash.purgeOwned(req.user.id, fileId);
    return { ok: true as const };
  }
}
