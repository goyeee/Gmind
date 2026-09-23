import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { CollabService } from './collab.service';

/**
 * 协同网关（M2 Task 1）：Hocuspocus 挂载到 Nest HTTP server 的 /collab 升级路由。
 * 不经 FilesModule（避免模块环），直接 forFeature 注入文件/协作者仓库；
 * SessionModule 为 @Global，SessionService 可直接注入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileEntity, FileCollaboratorEntity])],
  providers: [CollabService],
  exports: [CollabService],
})
export class CollabModule {}
