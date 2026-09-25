import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { NotificationEntity } from '../notifications/notification.entity';
import { NotificationsController, NotifyStreamController } from './notify.controller';
import { NotifyService } from './notify.service';

/**
 * 站内通知域（M3b Task 8，FR-CMT-005）。NotificationEntity 已在 database.module 注册
 * （M0 init 建表；M3a Task 7 回收站提醒路径已 forFeature），此处仅仓库接线。
 * SessionModule 为 @Global（SessionService 直注）；UsersModule 供 SSE query-token
 * 鉴权查用户。CommentsModule 引入本模块以触发 mention/reply 通知（本模块不反向依赖
 * 评论/文件域，无环）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([NotificationEntity]), UsersModule],
  providers: [NotifyService],
  controllers: [NotifyStreamController, NotificationsController],
  exports: [NotifyService],
})
export class NotifyModule {}
