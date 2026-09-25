import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { And, LessThanOrEqual, MoreThan, Raw, Repository } from 'typeorm';
import { FileEntity } from '../files/file.entity';
import { MailService } from '../mail/mail.service';
import { NotificationEntity } from '../notifications/notification.entity';
import { UserEntity } from '../users/user.entity';
import { TrashService } from '../trash/trash.service';

/** 回收站保留期（FR-FIL-007）：删除满 30 天彻底清除。 */
export const TRASH_RETENTION_DAYS = 30;
/** 到期提醒（FR-FIL-010）：剩 3 天（删除满 27 天）提醒一次。 */
export const TRASH_REMIND_DAYS = 27;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 回收站定时清理（M3a Task 7）：runCleanup(now) 纯函数式可测——测试直调传入任意
 *  模拟时刻；线上由 main.ts 每 24h 触发一次（无 node-cron 依赖）。 */
@Injectable()
export class CleanupService {
  constructor(
    @InjectRepository(FileEntity) private readonly fileRepo: Repository<FileEntity>,
    @InjectRepository(NotificationEntity) private readonly notifRepo: Repository<NotificationEntity>,
    // 提醒邮件收件人（owner 的 email；手机号注册无 email 则跳过邮件只落通知）
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
    @Inject(TrashService) private readonly trash: TrashService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** 单轮清理（FR-FIL-007/010）：
   *  - 满 30 天（deleted_at ≤ now-30d）→ 逐个 purgeFile 硬删（复用 TrashService 核心）；
   *  - 剩 3 天（deleted_at ≤ now-27d 且 > now-30d）→ 给 owner 落 system 通知 +
   *    尽力而为的邮件（无 SMTP 仅 log，MailHog 接线后零改动生效）。
   *  返回 { purged, reminded } 计数供测试断言。顺序先清后提醒：purge 集与 remind 集以
   *  now-30d 为界互斥（MoreThan），同一条目不会既被清除又被提醒。 */
  async runCleanup(now: Date): Promise<{ purged: number; reminded: number }> {
    const purgeBefore = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
    const remindBefore = new Date(now.getTime() - TRASH_REMIND_DAYS * DAY_MS);

    let purged = 0;
    const expired = await this.fileRepo.find({ where: { deletedAt: LessThanOrEqual(purgeBefore) } });
    for (const file of expired) {
      await this.trash.purgeFile(file.id);
      purged++;
    }

    let reminded = 0;
    const due = await this.fileRepo.find({
      where: { deletedAt: And(LessThanOrEqual(remindBefore), MoreThan(purgeBefore)) },
    });
    for (const file of due) {
      if (await this.hasReminded(file.ownerUserId, file.id)) continue; // 幂去重：同一条目只提醒一次
      await this.remind(file);
      reminded++;
    }
    return { purged, reminded };
  }

  /** 幂去重（任务绑定裁定）：notifications 表量级极小（个人提醒），MySQL 5.6 无 JSON
   *  类型、payload LIKE 文本匹配在此规模可接受。标记取 `"fileId":"<ulid>"`——ULID 定长
   *  26 且以闭合引号定界，不会命中更长 id 的前缀；type=system 收窄命中面。 */
  private async hasReminded(userId: string, fileId: string): Promise<boolean> {
    const marker = `%\"fileId\":\"${fileId}\"%`;
    const count = await this.notifRepo.countBy({
      userId,
      type: 'system',
      payload: Raw((alias) => `${alias} LIKE :marker`, { marker }),
    });
    return count > 0;
  }

  /** 落一条 system 通知（payload 供通知中心/前端直接驱动还原）+ 尽力而为邮件。
   *  MailService 永不抛错（内部兜底），提醒主流程不受邮件失败影响。 */
  private async remind(file: FileEntity): Promise<void> {
    const deletedAt = file.deletedAt ?? new Date(0); // due 查询保证 deleted_at 非空，兜底仅为类型收窄
    const notification = this.notifRepo.create();
    notification.userId = file.ownerUserId;
    notification.type = 'system';
    notification.payload = JSON.stringify({
      fileId: file.id,
      title: file.title,
      deletedAt: deletedAt.toISOString(),
      action: 'restore',
    });
    await this.notifRepo.save(notification);

    const owner = await this.userRepo.findOne({ where: { id: file.ownerUserId } });
    if (owner?.email) {
      await this.mail.sendMail(
        owner.email,
        `「${file.title}」将在 3 天后被彻底删除`,
        '您回收站中的该文件即将到达 30 天保留期，请及时还原，逾期将被彻底删除且不可恢复。',
      );
    }
  }
}
