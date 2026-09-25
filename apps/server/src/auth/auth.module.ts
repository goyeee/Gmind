import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ShareModule } from '../share/share.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UserGuard } from './user.guard';
import { DevEmailProvider } from './providers/dev-email.provider';
import { DevPhoneProvider } from './providers/dev-phone.provider';
import { DevWechatProvider } from './providers/dev-wechat.provider';

@Module({
  // UsersService/FilesService 非 global：AuthService/DevEmailProvider/UserGuard 依赖它们，必须显式引入；
  // ShareModule 提供 InviteService（FR-SHR-004 注册回填）；SessionService 由 @Global 的 SessionModule 全局提供，无需引入。
  imports: [UsersModule, FilesModule, ShareModule],
  controllers: [AuthController],
  providers: [AuthService, UserGuard, DevPhoneProvider, DevEmailProvider, DevWechatProvider],
})
export class AuthModule {}
