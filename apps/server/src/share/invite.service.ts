import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { env } from '../config/env';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { UserEntity } from '../users/user.entity';
import { MailService } from '../mail/mail.service';
import { InviteEntity, InviteContactType } from './invite.entity';
import { isDuplicateKeyError } from './share.service';

/** 联系人分类（binding）：先邮箱后手机号（两类模式不相交，先后无歧义）。 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^1\d{10}$/;

type Classified = { type: InviteContactType; contact: string };

export function classifyContact(raw: string): Classified | null {
  const contact = raw.trim();
  if (!contact) return null;
  if (EMAIL_RE.test(contact)) return { type: 'email', contact };
  if (PHONE_RE.test(contact)) return { type: 'phone', contact };
  return null;
}

/**
 * 批量邀请与注册回填（M3b Task 5，FR-SHR-004）。
 *
 * 语义裁定（binding）：
 * - 创建邀请 owner only：与分享链接同口径，非 owner 与「文件不存在」统一 404；
 * - 批量 1~50 个（schema 层拒绝）；单条先分类（email/phone），非法条目整批 400 并逐条回列
 *   （先整体校验再落库，不产生半批写入）；
 * - 重邀幂等：同文件同联系号收敛到 uk_invite 一行——pending 重邀 no-op（不重复计）；
 *   已 accepted 再邀 no-op；revoked 重邀复活为 pending（重新接受邀请）；
 * - 邀请邮件仅 email 类联系人（手机号无邮件通道），内容含邀请人/文件名/注册链接，
 *   经 MailService 尽力而为旁路（无 SMTP 仅 log，绝不波及邀请主流程）；
 * - 注册回填（acceptPendingForNewUser）：由 AuthService 登录路径触发（准入 7.10：新旧
 *   用户每次登录尽力触发，幂等由 pending 过滤 + uk_invite 保证；失败保持 pending 天然重试），
 *   非 owner 侧通知——登记即可，owner 无感知；新用户种子文件与回填互不干扰。
 */
@Injectable()
export class InviteService {
  constructor(
    @InjectRepository(InviteEntity) private readonly inviteRepo: Repository<InviteEntity>,
    @InjectRepository(FileEntity) private readonly fileRepo: Repository<FileEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** owner 批量邀请：返回 { invited, skipped }（skipped = pending/accepted 重邀 no-op 数）。 */
  async createBatch(userId: string, fileId: string, rawContacts: string[]): Promise<{ invited: number; skipped: number }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, deletedAt: IsNull() } });
    if (!file || file.ownerUserId !== userId) throw new NotFoundException('文件不存在');

    // 先整体校验再落库：任一条非法整批 400，逐条回列（合法条目不误伤、不产生半批写入）
    const invalid = rawContacts.filter((c) => !classifyContact(c));
    if (invalid.length > 0) throw new BadRequestException(`联系人格式非法：${invalid.join('、')}`);

    let invited = 0;
    let skipped = 0;
    let owner: UserEntity | null = null; // 邮件懒取：纯手机号批次不发邮件、不多查一次
    for (const raw of rawContacts) {
      const { type, contact } = classifyContact(raw) as Classified;
      const existing = await this.inviteRepo.findOneBy({ fileId, contactType: type, contact });
      if (existing && existing.status !== 'revoked') {
        // binding 裁定：pending 重邀与 accepted 重邀均 no-op，不重复计
        skipped++;
        continue;
      }
      if (existing) {
        // revoked → 重邀复活：回 pending 并刷新邀请人（无撤销端点前的前瞻口径）
        existing.status = 'pending';
        existing.invitedBy = userId;
        existing.acceptedUserId = null;
        await this.inviteRepo.save(existing);
      } else {
        const row = this.inviteRepo.create();
        row.fileId = fileId;
        row.contactType = type;
        row.contact = contact;
        row.invitedBy = userId;
        await this.inviteRepo.save(row);
      }
      invited++;
      if (type === 'email') {
        owner ??= await this.fileRepo.manager.findOneByOrFail(UserEntity, { id: userId });
        await this.sendInviteMail(owner, file.title, contact);
      }
    }
    return { invited, skipped };
  }

  /** 注册回填：登录时按 email/phone 匹配 pending 邀请 → 写 editor 协作者行 +
   *  批量置 accepted（准入 7.10：不再限于新用户创建路径，已注册用户每次登录同样触发）。
   *  仅匹配 pending（fix 1：revoked 不复活——撤销语义专属 revoke 端点，
   *  find 与 update 两处都限 pending 双保险）。事务化且协作者行先写、accepted 标记后落
   *  （fix 2）：任一步非 dup-key 失败整体回滚，绝不残留「已 accepted 无协作者行」的
   *  静默丢协作脏状态。调用方（AuthService）须 try/catch 隔离——回填失败不得波及登录，
   *  失败邀请保持 pending（每次登录天然重试，准入 7.10）。 */
  async acceptPendingForNewUser(user: UserEntity): Promise<void> {
    const conds: Array<Pick<InviteEntity, 'contactType' | 'contact' | 'status'>> = [];
    if (user.email) conds.push({ contactType: 'email', contact: user.email, status: 'pending' });
    if (user.phone) conds.push({ contactType: 'phone', contact: user.phone, status: 'pending' });
    if (conds.length === 0) return;

    await this.inviteRepo.manager.transaction(async (em) => {
      // 事务内统一走 em 仓库，保证 SELECT/INSERT/UPDATE 同一 queryRunner（可整体回滚）
      const inviteRepo = em.getRepository(InviteEntity);
      const collabRepo = em.getRepository(FileCollaboratorEntity);
      const pending = await inviteRepo.find({ where: conds });
      if (pending.length === 0) return;

      // 协作者行先行、accepted 标记后落：同一事务，任一步失败即整体回滚
      for (const invite of pending) {
        const row = collabRepo.create();
        row.fileId = invite.fileId;
        row.userId = user.id;
        row.role = 'editor';
        try {
          await collabRepo.save(row);
        } catch (err) {
          if (!isDuplicateKeyError(err)) throw err; // 并发双插的败者：幂等 no-op；其余失败上抛回滚
        }
      }
      await inviteRepo.update(
        { id: In(pending.map((i) => i.id)), status: 'pending' },
        { status: 'accepted', acceptedUserId: user.id },
      );
    });
  }

  /** 邀请邮件：邀请人/文件名/注册链接（APP_URL 默认 web dev 端口）。永不抛错（MailService 旁路口径）。 */
  private async sendInviteMail(owner: UserEntity, fileTitle: string, to: string): Promise<void> {
    const inviter = owner.nickname || '用户';
    await this.mail.sendMail(
      to,
      `${inviter} 邀请你协作《${fileTitle}》`,
      `${inviter} 邀请你协作编辑《${fileTitle}》，打开链接注册/登录后自动加入：${env.APP_URL}/login`,
    );
  }
}
