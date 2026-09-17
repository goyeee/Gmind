import { Injectable, UnauthorizedException } from '@nestjs/common';
import { phoneLoginSchema } from '@gmind/shared';
import { env } from '../../config/env';
import type { LoginIdentity } from '../../users/users.service';
import type { LoginProvider } from './login-provider.interface';

/** 开发环境：验证码固定值（spec §5.2），生产替换为真实短信 Provider。 */
@Injectable()
export class DevPhoneProvider implements LoginProvider {
  readonly method = 'phone' as const;

  async authenticate(payload: unknown): Promise<LoginIdentity> {
    const { phone, code } = phoneLoginSchema.parse(payload);
    if (code !== env.DEV_SMS_CODE) throw new UnauthorizedException('验证码错误');
    return { method: 'phone', phone };
  }
}
