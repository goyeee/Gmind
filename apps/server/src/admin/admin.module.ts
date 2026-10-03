import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { AdminGuard } from '../auth/admin.guard';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  // UserEntity/FileEntity（成员列表、fileCount 聚合）；UsersModule：控制器挂的 UserGuard
  // 依赖 UsersService（UsersModule 非 global，须显式引入才能在本模块上下文解析——同 FilesModule 先例）。
  // AdminGuard 无构造依赖，注册于本模块供控制器解析（与 AuthModule 持有 UserGuard 同例）
  imports: [UsersModule, TypeOrmModule.forFeature([UserEntity, FileEntity])],
  providers: [AdminService, AdminGuard],
  controllers: [AdminController],
})
export class AdminModule {}
