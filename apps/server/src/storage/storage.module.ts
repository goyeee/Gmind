import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { LocalDiskProvider } from './local-disk.provider';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  // FilesModule 提供 FilesService（写端点属主校验 canAccess，M3a 准入 7.2；FilesModule 已导出该服务）。
  // UserGuard 依赖 UsersService——FilesModule 不转出其 imports，UsersModule 仍须在此显式引入；
  // SessionModule 为 @Global。依赖走向 FilesModule→UsersModule、StorageModule→二者，无环。
  imports: [UsersModule, FilesModule],
  providers: [LocalDiskProvider, StorageService],
  controllers: [StorageController],
  exports: [StorageService],
})
export class StorageModule {}
