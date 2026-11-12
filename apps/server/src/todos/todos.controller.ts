import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { TodoPage, TodoReport } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { TodosService } from './todos.service';
import { patchTodoSchema, remindTodoSchema } from './todos-request.schema';

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
}
