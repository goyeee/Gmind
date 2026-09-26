import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { MailModule } from '../mail/mail.module';
import { NotifyModule } from '../notify/notify.module';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { InviteEntity } from './invite.entity';
import { InviteService } from './invite.service';
import { ShareLinkEntity } from './share-link.entity';
import { ShareManageController, SharePublicController } from './share.controller';
import { ShareService } from './share.service';

@Module({
  // UserGuard 依赖 UsersService（UsersModule 显式引入，SessionModule 为 @Global）；
  // FileEntity/FileCollaboratorEntity：join 写协作者行与文件存活判定；UserEntity：ownerName 投影；
  // InviteEntity：批量邀请（FR-SHR-004）；MailModule：邀请邮件（尽力而为旁路）；
  // NotifyModule：join/回填成功 → owner permission 通知（M4 清偿包，尽力而为旁路）；
  // EventsModule（M5 Task 4）：invite_send/collab_join 漏斗埋点（模块不依赖任何业务域，无环）。
  imports: [TypeOrmModule.forFeature([ShareLinkEntity, InviteEntity, FileEntity, FileCollaboratorEntity, UserEntity]), UsersModule, MailModule, NotifyModule, EventsModule],
  providers: [ShareService, InviteService],
  controllers: [ShareManageController, SharePublicController],
  // InviteService 导出给 AuthModule：注册回填（新用户首登自动接受 pending 邀请）
  exports: [InviteService],
})
export class ShareModule {}
