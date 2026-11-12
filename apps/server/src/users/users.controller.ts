import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserGuard } from '../auth/user.guard';
import { fullUserView, UsersService } from './users.service';
import { StorageService, MAX_IMAGE_BYTES } from '../storage/storage.service';
import {
  avatarSchema,
  changePasswordSchema,
  notifyPrefsSchema,
  rebindEmailSchema,
  rebindPhoneSchema,
  updateNicknameSchema,
} from './users-request.schema';

@Controller('api/users')
@UseGuards(UserGuard)
export class UsersController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  @Get('me')
  me(@Req() req: { user: { id: string }; fullUser?: unknown }): unknown {
    // fullUser 由 UserGuard 经 fullUserView 装配：id/nickname/avatarUrl + phone/email/hasPassword
    // （账号设置页按身份形态渲染改密区与换绑区）
    return req.fullUser;
  }

  /** 改密（2026-11-12 重做）：恒旧密码核身（验证码分支已删），成功 204。 */
  @Post('me/password')
  @HttpCode(204)
  async changePassword(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.changePassword(req.user.id, changePasswordSchema.parse(body));
  }

  /** 换绑邮箱（2026-11-12 重做）：当前密码 + email_bind 验证码；被占 409，成功 204。 */
  @Post('me/email')
  @HttpCode(204)
  async rebindEmail(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.rebindEmail(req.user.id, rebindEmailSchema.parse(body));
  }

  /** 换绑手机号（2026-11-12 重做）：仅当前密码核身；被占 409，成功 204。 */
  @Post('me/phone')
  @HttpCode(204)
  async rebindPhone(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.rebindPhone(req.user.id, rebindPhoneSchema.parse(body));
  }

  /** 自助改昵称（2026-11-12 重做）：返回设置后的账号视图（形状同 GET me，前端一次刷新）。 */
  @Patch('me')
  async updateNickname(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<unknown> {
    const user = await this.users.updateNickname(req.user.id, updateNicknameSchema.parse(body).nickname);
    return fullUserView(user);
  }

  /** 通知偏好（FR-CMT-006）：GET 返回解析形态；PATCH 全量替换（非法成员 400）。 */
  @Get('me/notify-prefs')
  getNotifyPrefs(@Req() req: { user: { id: string } }): Promise<unknown> {
    return this.users.getNotifyPrefs(req.user.id);
  }

  @Patch('me/notify-prefs')
  setNotifyPrefs(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<unknown> {
    return this.users.setNotifyPrefs(req.user.id, notifyPrefsSchema.parse(body));
  }

  /** 头像预置选择（2026-10-11）：body {avatarUrl}——预置 SVG 或本人上传键（白名单
   *  在 service），返回设置后的视图。 */
  @Patch('me/avatar')
  setAvatar(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<unknown> {
    return this.users.setAvatar(req.user.id, avatarSchema.parse(body).avatarUrl);
  }

  /** 头像上传（2026-10-11）：multipart 单文件（png/jpg/gif/webp ≤10MB，魔数嗅探）→
   *  users/{userId}/{ulid}.{ext} 键 → 直接定为当前头像（一步语义，无需二次 PATCH）。 */
  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMAGE_BYTES } }))
  async uploadAvatar(
    @Req() req: { user: { id: string } },
    @UploadedFile() file: { buffer?: Buffer } | undefined,
  ): Promise<unknown> {
    if (!file?.buffer) throw new BadRequestException('请选择要上传的图片');
    const { key } = await this.storage.saveAvatar(req.user.id, file.buffer);
    return this.users.setAvatar(req.user.id, key);
  }
}
