import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabModule } from '../collab/collab.module';
import { StorageCoreModule } from '../storage/storage-core.module';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { FileEntity } from './file.entity';
import { FileCollaboratorEntity } from './file-collaborator.entity';
import { FileStarEntity } from './file-star.entity';
import { FolderEntity } from '../folders/folder.entity';
import { FilesService } from './files.service';
import { FilesController, SearchController } from './files.controller';

@Module({
  // UserGuard 依赖 UsersService；UsersModule 非 global，FilesModule 必须显式引入才能解析
  // CollabModule（无环：collab 不反向依赖 FilesModule）——saveDocState 的陈旧写序守卫
  // （M3a 准入 7.1）需查询 CollabService 持有的活跃内存 doc。
  // FolderEntity（M3a Task 5）：文件移动目标（folderId）归属+存活校验用
  // FileStarEntity（M3a Task 6，FR-FIL-004）：加星/取消端点的 file_stars 行读写
  // StorageCoreModule（M3b Task 1，准入 7.8）：copyForUser 的图片对象迁移需
  // StorageService.copyImage——叶子模块（不含鉴权端点层），不与 StorageModule 成环
  // UserEntity（M3b Task 8，FR-CMT-005）：collaborators 候选列表的 nickname JOIN
  imports: [
    TypeOrmModule.forFeature([FileEntity, FileCollaboratorEntity, FileStarEntity, FolderEntity, UserEntity]),
    UsersModule,
    CollabModule,
    StorageCoreModule,
  ],
  providers: [FilesService],
  controllers: [FilesController, SearchController],
  exports: [FilesService],
})
export class FilesModule {}
