import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CollabModule } from '../collab/collab.module';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FilesModule } from '../files/files.module';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { CommentEntity } from './comment.entity';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  // UserGuard 依赖 UsersService（UsersModule 显式引入，SessionModule 为 @Global）；
  // FilesModule：getOwnedFileWithState 单点提供「存活 + canAccess + docState」（404 口径）；
  // CollabModule（无环：collab 不反向依赖任何业务模块）：broadcastStateless 评论更新广播。
  imports: [TypeOrmModule.forFeature([CommentEntity, FileCollaboratorEntity, UserEntity]), UsersModule, FilesModule, CollabModule],
  providers: [CommentsService],
  controllers: [CommentsController],
})
export class CommentsModule {}
