import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { EventsService } from '../events/events.service';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { NotifyService } from '../notify/notify.service';
import { UserEntity } from '../users/user.entity';
import { isDuplicateKeyError } from '../utils/duplicate-key';
import { ShareLinkEntity } from './share-link.entity';

/** join 对 closed/missing 的统一拒绝文案（binding 裁定：404 与 GET 的 closed 语义对齐，
 *  不区分「从未存在/已关闭」，不泄露 token 存在性）。 */
export const SHARE_LINK_INVALID_MESSAGE = '链接已失效';

/**
 * 分享链接（M3b Task 4，FR-SHR-001）。
 *
 * 语义裁定（binding）：
 * - 创建为 owner only：FR-SHR-001「文档所有者可创建」——canAccess（协作者亦可）不满足，
 *   须 ownerUserId === userId；非 owner 与「文件不存在」同口径 404，不泄露存在性。
 * - 每文件至多一条 active 链接：重复创建返回既有 active token（不繁殖行）。
 * - GET /api/share/:token 公开（落地页需在登录前探测）：active → {fileId,title,ownerName,status}；
 *   closed/missing/源文件已删 → 统一 200 {status:'closed'}——不泄露 token 存在性差异。
 * - join（UserGuard）：active → 幂等写 file_collaborators（role editor）→ {fileId}；
 *   closed/missing → 404「链接已失效」（与 GET 的 closed 语义统一，裁定为 404 非 410/409）。
 */
@Injectable()
export class ShareService {
  constructor(
    @InjectRepository(ShareLinkEntity) private readonly shareRepo: Repository<ShareLinkEntity>,
    @InjectRepository(FileEntity) private readonly fileRepo: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 comments.service.ts）
    @Inject(NotifyService) private readonly notify: NotifyService,
    // EventsService（M5 Task 4）：invite_send/collab_join 埋点（EventsModule 不依赖任何业务域）
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  /** owner 创建分享链接：文件须存活且归本人（404 同口径）；已有 active 链接直接返回
   *  （每文件至多一条，binding 裁定），否则以 crypto.randomBytes(16) 生成 128bit token
   *  （hex 32 字符，uk_share_token 兜底；随机空间下碰撞可忽略，不做重试循环）。 */
  async createForOwner(userId: string, fileId: string): Promise<{ shareToken: string }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    const existing = await this.shareRepo.findOneBy({ fileId: file.id, status: 'active' });
    if (existing) return { shareToken: existing.token };
    const row = this.shareRepo.create();
    row.fileId = file.id;
    row.token = randomBytes(16).toString('hex');
    row.createdBy = userId;
    const saved = await this.shareRepo.save(row);
    // invite_send 埋点（M5 Task 4，PRD 6.4 邀请类型=链接）：仅真实生成新链接时落行
    // ——幂等复创建（上方 short-circuit）不重复计；尽力而为旁路，失败静默。
    try {
      await this.events.record('invite_send', file.id, userId, { channel: 'link' });
    } catch {
      // 遥测旁路：静默（不炸响应、不回滚已生成的链接）
    }
    return { shareToken: saved.token };
  }

  /** owner 关闭分享链接：active 行置 status=closed、closed_at=now；文件非本人/不存在
   *  → 404「文件不存在」，无 active 行（从未创建/已关闭）→ 404（binding）。 */
  async closeForOwner(userId: string, fileId: string): Promise<{ ok: true }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    const active = await this.shareRepo.findOneBy({ fileId: file.id, status: 'active' });
    if (!active) throw new NotFoundException('分享链接不存在');
    active.status = 'closed';
    active.closedAt = new Date();
    await this.shareRepo.save(active);
    return { ok: true as const };
  }

  /** 落地页探测（公开，无鉴权）：active 且源文件存活 → 展示投影；
   *  其余（missing/closed/文件已删）统一 {status:'closed'}。 */
  async describeByToken(token: string): Promise<{ fileId: string; title: string; ownerName: string; status: 'active' } | { status: 'closed' }> {
    const link = await this.shareRepo.findOneBy({ token });
    if (!link || link.status !== 'active') return { status: 'closed' };
    const file = await this.fileRepo.findOne({ where: { id: link.fileId, deletedAt: IsNull() } });
    if (!file) return { status: 'closed' };
    const owner = await this.userRepo.findOneBy({ id: file.ownerUserId });
    return {
      fileId: file.id,
      title: file.title,
      ownerName: owner?.nickname ?? '',
      status: 'active' as const,
    };
  }

  /** 凭 token 加入协作（登录态）：active 且文件存活 → 幂等写 editor 协作者行 → {fileId}；
   *  其余统一 404「链接已失效」。幂等扩展到并发形态：uk_fc_file_user 冲突（双插败者）
   *  捕获后归并为幂等成功（口径同 FilesService.star）。
   *  加入通知（M4 清偿包）：真实新增协作者行成功后 owner 收 permission 通知——
   *  重复 join（既有行 no-op）与并发双插败者不重发（胜者请求已通知）；
   *  owner 自己开链接为上游 no-op，不进入本路径。 */
  async joinByToken(userId: string, token: string): Promise<{ fileId: string }> {
    const link = await this.shareRepo.findOneBy({ token });
    if (!link || link.status !== 'active') throw new NotFoundException(SHARE_LINK_INVALID_MESSAGE);
    const file = await this.fileRepo.findOne({ where: { id: link.fileId, deletedAt: IsNull() } });
    if (!file) throw new NotFoundException(SHARE_LINK_INVALID_MESSAGE);
    if (file.ownerUserId === userId) return { fileId: file.id }; // owner 自己开链接：no-op，不产生冗余协作者行
    const existing = await this.collabRepo.findOneBy({ fileId: file.id, userId });
    if (!existing) {
      const row = this.collabRepo.create();
      row.fileId = file.id;
      row.userId = userId;
      row.role = 'editor';
      let joined = false;
      try {
        await this.collabRepo.save(row);
        joined = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err; // 并发双插的败者：幂等 no-op（胜者请求已通知）
      }
      if (joined) await this.notifyOwnerJoined(file, userId);
      // collab_join 埋点（M5 Task 4，PRD 6.4 是否注册转化）：join 端点走 UserGuard，
      // 加入者必然已是登录用户 → viaRegistration:false；仅真实新增协作者行时落行
      // （幂等重开/owner 自开不重复计）。尽力而为旁路，失败静默。
      if (joined) {
        try {
          await this.events.record('collab_join', file.id, userId, { viaRegistration: false });
        } catch {
          // 遥测旁路：静默
        }
      }
    }
    return { fileId: file.id };
  }

  /** 加入通知（M4 清偿包）：owner 收 type='permission'、payload {fileId, title, memberName,
   *  action:'joined'}（binding 形状；TYPE_LABELS.permission='权限' 复用既有标签）。
   *  尽力而为旁路（口径同 comments.dispatchNotifications）：内部捕获，绝不波及 join 主流程。 */
  private async notifyOwnerJoined(file: FileEntity, memberUserId: string): Promise<void> {
    try {
      const member = await this.userRepo.findOneBy({ id: memberUserId });
      await this.notify.notify(file.ownerUserId, 'permission', {
        fileId: file.id,
        title: file.title,
        memberName: member?.nickname ?? '',
        action: 'joined',
      });
    } catch {
      // 通知是 join 主流程的旁路：失败静默（不炸响应、不回滚已写入的协作者行）
    }
  }
}
