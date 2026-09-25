import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';
import { trackEventSchema } from './event.schema';
import { EventsService } from './events.service';

/**
 * 埋点端点（M4 Task 7）：POST /api/events。
 *
 * 登录即可（UserGuard，不校验 fileId 归属——埋点是遥测通道，允许上报非本人/已删文件的
 * 行为事实）；body 由 zod schema 拒绝非法形状（ZodExceptionFilter → 400）；成功 204
 * 无返回体（埋点是 fire-and-forget 上报，无资源创建语义之外的载荷可回）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/events')
@UseGuards(UserGuard)
export class EventsController {
  constructor(@Inject(EventsService) private readonly events: EventsService) {}

  @Post()
  @HttpCode(204)
  async track(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<void> {
    const input = trackEventSchema.parse(body);
    await this.events.record(input.type, input.fileId ?? null, req.user.id, input.payload);
  }
}
