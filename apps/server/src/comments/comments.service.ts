import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as Y from 'yjs';
import { createTemplateDoc, docFromState, getNode } from '@gmind/core';
import { CollabService } from '../collab/collab.service';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FilesService } from '../files/files.service';
import { UserEntity } from '../users/user.entity';
import { CommentEntity } from './comment.entity';
import type { CreateCommentInput, CreateReplyInput } from './comment.schema';

/** 快照列宽（node_text_snapshot varchar(500)）：按码点截断，与 MySQL utf8mb4 字符计数一致。 */
const SNAPSHOT_MAX_CHARS = 500;
/** 广播载荷类型（评论域唯一 stateless 消息，客户端据此拉取 GET /comments）。 */
const COMMENT_UPDATED_EVENT = 'comment-updated';

/** 评论视图条目（楼主/回复同形；楼主多一个 replies）。 */
export interface CommentView {
  id: string;
  fileId: string;
  nodeId: string;
  nodeTextSnapshot: string;
  nodeDeleted: boolean;
  author: { id: string; nickname: string };
  content: string;
  mentions: string[];
  createdAt: string;
}

export interface CommentThreadView extends CommentView {
  replies: CommentView[];
}

/**
 * 评论域（M3b Task 6，FR-CMT-001/003）。
 *
 * 权限：canAccess（owner 或协作者）——经 FilesService.getOwnedFileWithState 单点完成
 * 「存活文件 + 权限 + docState」读取，缺失/已删/无权限统一 404「文件不存在」不泄露存在性。
 *
 * 节点耦合语义（binding 裁定）：
 * - 创建评论要求节点存在于当前 docState（getNode !== null 且未墓碑）→ 否则 400
 *   「节点不存在或已删除」；nodeTextSnapshot 取创建时的节点文本（≤500 截断），此后不随
 *   节点编辑/删除变化（快照即历史）；
 * - 回复不做节点存在性校验：讨论不随节点死亡终止——已删节点的线程仍可回复；
 * - 楼中楼一律挂到线程楼主行：reply-to-reply 拍平到顶层祖先（嵌套回复无观察面）；
 * - GET 的 nodeDeleted 按当前 docState 存活集判定（每请求一次 decode，缓存复用）；
 *   counts 仅统计存活节点上的 open 评论（含回复），已删节点线程整体不计。
 *
 * 广播（FR-CMT-003）：创建/回复成功后经 CollabService.broadcastStateless 向该文件在线
 * 客户端发 {type:'comment-updated'}；无人在线为 no-op（客户端打开文件时本就会全量拉取）。
 */
@Injectable()
export class CommentsService {
  constructor(
    @InjectRepository(CommentEntity) private readonly repo: Repository<CommentEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(CollabService) private readonly collab: CollabService,
  ) {}

