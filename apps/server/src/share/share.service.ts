import { BadRequestException, HttpException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { randomBytes, randomInt } from 'node:crypto';
import { EventsService } from '../events/events.service';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { NotifyService } from '../notify/notify.service';
import { UserEntity } from '../users/user.entity';
import { isDuplicateKeyError } from '../utils/duplicate-key';
import { ShareLinkEntity } from './share-link.entity';

export const SHARE_LINK_INVALID_MESSAGE = '链接已失效';
type ShareRole = 'editor' | 'commenter' | 'viewer';
type ExpiresIn = 'forever' | '7' | '30';
interface ShareConfig { role?: ShareRole; passwordEnabled?: boolean; expiresIn?: ExpiresIn }
interface OwnerShareView {
  status: 'active' | 'closed' | 'expired';
  shareToken?: string;
  role: ShareRole;
  password: string | null;
  expiresIn: ExpiresIn;
  expiresAt: string | null;
}

/** 登录后的链接协作：owner 管理；链接决定新加入者角色，密码与到期在加入前校验。 */
@Injectable()
export class ShareService {
  private readonly passwordFailures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    @InjectRepository(ShareLinkEntity) private readonly shareRepo: Repository<ShareLinkEntity>,
    @InjectRepository(FileEntity) private readonly fileRepo: Repository<FileEntity>,
    @InjectRepository(FileCollaboratorEntity) private readonly collabRepo: Repository<FileCollaboratorEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @Inject(NotifyService) private readonly notify: NotifyService,
    @Inject(EventsService) private readonly events: EventsService,
  ) {}

  private isExpired(link: ShareLinkEntity): boolean {
    return link.expiresAt !== null && link.expiresAt.getTime() <= Date.now();
  }

  private async latestForFile(fileId: string): Promise<ShareLinkEntity | null> {
    return this.shareRepo.findOne({ where: { fileId }, order: { createdAt: 'DESC' } });
  }

  private async liveForFile(fileId: string): Promise<ShareLinkEntity | null> {
    const latest = await this.latestForFile(fileId);
    return latest && latest.status === 'active' && !this.isExpired(latest) ? latest : null;
  }

  private expiryDate(kind: ExpiresIn): Date | null {
    return kind === 'forever' ? null : new Date(Date.now() + Number(kind) * 24 * 60 * 60 * 1000);
  }

  private newPassword(): string {
    return String(randomInt(0, 10_000)).padStart(4, '0');
  }

  private ownerView(link: ShareLinkEntity | null): OwnerShareView {
    if (!link) return { status: 'closed', role: 'viewer', password: null, expiresIn: 'forever', expiresAt: null };
    const status = link.status === 'closed' ? 'closed' : this.isExpired(link) ? 'expired' : 'active';
    return {
      status,
      ...(status === 'active' ? { shareToken: link.token } : {}),
      role: link.role,
      password: link.password,
      expiresIn: link.expiresIn,
      expiresAt: link.expiresAt?.toISOString() ?? null,
    };
  }

  /** 新链接默认 viewer/永久/无密码；已有活跃链接幂等复用，过期链接不复活而是另发新 token。 */
  async createForOwner(userId: string, fileId: string, config: ShareConfig = {}): Promise<{ shareToken: string }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    const existing = await this.liveForFile(file.id);
    if (existing) return { shareToken: existing.token };

    const previous = await this.latestForFile(file.id);
    const role = config.role ?? previous?.role ?? 'viewer';
    const passwordEnabled = config.passwordEnabled ?? (previous?.password !== null && previous?.password !== undefined);
    const expiresIn = config.expiresIn ?? previous?.expiresIn ?? 'forever';
    const row = this.shareRepo.create();
    row.fileId = file.id;
    row.token = randomBytes(16).toString('hex');
    row.createdBy = userId;
    row.role = role;
    row.password = passwordEnabled ? this.newPassword() : null;
    row.expiresIn = expiresIn;
    row.expiresAt = this.expiryDate(expiresIn);
    const saved = await this.shareRepo.save(row);
    try {
      await this.events.record('invite_send', file.id, userId, { channel: 'link' });
    } catch {
      // 遥测旁路，不影响已生成链接。
    }
    return { shareToken: saved.token };
  }

  async closeForOwner(userId: string, fileId: string): Promise<{ ok: true }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    const active = await this.liveForFile(file.id);
    if (!active) throw new NotFoundException('分享链接不存在');
    active.status = 'closed';
    active.closedAt = new Date();
    await this.shareRepo.save(active);
    return { ok: true as const };
  }

  async describeForOwner(userId: string, fileId: string): Promise<OwnerShareView> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    return this.ownerView(await this.latestForFile(file.id));
  }

  /** 权限与有效期修改立即生效；密码仅 false→true 时重新生成。 */
  async configureForOwner(userId: string, fileId: string, config: ShareConfig): Promise<{ ok: true }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');
    const active = await this.liveForFile(file.id);
    if (!active) throw new NotFoundException('分享链接不存在');
    if (config.role !== undefined) active.role = config.role;
    if (config.expiresIn !== undefined) {
      active.expiresIn = config.expiresIn;
      active.expiresAt = this.expiryDate(config.expiresIn);
    }
    if (config.passwordEnabled === false) active.password = null;
    if (config.passwordEnabled === true && active.password === null) active.password = this.newPassword();
    await this.shareRepo.save(active);
    return { ok: true as const };
  }

  async describeByToken(token: string): Promise<
    { fileId: string; title: string; ownerName: string; status: 'active'; role: ShareRole; requiresPassword: boolean }
    | { status: 'closed' }
    | { status: 'expired' }
  > {
    const link = await this.shareRepo.findOneBy({ token });
    if (!link || link.status !== 'active') return { status: 'closed' };
    if (this.isExpired(link)) return { status: 'expired' };
    const file = await this.fileRepo.findOne({ where: { id: link.fileId, deletedAt: IsNull() } });
    if (!file) return { status: 'closed' };
    const owner = await this.userRepo.findOneBy({ id: file.ownerUserId });
    return {
      fileId: file.id,
      title: file.title,
      ownerName: owner?.nickname ?? '',
      status: 'active' as const,
      role: link.role,
      requiresPassword: link.password !== null,
    };
  }

  private assertPassword(link: ShareLinkEntity, userId: string, password?: string): void {
    if (link.password === null) return;
    const key = `${userId}:${link.token}`;
    const now = Date.now();
    const prior = this.passwordFailures.get(key);
    if (prior && prior.resetAt <= now) this.passwordFailures.delete(key);
    const current = this.passwordFailures.get(key);
    if (current && current.count >= 5) throw new HttpException('密码尝试过于频繁，请60秒后再试', 429);
    if (password === link.password) {
      this.passwordFailures.delete(key);
      return;
    }
    const entry = current ?? { count: 0, resetAt: now + 60_000 };
    entry.count += 1;
    this.passwordFailures.set(key, entry);
    throw new BadRequestException('访问密码错误，请重新输入');
  }

  async joinByToken(userId: string, token: string, password?: string): Promise<{ fileId: string }> {
    const link = await this.shareRepo.findOneBy({ token });
    if (!link || link.status !== 'active' || this.isExpired(link)) throw new NotFoundException(SHARE_LINK_INVALID_MESSAGE);
    const file = await this.fileRepo.findOne({ where: { id: link.fileId, deletedAt: IsNull() } });
    if (!file) throw new NotFoundException(SHARE_LINK_INVALID_MESSAGE);
    if (file.ownerUserId === userId) return { fileId: file.id };
    this.assertPassword(link, userId, password);
    const existing = await this.collabRepo.findOneBy({ fileId: file.id, userId });
    if (!existing) {
      const row = this.collabRepo.create();
      row.fileId = file.id;
      row.userId = userId;
      row.role = link.role;
      let joined = false;
      try {
        await this.collabRepo.save(row);
        joined = true;
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
      if (joined) await this.notifyOwnerJoined(file, userId);
      if (joined) {
        try {
          await this.events.record('collab_join', file.id, userId, { viaRegistration: false });
        } catch {
          // 遥测旁路，不影响加入。
        }
      }
    }
    return { fileId: file.id };
  }

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
      // 通知旁路，不影响已完成的加入。
    }
  }
}
