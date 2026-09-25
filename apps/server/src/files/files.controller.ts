import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { createFileSchema } from '@gmind/shared';
import { UserGuard } from '../auth/user.guard';
import { FilesService } from './files.service';

// PUT doc-state 的传输契约：Yjs 状态二进制以 base64 编码（body { docState }）；
// baseUpdatedAt（M3a 准入 7.1）为客户端记录的行 updated_at（GET/持久化 ack 下发），
// 缺省视为无 base——兼容旧客户端与首次保存（守卫永远放行，不在此处强校验格式：
// 非法值由 service 按无 base 口径放行）。lastEditorUserId（M3a Task 4）为客户端
// last_modifier 离线补报：服务端仅在其值 === token 用户时落库（防代写）。
const docStateSchema = z.object({
  docState: z.string().min(1),
  baseUpdatedAt: z.string().optional(),
  lastEditorUserId: z.string().min(1).max(26).optional(),
});

// GET /api/files 的视图参数（M3a Task 4，FR-FIL-001）：缺省 mine；非法值 400。
const listViewSchema = z.object({ view: z.enum(['mine', 'shared', 'starred', 'recent']).default('mine') });

// PATCH /api/files/:id（M3a Task 5，FR-FIL-002）：title 与 folderId 均可选、至少其一；
// folderId null → 移回根目录。title 规则复用 createFileSchema（ZodOptional 短路 undefined，
// 缺省「未命名脑图」的 default 不触发）。
const patchFileSchema = z
  .object({
    title: createFileSchema.shape.title.optional(),
    folderId: z.string().min(1).max(26).nullable().optional(),
  })
  .refine((v) => v.title !== undefined || v.folderId !== undefined, {
    message: '至少提供 title 或 folderId',
  });

@Controller('api/files')
@UseGuards(UserGuard)
export class FilesController {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  list(@Req() req: { user: { id: string } }, @Query() query: unknown) {
    const { view } = listViewSchema.parse(query ?? {});
    return this.files.listByView(req.user.id, view);
  }

  @Post()
  async create(@Req() req: { user: { id: string } }, @Body() body: unknown) {
    const { title } = createFileSchema.parse(body ?? {});
    // 按 FileListItem 契约序列化，避免裸实体（含 docState Buffer）被 Nest 原样序列化
    const created = await this.files.createForUser(req.user.id, { title });
    return this.files.toListItem(created);
  }

  @Get(':id')
  getContent(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.getOwnedFileWithState(req.user.id, id);
  }

  /** 协作者/owner 候选列表（M3b Task 8，FR-CMT-005）：评论 @mention 的可选人
   *  （owner + collaborators，JOIN users nickname）；canAccess 口径（含协作者）。 */
  @Get(':id/collaborators')
  listCollaborators(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.listCollaborators(req.user.id, id);
  }

  @Put(':id/doc-state')
  async saveDocState(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    const { docState, baseUpdatedAt, lastEditorUserId } = docStateSchema.parse(body ?? {});
    const state = new Uint8Array(Buffer.from(docState, 'base64'));
    return this.files.saveDocState(req.user.id, id, state, baseUpdatedAt, lastEditorUserId);
  }

  @Patch(':id')
  async update(@Req() req: { user: { id: string } }, @Param('id') id: string, @Body() body: unknown) {
    return this.files.renameAndMove(req.user.id, id, patchFileSchema.parse(body ?? {}));
  }

  @Post(':id/open')
  @HttpCode(200) // 打开是幂等动作而非资源创建，返回 200
  markOpened(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.markOpened(req.user.id, id);
  }

  @Post(':id/copy')
  async copy(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    // POST 创建新资源 → 201；响应走 toListItem 契约（与 POST /api/files 一致，docState 不外泄）
    const created = await this.files.copyForUser(req.user.id, id);
    return this.files.toListItem(created);
  }

  @Put(':id/star')
  @HttpCode(200) // 加星是幂等动作（重复加星 no-op）而非资源创建，返回 200
  star(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.star(req.user.id, id);
  }

  @Delete(':id/star')
  @HttpCode(200) // 取消星标幂等（无星行 no-op），非资源删除语义之外的创建/查询
  unstar(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    return this.files.unstar(req.user.id, id);
  }

  @Delete(':id')
  @HttpCode(200) // 软删是幂等动作（重复删 404 除外），非资源创建；owner only（PRD 2.2.1）
  async remove(@Req() req: { user: { id: string } }, @Param('id') id: string) {
    await this.files.deleteOwned(req.user.id, id);
    return { ok: true as const };
  }
}

// GET /api/search 的查询参数（M3a Task 8，FR-FIL-008）：q 必填（trim 后非空——缺失/
// 空串/纯空白一律 400）；上限 255 与 title 列同宽（更长的关键词不可能命中）。
export const searchQuerySchema = z.object({
  q: z.string({ required_error: '搜索关键词不能为空' }).trim().min(1, '搜索关键词不能为空').max(255),
});

/** 标题全局搜索（M3a Task 8，FR-FIL-008）：GET /api/search?q= → FileListItemDetailed[]。
 *  独立路由前缀（/api/search），与 /api/files/:id 的 Param 路由互不干扰。 */
@Controller('api/search')
@UseGuards(UserGuard)
export class SearchController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Get()
  search(@Req() req: { user: { id: string } }, @Query() query: unknown) {
    const { q } = searchQuerySchema.parse(query ?? {});
    return this.files.searchByTitle(req.user.id, q);
  }
}
