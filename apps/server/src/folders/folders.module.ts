import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { FilesModule } from '../files/files.module';
import { FolderEntity } from './folder.entity';
import { FoldersService } from './folders.service';
import { FoldersController } from './folders.controller';

@Module({
  // FilesModule 提供 FilesService（文件夹整体入回收站复用其软删核心，导出见 files.module.ts）；
  // UserGuard 依赖 UsersService，UsersModule 须在本模块显式引入
  imports: [TypeOrmModule.forFeature([FolderEntity]), FilesModule, UsersModule],
  providers: [FoldersService],
  controllers: [FoldersController],
})
export class FoldersModule {}
