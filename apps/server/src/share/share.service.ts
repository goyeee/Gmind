import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomBytes } from 'node:crypto';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
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
   *  捕获后归并为幂等成功（口径同 FilesService.star）。 */
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
      try {
        await this.collabRepo.save(row);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err; // 并发双插的败者：幂等 no-op
      }
    }
    return { fileId: file.id };
  }
}

/** mysql2 唯一键冲突判定（口径同 files.service.ts 的 isDuplicateKeyError）：
 *  ER_DUP_ENTRY / errno 1062，TypeORM 实例与 driverError 两层都查。
 *  导出供同域 InviteService 复用（join / 注册回填写协作者行的幂等口径一致）。 */
export function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; driverError?: { code?: string; errno?: number } } | null;
  if (!e) return false;
  return (
    e.code === 'ER_DUP_ENTRY' ||
    e.errno === 1062 ||
    e.driverError?.code === 'ER_DUP_ENTRY' ||
    e.driverError?.errno === 1062
  );
}
