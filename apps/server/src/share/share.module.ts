import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
import { UsersModule } from '../users/users.module';
import { ShareLinkEntity } from './share-link.entity';
import { ShareManageController, SharePublicController } from './share.controller';
import { ShareService } from './share.service';

@Module({
  // UserGuard 依赖 UsersService（UsersModule 显式引入，SessionModule 为 @Global）；
  // FileEntity/FileCollaboratorEntity：join 写协作者行与文件存活判定；UserEntity：ownerName 投影
  imports: [TypeOrmModule.forFeature([ShareLinkEntity, FileEntity, FileCollaboratorEntity, UserEntity]), UsersModule],
  providers: [ShareService],
  controllers: [ShareManageController, SharePublicController],
})
export class ShareModule {}
