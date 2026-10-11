import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserGuard } from '../auth/user.guard';
import { UsersService } from './users.service';
import { StorageService, MAX_IMAGE_BYTES } from '../storage/storage.service';
import { avatarSchema, changePasswordSchema, notifyPrefsSchema, rebindRequestSchema } from './users-request.schema';

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
    // fullUser 由 UserGuard 装配：id/nickname/avatarUrl + phone/email/hasPassword
    // （M5 Task 1：账号设置页按身份形态渲染改密区与换绑区）
    return req.fullUser;
  }

  /** 改密（FR-ACC-002 收口）：有密码须 currentPassword，无密码须 code（开发 123456）。 */
  @Post('me/password')
  @HttpCode(204)
  async changePassword(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.changePassword(req.user.id, changePasswordSchema.parse(body));
  }

  /** 换绑（FR-ACC-002 收口）：code → 格式 → 占用（409）→ 落列。 */
  @Post('me/rebind')
  @HttpCode(204)
  async rebind(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    await this.users.rebind(req.user.id, rebindRequestSchema.parse(body));
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
