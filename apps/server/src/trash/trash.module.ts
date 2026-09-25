import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../files/file.entity';
import { FolderEntity } from '../folders/folder.entity';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { TrashController } from './trash.controller';
import { TrashService } from './trash.service';

@Module({
  // StorageModule 提供 StorageService（purge 的对象前缀清理，已导出该服务）；
  // UserGuard 依赖 UsersService——StorageModule 不转出其 imports，UsersModule 须在此显式引入
  imports: [TypeOrmModule.forFeature([FileEntity, FolderEntity]), StorageModule, UsersModule],
  providers: [TrashService],
  controllers: [TrashController],
  exports: [TrashService], // CleanupService（jobs）复用 purgeFile 核心
})
export class TrashModule {}
