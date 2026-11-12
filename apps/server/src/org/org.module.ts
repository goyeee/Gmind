import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';
import { OrgDepartmentEntity, OrgGroupEntity, OrgUserGroupEntity } from './org.entity';

/**
 * 组织管理（部门/分组）模块（第二期批次 A）：OrgService 导出供 AdminModule 挂靠写。
 * UsersModule：控制器 @UseGuards(UserGuard) 的依赖解析（同 admin.module 先例——
 * UserGuard 依赖 UsersService；SessionService 由 @Global SessionModule 提供）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([OrgDepartmentEntity, OrgGroupEntity, OrgUserGroupEntity]), UsersModule],
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
