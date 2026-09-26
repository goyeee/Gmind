import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabModule } from '../collab/collab.module';
import { EventsModule } from '../events/events.module';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FilesModule } from '../files/files.module';
import { NotifyModule } from '../notify/notify.module';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { CommentEntity } from './comment.entity';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  // UserGuard 依赖 UsersService（UsersModule 显式引入，SessionModule 为 @Global）；
  // FilesModule：getOwnedFileWithState 单点提供「存活 + canAccess + docState」（404 口径）；
  // CollabModule（无环：collab 不反向依赖任何业务模块）：broadcastStateless 评论更新广播；
  // NotifyModule（M3b Task 8，FR-CMT-005）：评论/回复落库后触发 mention/reply 通知；
  // EventsModule（M5 Task 4）：comment_create 埋点（模块不依赖任何业务域，无环）。
  imports: [TypeOrmModule.forFeature([CommentEntity, FileCollaboratorEntity, UserEntity]), UsersModule, FilesModule, CollabModule, NotifyModule, EventsModule],
  providers: [CommentsService],
  controllers: [CommentsController],
})
export class CommentsModule {}
