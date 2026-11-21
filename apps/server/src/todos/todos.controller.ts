import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { TodoActivityItem, TodoPage, TodoReport, TodoScope } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { TodosService } from './todos.service';
import { patchTodoSchema, remindTodoSchema, scopeUpdateSchema } from './todos-request.schema';

/**
 * 跨文件待办端点（/api/todos，第二期批次 B/C）：全部 UserGuard 登录即可——
 * 数据范围天然按「负责人含我 + 可见文件」收敛，无需管理口。
 */
@Controller('api/todos')
@UseGuards(UserGuard)
export class TodosController {
  constructor(@Inject(TodosService) private readonly todos: TodosService) {}

  @Get()
  page(
    @Req() req: { user: { id: string } },
    @Query('view') view?: string,
    @Query('tab') tab?: string,
    @Query('who') who?: string,
  ): Promise<TodoPage> {
    const v = ['all', 'today', 'overdue', 'week'].includes(view ?? '') ? view! : 'all';
    const t = tab === 'done' ? 'done' : 'open';
    return this.todos.page(req.user.id, v, t, who && who !== '' ? who : undefined);
  }

  @Patch(':fileId/:nodeId')
  async patch(
    @Req() req: { user: { id: string } },
    @Param('fileId') fileId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    await this.todos.patchTask(req.user.id, fileId, nodeId, patchTodoSchema.parse(body ?? {}));
    return { ok: true };
  }

  @Post('remind')
  @HttpCode(200) // 动作语义非资源创建
  async remind(
    @Req() req: { user: { id: string }; fullUser?: { nickname?: string } },
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const input = remindTodoSchema.parse(body ?? {});
    await this.todos.remind(
      req.user.id,
      req.fullUser?.nickname ?? '协作者',
      input.fileId,
      input.nodeId,
      input.ownerUserId,
    );
    return { ok: true };
  }

  @Get('report')
  report(@Req() req: { user: { id: string } }, @Query('range') range?: string): Promise<TodoReport> {
    const r = ['today', 'week', 'month', 'all'].includes(range ?? '') ? range! : 'all';
    return this.todos.report(req.user.id, r);
  }

  /** 参与范围配置（2026-11-21 需求方追加）：GET 读、PUT 增删排除行（幂等）。
   *  配置默认全关联（无行即参与）；文件级（canvasId 缺省 ''）与画布级两级。 */
  @Get('scope')
  scope(@Req() req: { user: { id: string } }): Promise<TodoScope> {
    return this.todos.scope(req.user.id);
  }

  @Put('scope')
  async setScope(@Req() req: { user: { id: string } }, @Body() body: unknown): Promise<{ ok: true }> {
    const input = scopeUpdateSchema.parse(body ?? {});
    await this.todos.setScope(req.user.id, { fileId: input.fileId, canvasId: input.canvasId ?? '', excluded: input.excluded });
    return { ok: true };
  }

  /** 跨文件任务动态流（第二轮 spec §5.5）：limit 收拢 1..100（同 events-query 口径，
   *  旁路视图非法值收拢为合法区间而非 400），上限内整数内联进 SQL（LIMIT 占位符
   *  经 mysql2 转义为带引号字面量会语法错误，整数由本处 clamp 保证无注入面）。 */
  @Get('activity')
  activity(@Req() req: { user: { id: string } }, @Query('limit') limit?: string): Promise<{ items: TodoActivityItem[] }> {
    const n = typeof limit === 'string' && limit !== '' ? Number(limit) : NaN;
    const clamped = Number.isFinite(n) ? Math.min(100, Math.max(1, Math.trunc(n))) : 50;
    return this.todos.activity(req.user.id, clamped);
  }
}
