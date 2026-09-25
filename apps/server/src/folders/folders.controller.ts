import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { createFolderSchema, updateFolderSchema } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { FoldersService } from './folders.service';

@Controller('api/folders')
@UseGuards(UserGuard)
export class FoldersController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(FoldersService) private readonly folders: FoldersService) {}

  @Post()
  async create(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const input = createFolderSchema.parse(body ?? {});
    return this.folders.createForUser(req.user.id, input);
  }

  /** 扁平数组（裁定口径）：客户端组树；depth ASC → name ASC。 */
  @Get()
  listTree(@Req() req: { user: { id: string } }) {
    return this.folders.listTree(req.user.id);
  }

  @Patch(':id')
  async update(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    const input = updateFolderSchema.parse(body ?? {});
    return this.folders.update(req.user.id, id, input);
  }

  @Delete(':id')
  @HttpCode(200) // 软删是幂等动作（重复删 404 除外），非资源创建；owner only
  async remove(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    await this.folders.deleteRecursively(req.user.id, id);
    return { ok: true as const };
  }
}
