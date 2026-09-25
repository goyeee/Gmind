import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { createFileSchema } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { FilesService } from './files.service';

// PUT doc-state 的传输契约：Yjs 状态二进制以 base64 编码（body { docState }）；
// baseUpdatedAt（M3a 准入 7.1）为客户端记录的行 updated_at（GET/持久化 ack 下发），
// 缺省视为无 base——兼容旧客户端与首次保存（守卫永远放行，不在此处强校验格式：
// 非法值由 service 按无 base 口径放行）。lastEditorUserId 属 Task 4，此处不收。
const docStateSchema = z.object({ docState: z.string().min(1), baseUpdatedAt: z.string().optional() });

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

  @Get(':id')
  getContent(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.getOwnedFileWithState(req.user.id, id);
  }

  @Put(':id/doc-state')
  async saveDocState(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    const { docState, baseUpdatedAt } = docStateSchema.parse(body ?? {});
    const state = new Uint8Array(Buffer.from(docState, 'base64'));
    return this.files.saveDocState(req.user.id, id, state, baseUpdatedAt);
  }

  @Patch(':id')
  async rename(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    // 复用 createFileSchema 的 title 规则（min 1 / max 255 / 默认「未命名脑图」）；shape.title.parse 返回字符串本体
    const title = createFileSchema.shape.title.parse((body as { title?: string } | null)?.title);
    return this.files.rename(req.user.id, id, title);
  }

  @Post(':id/open')
  @HttpCode(200) // 打开是幂等动作而非资源创建，返回 200
  markOpened(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.markOpened(req.user.id, id);
  }
}
