import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
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
import { MAX_IMAGE_BYTES, StorageService } from './storage.service';

// POST images/copy 的传输契约（Task 15 FR-EDT-010：{ sourceKey } → { key }）
const copyImageSchema = z.object({ sourceKey: z.string().min(1) });

@Controller()
export class StorageController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  /** multipart 字段 file；浏览器 <img> 无法带 Authorization，读取端点公开、仅上传鉴权。
   *  multer fileSize 硬顶让超限请求在进内存缓冲前即被拒（服务层校验兜底非 multipart 路径）。 */
  @Post('api/files/:id/images')
  @UseGuards(UserGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  uploadImage(@Param('id') id: string, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.storage.saveImage(id, file.buffer);
  }

  /** 服务端对象复制（Task 15 FR-EDT-010）：跨文件粘贴时图片随迁到目标文件存储。 */
  @Post('api/files/:id/images/copy')
  @UseGuards(UserGuard)
  copyImage(@Param('id') id: string, @Body() body: unknown) {
    const { sourceKey } = copyImageSchema.parse(body ?? {});
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
