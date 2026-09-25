import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileEntity } from '../files/file.entity';
import { MailModule } from '../mail/mail.module';
import { NotificationEntity } from '../notifications/notification.entity';
import { TrashModule } from '../trash/trash.module';
import { UserEntity } from '../users/user.entity';
import { VersionEntity } from '../versions/version.entity';
import { CleanupService } from './cleanup.service';
import { DigestService } from './digest.service';

@Module({
  // TrashModule 提供 TrashService（purgeFile 复用，已导出）；MailModule 提供 MailService
  imports: [TypeOrmModule.forFeature([FileEntity, NotificationEntity, UserEntity, VersionEntity]), TrashModule, MailModule],
  providers: [CleanupService, DigestService],
  exports: [CleanupService, DigestService], // main.ts 定时注册（app.get）与 e2e 直调
})
export class JobsModule {}
