import { Body, Controller, Injectable, NotFoundException, Post } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { z } from 'zod';
import { env } from '../config/env';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';

const grantSchema = z.object({
  fileId: z.string().min(1),
  phone: z.string().min(1),
});

/**
 * 开发/e2e 专用编排端点（M2 Task 5/6）。
 *
 * 多用户协同 e2e 需要 B/C 拿到 A 文件的访问权：REST assertCanRead 与 WS canOpen
 * 同为「owner 或 file_collaborators 行」口径，而产品化的分享/协作邀请 API 属后续
 * 任务——该缺口在此补齐：给指定手机号用户插入 editor 协作者行（幂等）。
 *
 * 纪律：NODE_ENV=production 一律 404（无任何能力暴露）；除本端点外不复用为业务
 * 通道，正式协作管理不在此扩展。
 */
@Injectable()
@Controller('api/dev-e2e')
export class DevE2eController {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(FileEntity) private readonly files: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collaborators: Repository<FileCollaboratorEntity>,
  ) {}

  @Post('grant-collaborator')
  async grantCollaborator(@Body() body: unknown): Promise<{ ok: true }> {
    if (env.NODE_ENV === 'production') throw new NotFoundException();
    const { fileId, phone } = grantSchema.parse(body ?? {});
    const user = await this.users.findOneBy({ phone });
    const file = await this.files.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!user || !file) throw new NotFoundException('用户或文件不存在');
    const existing = await this.collaborators.findOneBy({ fileId: file.id, userId: user.id });
    if (!existing) {
      const row = this.collaborators.create();
      row.fileId = file.id;
      row.userId = user.id;
      row.role = 'editor';
      await this.collaborators.save(row);
    }
    return { ok: true };
  }
}
