import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';
import { EventsQueryService } from './events-query.service';

/**
 * limit 收拢（binding）：clamp 1..100；缺失/不可解析 → 缺省 50。遥测读口从宽——
 * 越界/非法值收拢为合法区间而非 400：动态面板是旁路视图，不与主业务争错误面。
 */
function parseLimit(query: unknown): number {
  const raw = (query as Record<string, unknown> | null | undefined)?.limit;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}

/**
 * 文档动态端点（M6 Task 8，企微对标，FR-COL-007 提前）：GET /api/files/:fileId/events。
 *
 * 挂 /api/files/:fileId/events（REST 层级隶属文件资源；与 versions/comments 的
 * :id/versions、:id/comments 兄弟路径互不重叠，Express 精确匹配无歧义）。
 * canAccess 口径（service 内 findAliveOr404），无权限/不存在统一 404。
 * type 中文化由 web 侧做（服务端只回原值）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/files')
@UseGuards(UserGuard)
export class EventsQueryController {
  constructor(@Inject(EventsQueryService) private readonly eventsQuery: EventsQueryService) {}

  @Get(':fileId/events')
  list(
    @Req() req: { user: { id: string } },
    @Param('fileId') fileId: string,
    @Query() query: unknown,
  ) {
    return this.eventsQuery.list(req.user.id, fileId, parseLimit(query));
  }
}
