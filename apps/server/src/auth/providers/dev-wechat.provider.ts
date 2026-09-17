import { Injectable } from '@nestjs/common';
import { wechatLoginSchema } from '@gmind/shared';
import type { LoginProvider } from './login-provider.interface';

/** 开发环境：模拟微信扫码，openid 可指定（便于多账号测试），生产替换为真实微信 OAuth。 */
@Injectable()
export class DevWechatProvider implements LoginProvider {
  readonly method = 'wechat' as const;

  async authenticate(payload: unknown) {
    const { mockOpenid, nickname } = wechatLoginSchema.parse(payload ?? {});
    return {
      method: 'wechat' as const,
      wechatOpenid: mockOpenid ?? 'dev-wechat-openid-default',
      nickname: nickname ?? '微信用户',
    };
  }
}
