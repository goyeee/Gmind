import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ShareModule } from '../share/share.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserGuard } from './user.guard';

@Module({
  // UsersModule 导出 UsersService+EmailCodeService（Task 3 装配，此处复用免双实例）；
  // FilesService 非 global：AuthService 依赖它，必须显式引入；ShareModule 提供
  // InviteService（FR-SHR-004 注册/登录回填）；SessionService 由 @Global 的
  // SessionModule 全局提供，无需引入。三 Provider（phone/email/wechat 登录通道）
  // 已随邮箱注册制删除（providers/ 整目录）。
  imports: [UsersModule, FilesModule, ShareModule],
  controllers: [AuthController],
  providers: [AuthService, UserGuard],
})
export class AuthModule {}
