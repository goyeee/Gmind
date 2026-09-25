import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabModule } from '../collab/collab.module';
import { UsersModule } from '../users/users.module';
import { FileEntity } from './file.entity';
import { FileCollaboratorEntity } from './file-collaborator.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';

@Module({
  // UserGuard 依赖 UsersService；UsersModule 非 global，FilesModule 必须显式引入才能解析
  // CollabModule（无环：collab 不反向依赖 FilesModule）——saveDocState 的陈旧写序守卫
  // （M3a 准入 7.1）需查询 CollabService 持有的活跃内存 doc
  imports: [TypeOrmModule.forFeature([FileEntity, FileCollaboratorEntity]), UsersModule, CollabModule],
  providers: [FilesService],
  controllers: [FilesController],
  exports: [FilesService],
})
export class FilesModule {}
