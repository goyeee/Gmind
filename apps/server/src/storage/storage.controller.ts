import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Express, Response } from 'express';
import { z } from 'zod';
import { UserGuard } from '../auth/user.guard';
import { FilesService } from '../files/files.service';
import { MAX_IMAGE_BYTES, sourceFileIdOf, StorageService } from './storage.service';

// POST images/copy 的传输契约（Task 15 FR-EDT-010：{ sourceKey } → { key }）
const copyImageSchema = z.object({ sourceKey: z.string().min(1) });

@Controller()
export class StorageController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** multipart 字段 file；浏览器 <img> 无法带 Authorization，读取端点公开、仅上传鉴权。
   *  multer fileSize 硬顶让超限请求在进内存缓冲前即被拒（服务层校验兜底非 multipart 路径）。
   *  准入 7.2（M3a Task 1）：写 :id 命名空间前先校验属主/协作者（FilesService.canAccess，
   *  与 files 域 findAliveOr404 同口径）；无权限与「不存在」同 404「文件不存在」，不泄露存在性。 */
  @Post('api/files/:id/images')
  @UseGuards(UserGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async uploadImage(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<{ key: string }> {
    if (!(await this.files.canAccess(req.user.id, id))) throw new NotFoundException('文件不存在');
    if (!file) throw new BadRequestException('缺少文件');
    return this.storage.saveImage(id, file.buffer);
  }

  /** 服务端对象复制（Task 15 FR-EDT-010）：跨文件粘贴时图片随迁到目标文件存储。
   *  准入 7.2（M3a Task 1）：
   *  - 目标 :id 须可编辑（owner/协作者）——即 copy 的配额准入：图片非 doc 节点、不占
   *    节点配额，「目标可编辑」就是全部配额语义，通过后落盘不再计量；
   *  - 源键归属文件（sourceFileIdOf 自键解析）亦须可访问——非协作者不得借 copy 复制
   *    他人命名空间对象。两处任一不通过 → 404「文件不存在」，不泄露存在性。 */
  @Post('api/files/:id/images/copy')
  @UseGuards(UserGuard)
  async copyImage(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown): Promise<{ key: string }> {
    if (!(await this.files.canAccess(req.user.id, id))) throw new NotFoundException('文件不存在');
    const { sourceKey } = copyImageSchema.parse(body ?? {});
    const sourceFileId = sourceFileIdOf(sourceKey);
    if (sourceFileId !== null && !(await this.files.canAccess(req.user.id, sourceFileId))) {
      throw new NotFoundException('文件不存在');
    }
    return this.storage.copyImage(id, sourceKey);
  }

  /** 通配读取：Nest 10（Express 4）`*` 捕获段落在 req.params[0]，覆盖多级键 files/{id}/{ulid}.png。 */
  @Get('api/images/*')
  async getImage(@Req() req: { params: Record<string, string> }, @Res() res: Response): Promise<void> {
    const image = await this.storage.getImage(req.params[0] ?? '');
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(image.data);
  }
}
