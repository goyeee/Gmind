import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './user.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { StorageCoreModule } from '../storage/storage-core.module';
import { MailModule } from '../mail/mail.module';
import { EmailCodeService } from '../auth/email-code.service';

@Module({
  // StorageCoreModule（2026-10-11 头像上传）：StorageService.saveAvatar——叶子模块
  // 无环（FilesModule 同款取法）。
  // MailModule + EmailCodeService（2026-11-12 账号体系重做）：UsersService.rebindEmail
  // 验码消费 EmailCodeService（其内部再依赖 MailService）；Redis 由 @Global 的
  // SessionModule 提供。导出 EmailCodeService 供 AuthModule（已 import 本模块）复用，
  // 免二次注册双实例。
  imports: [TypeOrmModule.forFeature([UserEntity]), StorageCoreModule, MailModule],
  providers: [UsersService, EmailCodeService],
  controllers: [UsersController],
  exports: [UsersService, EmailCodeService],
})
export class UsersModule {}
