import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
import { DevE2eController } from './dev-e2e.controller';

/** 开发/e2e 编排端点模块（见 dev-e2e.controller.ts 的纪律说明）。 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, FileEntity, FileCollaboratorEntity])],
  controllers: [DevE2eController],
})
export class DevE2eModule {}
