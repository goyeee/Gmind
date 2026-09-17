import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { authRequestSchema } from './auth-request.schema';
import { AuthService } from './auth.service';
import { UserGuard } from './user.guard';
import { DevEmailProvider } from './providers/dev-email.provider';
import { DevPhoneProvider } from './providers/dev-phone.provider';
import { DevWechatProvider } from './providers/dev-wechat.provider';
import type { LoginMethod } from '@gmind/shared';

@Controller('api/auth')
export class AuthController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(DevPhoneProvider) private readonly phoneProvider: DevPhoneProvider,
    @Inject(DevEmailProvider) private readonly emailProvider: DevEmailProvider,
    @Inject(DevWechatProvider) private readonly wechatProvider: DevWechatProvider,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<unknown> {
    // password 保留在 loginPayload 中：emailLoginSchema 的 refine 要求密码模式必须带 password，
    // Provider 二次解析时需要它（不能提前解构剥离）。
    const { rememberMe, ...loginPayload } = authRequestSchema.parse(body);
    const provider = ({ phone: this.phoneProvider, email: this.emailProvider, wechat: this.wechatProvider })[
      loginPayload.method as LoginMethod
    ];
    const identity = await provider.authenticate(loginPayload);
    return this.authService.login(identity, rememberMe === true, loginPayload.password);
  }

  @Post('logout')
  @UseGuards(UserGuard)
  @HttpCode(200)
  async logout(@Req() req: { sessionToken: string }): Promise<{ ok: true }> {
    await this.authService.logout(req.sessionToken);
    return { ok: true };
  }
}
