import { Controller, Get, Inject, Param, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { UserGuard } from '../auth/user.guard';
import { SessionService } from '../session/session.service';
import { UsersService } from '../users/users.service';
import { NotifyService } from './notify.service';

/**
 * 站内通知端点（M3b Task 8，FR-CMT-005）。
 *
 * GET /api/notify（SSE 长连接）不走 UserGuard：EventSource 浏览器 API 不允许携带
 * Authorization header，token 只能经 query 传递——与 WS 升级 ?token= 同一裁定口径
 * （CollabService.authenticate 回落 requestParameters.get('token')）：validate 会话、
 * 校验用户，无效一律 401。响应头 text/event-stream 写入后交给 NotifyService 注册；
 * 30s 心跳与连接摘除均在 service 内。
 *
 * /api/notifications 三端点为常规 REST，UserGuard（Bearer header）鉴权。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/notify')
export class NotifyStreamController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(NotifyService) private readonly notify: NotifyService,
  ) {}

  @Get()
  async stream(@Req() req: Request, @Res() res: Response): Promise<void> {
    const raw = req.query['token'];
    const token = typeof raw === 'string' ? raw : '';
    const session = token ? await this.sessions.validate(token) : null;
    const user = session ? await this.users.findById(session.userId) : null;
    if (!user) throw new UnauthorizedException('未登录或会话已过期');

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // nginx 等反代缓冲会吞掉流式帧（vite 代理无缓冲，此头仅防御性）
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // 首帧立即写一条 SSE 注释帧：Node 下游（vite/http-proxy）不写 body 不发头部——
    // 首个真实事件或 30s 心跳前连接对客户端不可见（EventSource onopen 迟滞）。
    // 注释帧被 EventSource 忽略，纯为握手占位。
    res.write(': connected\n\n');
    this.notify.registerConnection(user.id, res);
    // 响应体由 NotifyService 推送/心跳管理，handler 到此结束（连接保持打开）
  }
}

@Controller('api/notifications')
@UseGuards(UserGuard)
export class NotificationsController {
  constructor(@Inject(NotifyService) private readonly notify: NotifyService) {}

  @Get()
  list(@Req() req: { user: { id: string } }) {
    return this.notify.list(req.user.id);
  }

  @Get('unread-count')
  unreadCount(@Req() req: { user: { id: string } }) {
    return this.notify.unreadCount(req.user.id);
  }

  @Post(':id/read')
  markRead(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.notify.markRead(req.user.id, id);
  }
}
