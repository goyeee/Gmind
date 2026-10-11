import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { StorageCoreModule } from '../storage/storage-core.module';

@Module({
  // StorageCoreModule（2026-10-11 头像上传）：StorageService.saveAvatar——叶子模块
  // 无环（FilesModule 同款取法）。
  imports: [TypeOrmModule.forFeature([UserEntity]), StorageCoreModule],
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
