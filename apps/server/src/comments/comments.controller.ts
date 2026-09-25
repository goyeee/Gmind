import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { UserGuard } from '../auth/user.guard';
import { createCommentSchema, createReplySchema } from './comment.schema';
import { CommentsService } from './comments.service';

/**
 * 评论域端点（M3b Task 6，FR-CMT-001/003）。
 *
 * 挂 /api/files/:id/comments 与 /api/files/:id/comments/:commentId/replies（REST 层级隶属
 * 文件资源；与 FilesController 的 :id/open、ShareManageController 的 :id/share 等
 * 兄弟路径互不重叠，Express 精确匹配无歧义）。均 canAccess 口径（owner 或协作者），
 * 无权限/不存在/已删统一 404（service 内判定）。请求体边界由 zod schema 在此层拒绝
 * （ZodExceptionFilter → 400）。
 * tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）。
 */
@Controller('api/files')
@UseGuards(UserGuard)
export class CommentsController {
  constructor(@Inject(CommentsService) private readonly comments: CommentsService) {}

  @Get(':id/comments')
  list(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.comments.listThreads(req.user.id, id);
  }

  @Post(':id/comments')
  create(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    const input = createCommentSchema.parse(body);
    return this.comments.create(req.user.id, id, input);
  }

  @Post(':id/comments/:commentId/replies')
  reply(
    @Req() req: { user: { id: string } },
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() body: unknown,
  ) {
    const input = createReplySchema.parse(body);
    return this.comments.reply(req.user.id, id, commentId, input);
  }
}
