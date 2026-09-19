import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { FileEntity } from './file.entity';
import { FileCollaboratorEntity } from './file-collaborator.entity';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';

@Module({
  // UserGuard 依赖 UsersService；UsersModule 非 global，FilesModule 必须显式引入才能解析
  imports: [TypeOrmModule.forFeature([FileEntity, FileCollaboratorEntity]), UsersModule],
  providers: [FilesService],
  controllers: [FilesController],
  exports: [FilesService],
})
export class FilesModule {}
