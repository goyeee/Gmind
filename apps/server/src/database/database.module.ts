import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { env } from '../config/env';
import { createDataSource } from './data-source';
import { FileEntity } from '../files/file.entity';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileStarEntity } from '../files/file-star.entity';
import { FolderEntity } from '../folders/folder.entity';
import { NotificationEntity } from '../notifications/notification.entity';
import { ShareLinkEntity } from '../share/share-link.entity';
import { UserEntity } from '../users/user.entity';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const ds = createDataSource(env.DB_DATABASE);
        // 与 data-source.ts 同理：不用 glob —— typeorm 会对 glob 命中的 .ts 做原生 require，
        // 装饰器语法在 Node strip-types 下直接 SyntaxError；显式类注册在 vitest / tsx / tsc 三种管线下行为一致。
        // 约定：新增实体必须同步追加到此处（forFeature 之外的运行时建元数据来源）。
        return {
          ...ds.options,
          entities: [UserEntity, FileEntity, FileCollaboratorEntity, FileStarEntity, FolderEntity, NotificationEntity, ShareLinkEntity],
        };
      },
    }),
  ],
})
export class DatabaseModule {}