  /** GET /api/files/:id/comments：{threads, counts}。 */
  async listThreads(userId: string, fileId: string): Promise<{ threads: CommentThreadView[]; counts: Record<string, number> }> {
    const file = await this.files.getOwnedFileWithState(userId, fileId); // 404 统一口径
    const doc = this.decodeDocState(file.docState, file.title);
    const alive = this.aliveNodeIds(doc);

    const rows = await this.repo.find({ where: { fileId } });
    // 统一 ASC 基准（created_at 同毫秒按 ulid 单调性兜底），楼主 DESC / 回复 ASC 各自派生
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));

    const nicknames = await this.nicknamesOf(rows.map((r) => r.authorId));
    const views = new Map(rows.map((r) => [r.id, this.toView(r, alive, nicknames)]));

    const threads = rows
      .filter((r) => r.parentId === null)
      .reverse() // 楼层新在前（DESC）
      .map((r) => ({ ...views.get(r.id)!, replies: rows.filter((c) => c.parentId === r.id).map((c) => views.get(c.id)!) }));

    const counts: Record<string, number> = {};
    for (const r of rows) {
      if (r.status !== 'open' || !alive.has(r.nodeId)) continue; // resolved / 已删节点不计
      counts[r.nodeId] = (counts[r.nodeId] ?? 0) + 1;
    }
    return { threads, counts };
  }

  /** POST /api/files/:id/comments：节点须存在于当前 docState（400「节点不存在或已删除」）。 */
  async create(userId: string, fileId: string, input: CreateCommentInput): Promise<CommentThreadView> {
    const file = await this.files.getOwnedFileWithState(userId, fileId);
    const doc = this.decodeDocState(file.docState, file.title);
    const node = getNode(doc, input.nodeId);
    if (!node || node.deleted) throw new BadRequestException('节点不存在或已删除');

    const mentions = await this.filterMentions(file.ownerUserId, fileId, input.mentions);
    const row = await this.insert({
      fileId,
      nodeId: input.nodeId,
      parentId: null,
      nodeTextSnapshot: Array.from(node.text).slice(0, SNAPSHOT_MAX_CHARS).join(''),
      authorId: userId,
      content: input.content,
      mentions,
    });
    this.broadcast(fileId);
    return { ...this.toView(row, this.aliveNodeIds(doc), await this.nicknamesOf([row.authorId])), replies: [] };
  }

  /** POST /api/files/:id/comments/:commentId/replies：楼中楼挂到楼主（reply-to-reply 拍平），
   *  不做节点存在性校验（讨论不随节点死亡终止）；快照继承楼主行值。 */
  async reply(userId: string, fileId: string, commentId: string, input: CreateReplyInput): Promise<CommentView> {
    const file = await this.files.getOwnedFileWithState(userId, fileId);
    const doc = this.decodeDocState(file.docState, file.title);
    const alive = this.aliveNodeIds(doc);

    const target = await this.repo.findOne({ where: { id: commentId, fileId } });
    if (!target) throw new NotFoundException('评论不存在');
    // 拍平语义：目标已是回复 → 取其楼主；目标是楼主 → 取自身
    const root = target.parentId ? await this.repo.findOne({ where: { id: target.parentId, fileId } }) : target;
    if (!root) throw new NotFoundException('评论不存在'); // 线程根行缺失的数据异常：与不存在同口径

    const mentions = await this.filterMentions(file.ownerUserId, fileId, input.mentions);
    const row = await this.insert({
      fileId,
      nodeId: root.nodeId,
      parentId: root.id,
      nodeTextSnapshot: root.nodeTextSnapshot, // 继承楼主快照（不因节点编辑/删除重取）
      authorId: userId,
      content: input.content,
      mentions,
    });
    this.broadcast(fileId);
    return this.toView(row, alive, await this.nicknamesOf([row.authorId]));
  }

  // ---- 内部 ---------------------------------------------------------------

  private async insert(input: {
    fileId: string;
    nodeId: string;
    parentId: string | null;
    nodeTextSnapshot: string;
    authorId: string;
    content: string;
    mentions: string[];
  }): Promise<CommentEntity> {
    const row = this.repo.create();
    row.fileId = input.fileId;
    row.nodeId = input.nodeId;
    row.parentId = input.parentId;
    row.nodeTextSnapshot = input.nodeTextSnapshot;
    row.authorId = input.authorId;
    row.content = input.content;
    row.mentions = JSON.stringify(input.mentions); // text 列存 JSON 文本（统一 '[]'，不区分 null）
    return this.repo.save(row);
  }

  /** 行 → 视图（唯一出口）。nodeDeleted 按当前存活集判定；mentions 反序列化容错。 */
  private toView(row: CommentEntity, alive: Set<string>, nicknames: Map<string, string>): CommentView {
    let mentions: string[] = [];
    if (row.mentions) {
      try {
        const parsed: unknown = JSON.parse(row.mentions);
        if (Array.isArray(parsed)) mentions = parsed.filter((m): m is string => typeof m === 'string');
      } catch {
        mentions = []; // 坏 JSON 不炸接口（理论不可达：写入恒为 JSON.stringify 产物）
      }
    }
    return {
      id: row.id,
      fileId: row.fileId,
      nodeId: row.nodeId,
      nodeTextSnapshot: row.nodeTextSnapshot,
      nodeDeleted: !alive.has(row.nodeId),
      author: { id: row.authorId, nickname: nicknames.get(row.authorId) ?? '' },
      content: row.content,
      mentions,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** mentions 归一化（binding）：过滤为本文件 owner+协作者集合内的 userId，保序去重。
   *  非 collaborators 静默剔除而非 400——被 @ 的人是否可见是业务归一化问题，不构成非法输入。 */
  private async filterMentions(ownerUserId: string, fileId: string, mentions: string[] | undefined): Promise<string[]> {
    if (!mentions || mentions.length === 0) return [];
    const rows = await this.collabRepo.find({ where: { fileId }, select: ['userId'] });
    const allowed = new Set([ownerUserId, ...rows.map((r) => r.userId)]);
    const out: string[] = [];
    for (const m of mentions) {
      if (allowed.has(m) && !out.includes(m)) out.push(m);
    }
    return out;
  }

  private async nicknamesOf(authorIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(authorIds)];
    if (ids.length === 0) return new Map();
    const users = await this.userRepo.find({ where: { id: In(ids) }, select: ['id', 'nickname'] });
    return new Map(users.map((u) => [u.id, u.nickname]));
  }

  /** docState(base64) → Y.Doc（docFromState 入口全量 normalize）；空态 → 空白模板，
   *  解析失败 → 400（与 saveDocState 同口径文案——DB 行只由服务端写入，理论不可达）。 */
  private decodeDocState(docStateBase64: string, title: string): Y.Doc {
    const bytes = Buffer.from(docStateBase64, 'base64');
    if (bytes.length === 0) return createTemplateDoc({ title, children: [] });
    try {
      return docFromState(new Uint8Array(bytes));
    } catch {
      throw new BadRequestException('文档解析失败');
    }
  }

  /** 存活节点 id 集（binding 口径：getNode !== null 且未墓碑；docFromState 已 normalize）。 */
  private aliveNodeIds(doc: Y.Doc): Set<string> {
    const alive = new Set<string>();
    const nodes = doc.getMap('nodes') as Y.Map<Y.Map<unknown>>;
    for (const [id, node] of nodes.entries()) {
      if (node.get('deleted') !== true) alive.add(id);
    }
    return alive;
  }

  /** 评论更新广播（FR-CMT-003）：见 CollabService.broadcastStateless。 */
  private broadcast(fileId: string): void {
    this.collab.broadcastStateless(fileId, JSON.stringify({ type: COMMENT_UPDATED_EVENT }));
  }
}
