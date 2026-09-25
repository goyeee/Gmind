import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { StorageController } from './storage.controller';
import { StorageCoreModule } from './storage-core.module';

@Module({
  // 纯对象操作（LocalDiskProvider/StorageService）移入 StorageCoreModule（M3b Task 1，
  // 准入 7.8：FilesService.copyForUser 的图片迁移需 copyImage，经叶子模块引入避免
  // FilesModule↔StorageModule 成环）；本模块只留鉴权端点层（StorageController 的
  // canAccess 校验依赖 FilesService）。UserGuard 依赖 UsersService——FilesModule 不转出
  // 其 imports，UsersModule 仍须在此显式引入；SessionModule 为 @Global。
  // 依赖走向 FilesModule→{UsersModule, CollabModule, StorageCoreModule}、
  // StorageModule→{UsersModule, FilesModule, StorageCoreModule}，无环。
  imports: [UsersModule, FilesModule, StorageCoreModule],
  controllers: [StorageController],
  // TrashModule（purge 前缀清理）等沿用 StorageModule 取 StorageService：
  // re-export 导入的 StorageCoreModule（Nest 静态扫描不允许直接 re-export
  // 导入模块的 provider 类，必须整模块转出），下游可注入其全部导出提供者。
  exports: [StorageCoreModule],
})
export class StorageModule {}
