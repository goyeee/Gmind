import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { createFileSchema } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { FilesService } from './files.service';

@Controller('api/files')
@UseGuards(UserGuard)
export class FilesController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  list(@Req() req: { user: { id: string } }) {
    return this.files.listOwned(req.user.id);
  }

  @Post()
  async create(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const { title } = createFileSchema.parse(body ?? {});
    // 按 FileListItem 契约序列化，避免裸实体（含 docState Buffer）被 Nest 原样序列化
    const created = await this.files.createForUser(req.user.id, { title });
    return this.files.toListItem(created);
  }
}
