import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { emailLoginSchema } from '@gmind/shared';
import { compare } from 'bcryptjs';
import { env } from '../../config/env';
import { UsersService } from '../../users/users.service';
import type { LoginIdentity } from '../../users/users.service';
import type { LoginProvider } from './login-provider.interface';

@Injectable()
export class DevEmailProvider implements LoginProvider {
  readonly method = 'email' as const;

  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  async authenticate(payload: unknown): Promise<LoginIdentity> {
    const parsed = emailLoginSchema.parse(payload);
    if (parsed.mode === 'code') {
      if (parsed.code !== env.DEV_SMS_CODE) throw new UnauthorizedException('验证码错误');
      return { method: 'email', email: parsed.email };
    }
    // 密码模式：用户必须已存在且已设置密码
    const user = await this.users.findByIdentity({ method: 'email', email: parsed.email });
    if (!user?.passwordHash || !parsed.password || !(await compare(parsed.password, user.passwordHash))) {
      throw new UnauthorizedException('邮箱或密码错误');
    }
    return { method: 'email', email: parsed.email };
  }
}
