import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { emailCodeRequestSchema, loginSchema, passwordResetSchema, registerSchema } from './auth-request.schema';
import { AuthService } from './auth.service';
import { EmailCodeService } from './email-code.service';
import { SessionService } from '../session/session.service';
import { UsersService } from '../users/users.service';
import { UserGuard } from './user.guard';
import type { LoginResponse } from '@gmind/shared';

@Controller('api/auth')
export class AuthController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(EmailCodeService) private readonly emailCode: EmailCodeService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** 发码（2026-11-12 重做）：发码前按场景做存在性闸——register 已注册 → 409、
   *  password_reset 未注册 → 404（文案两段式逐字，简报裁定）；email_bind 无前置
   *  （换绑由会话+密码核身把关）。闸不消耗 60s 重发冷却。方法名避开发注入属性
   *  emailCode（同名会被实例属性遮蔽，端点必坏）。 */
  @Post('email-code')
  @HttpCode(204)
  async issueEmailCode(@Body() body: unknown): Promise<void> {
    const { scene, email } = emailCodeRequestSchema.parse(body);
    if (scene === 'register' && (await this.users.findByEmail(email))) {
      throw new ConflictException('该邮箱已注册，请直接登录或换用其他邮箱');
    }
    if (scene === 'password_reset' && !(await this.users.findByEmail(email))) {
      throw new NotFoundException('该邮箱尚未注册，请确认后重试或先注册');
    }
    await this.emailCode.issue(scene, email);
  }

  /** 邮箱+密码登录：schema（含邮箱归一 trim+lowercase）parse 后即进 service。 */
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown): Promise<LoginResponse> {
    const { account, password, rememberMe } = loginSchema.parse(body);
    return this.authService.login(account, password, rememberMe === true);
  }

  /** 注册即登录：验码在 service（码错 400），邮箱并发占用兜底 409。 */
  @Post('register')
  @HttpCode(200)
  async register(@Body() body: unknown): Promise<LoginResponse> {
    return this.authService.register(registerSchema.parse(body));
  }

  /** 忘记密码重置：成功 204（成功即吊销该用户全部会话，见 service）。 */
  @Post('password-reset')
  @HttpCode(204)
  async passwordReset(@Body() body: unknown): Promise<void> {
    await this.authService.resetPassword(passwordResetSchema.parse(body));
  }

  @Post('logout')
  @UseGuards(UserGuard)
  @HttpCode(200)
  async logout(@Req() req: { sessionToken: string }): Promise<{ ok: true }> {
    await this.authService.logout(req.sessionToken);
    return { ok: true };
  }

  /** 一次性 WS/SSE 票据（2026-10-28 P0）：浏览器 WebSocket/EventSource 不能自定义
   *  Authorization 头，URL query 不再带长效 session token——换 60s 单次 ticket。 */
  @Post('ws-ticket')
  @UseGuards(UserGuard)
  @HttpCode(200)
  async wsTicket(@Req() req: { user: { id: string } }): Promise<{ ticket: string }> {
    return this.sessions.issueWsTicket(req.user.id);
  }
}
