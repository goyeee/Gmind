import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { LocalDiskProvider } from './local-disk.provider';
import { StorageController } from './storage.controller';
import { StorageService } from './storage.service';

@Module({
  // UserGuard 依赖 UsersService；SessionModule 为 @Global，这里只需显式引入 UsersModule（同 FilesModule）
  imports: [UsersModule],
  providers: [LocalDiskProvider, StorageService],
  controllers: [StorageController],
  exports: [StorageService],
})
export class StorageModule {}
