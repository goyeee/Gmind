import { Module } from '@nestjs/common';
import { LocalDiskProvider } from './local-disk.provider';
import { StorageService } from './storage.service';

/**
 * 存储核心（M3b Task 1，准入 7.8 提取的叶子模块）：纯对象操作——LocalDiskProvider
 * 与 StorageService（saveImage/getImage/copyImage/deletePrefix），不 import 任何业务模块。
 *
 * 存在理由（DI 图无环裁定）：FilesService.copyForUser 需要图片对象迁移（copyImage），
 * 而 StorageModule 的写端点鉴权又依赖 FilesService.canAccess——若 FilesModule 直接收缩
 * 到 StorageModule 取 StorageService，则 FilesModule→StorageModule→FilesModule 成环。
 * 抽出本叶子模块后：FilesModule→StorageCoreModule（迁移）与
 * StorageModule→{UsersModule, FilesModule, StorageCoreModule}（鉴权端点层）分属两条
 * 无环边；TrashModule→StorageModule→StorageService（purge 前缀清理）经 re-export 原样可用。
 */
@Module({
  providers: [LocalDiskProvider, StorageService],
  exports: [LocalDiskProvider, StorageService],
})
export class StorageCoreModule {}
