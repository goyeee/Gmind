import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabModule } from '../collab/collab.module';
import { EventsModule } from '../events/events.module';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { FilesModule } from '../files/files.module';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { VersionEntity } from './version.entity';
import { VersionsController } from './versions.controller';
import { VersionsService } from './versions.service';

@Module({
  // UserGuard 依赖 UsersService（UsersModule 显式引入，SessionModule 为 @Global）；
  // FilesModule：findAliveOr404 单点提供「存活 + canAccess」（404 口径）；
  // CollabModule（无环：collab 不反向依赖任何业务模块）：withLiveDocument 双路径恢复
  // （live 内存 doc 内恢复自动广播 / null 回落离线落库）；
  // EventsModule：恢复成功后落 version_restore 埋点；
  // FileEntity/FileCollaboratorEntity（离线落库回写 files 行 + 恢复权 editor 角色判定）、
  // UserEntity（createdByName 的 nickname JOIN）。
  imports: [
    TypeOrmModule.forFeature([VersionEntity, FileEntity, FileCollaboratorEntity, UserEntity]),
    UsersModule,
    FilesModule,
    CollabModule,
    EventsModule,
  ],
  providers: [VersionsService],
  controllers: [VersionsController],
})
export class VersionsModule {}
