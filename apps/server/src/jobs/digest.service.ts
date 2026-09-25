import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { NotificationEntity } from '../notifications/notification.entity';
import { UserEntity } from '../users/user.entity';

/** 摘要延迟窗（FR-CMT-006）：站内通知满 15 分钟仍未读才入摘要——给 SSE 实时推送
 *  与「到站即读」留窗口，避免刚 @ 完就收邮件的轰炸。 */
export const DIGEST_DELAY_MS = 15 * 60 * 1000;

/** 邮件正文条目的类型标签。 */
const TYPE_LABELS: Record<string, string> = { mention: '提及', reply: '回复', permission: '权限', system: '系统' };

/** 正文单条内容切片上限（写入端 NotifyService 已 ≤100，此处兜底）。 */
const CONTENT_SLICE = 100;

/** 按 (user_id, payload.fileId) 分组的摘要组；fileId 解析不出（system 类/坏 JSON）→
 *  归入该用户名下单独一组（fileId=null），同样合并单封。 */
interface DigestGroup {
  userId: string;
  fileId: string | null;
  rows: NotificationEntity[];
}

/**
 * 未读邮件摘要（M3b Task 9，FR-CMT-006）：每分钟扫描（main.ts setInterval unref），
 * 把满 15 分钟未读且未发过邮件的站内通知按（用户, 文件）合并为单封摘要邮件。
 * runDigest(now) 直调可测（口径同 CleanupService.runCleanup，M3a Task 7）；线上
 * 逐轮 catch，e2e 不经 interval 直调本方法。
 *
 * 回写裁定（binding 收敛选项）：
 * - sendMail 成功 → 该组行批量 emailed_at=now（单 UPDATE）；
 * - 失败 → 不回写不计数，行仍是候选，下一轮 runDigest 重试；
 * - 用户无邮箱（微信注册）→ 不发邮件但同样回写 emailed_at 并 log「无邮箱跳过」：
 *   否则无邮箱用户的行永远滞留候选集、每分钟空扫不收敛。emailed_at 语义在此为
 *   「已进入摘要处理」，无邮箱用户站内通知（通知中心）仍完整可读。
 *
 * 候选集不用 INNER JOIN users 过滤无邮箱行：收敛裁定需要给无邮箱行回写 emailed_at，
 * 故先取全部候选行（user+read+emailed+created_at 四条件），再按 user_ids 二次查
 * users 取 email——个人级数据量（数十行/轮），两次简单查询优于 JOIN+回写混合 SQL。
 */
@Injectable()
export class DigestService {
  constructor(
    @InjectRepository(NotificationEntity) private readonly notifRepo: Repository<NotificationEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 cleanup.service.ts）
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  /** 单轮摘要。返回 {emailed, users}：
   *  - emailed：成功发出的摘要邮件封数（每 (用户,文件) 组一封）；
   *  - users：本轮完成处理（候选行均已回写 emailed_at）的独立用户数（含无邮箱收敛）。 */
  async runDigest(now: Date): Promise<{ emailed: number; users: number }> {
    const cutoff = new Date(now.getTime() - DIGEST_DELAY_MS);
    const candidates = await this.notifRepo.find({
      where: { readAt: IsNull(), emailedAt: IsNull(), createdAt: LessThanOrEqual(cutoff) },
      order: { createdAt: 'ASC' },
    });
    if (candidates.length === 0) return { emailed: 0, users: 0 };

    const users = await this.userRepo.find({ where: { id: In([...new Set(candidates.map((r) => r.userId))]) } });
    const emailOf = new Map(users.map((u) => [u.id, u.email] as const));

    const groups = new Map<string, DigestGroup>();
    for (const row of candidates) {
      const fileId = payloadString(row.payload, 'fileId');
      const key = `${row.userId}|${fileId ?? ''}`;
      const group = groups.get(key) ?? { userId: row.userId, fileId: fileId ?? null, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }

    let emailed = 0;
    const doneUsers = new Set<string>();
    for (const group of groups.values()) {
      const email = emailOf.get(group.userId) ?? null;
      if (!email) {
        console.log(`[digest] 无邮箱跳过（站内可达，回写 emailed_at 使扫描收敛）：userId=${group.userId} rows=${group.rows.length}`);
        await this.markEmailed(group.rows, now);
        doneUsers.add(group.userId);
        continue;
      }
      // 文件标题取组内第一条非空 payload.title（mention/reply/system 均带），缺失兜底「文档」
      const title = group.rows.map((r) => payloadString(r.payload, 'title')).find((t): t is string => !!t) ?? '文档';
      const subject = `Gmind：${title} 有 ${group.rows.length} 条新通知`;
      // 条目行附文档深链（M4 清偿包）：payload 带 fileId 才加链接（system 类无 fileId 不加），
      // 点击直达 ${WEB_ORIGIN}/edit/:fileId；正文尾部统一「打开 Gmind」入口行
      const body = group.rows
        .map((r) => {
          const payload = parsePayload(r.payload);
          const label = TYPE_LABELS[r.type] ?? '通知';
          const who = typeof payload?.commenterName === 'string' && payload.commenterName ? `${payload.commenterName}：` : '';
          const content = typeof payload?.content === 'string' ? payload.content.slice(0, CONTENT_SLICE) : '';
          const link = typeof payload?.fileId === 'string' && payload.fileId ? ` — ${env.WEB_ORIGIN}/edit/${payload.fileId}` : '';
          return `- [${label}] ${who}${content}${link}`;
        })
        .join('\n')
        .concat(`\n\n打开 Gmind：${env.WEB_ORIGIN}`);
      if (await this.mail.sendMail(email, subject, body)) {
        await this.markEmailed(group.rows, now);
        emailed++;
        doneUsers.add(group.userId);
      }
      // sendMail false：不回写不计数，下一轮重试（邮件是尽力而为旁路，MailService 永不抛错）
    }
    return { emailed, users: doneUsers.size };
  }

  /** 该组行批量回写 emailed_at=now（binding：批量回写，单条 UPDATE）。 */
  private markEmailed(rows: NotificationEntity[], now: Date): Promise<unknown> {
    return this.notifRepo.update({ id: In(rows.map((r) => r.id)) }, { emailedAt: now });
  }
}

/** payload JSON 容错解析（同 NotifyService.parsePayload 口径：坏 JSON 不炸扫描）。 */
function parsePayload(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function payloadString(raw: string | null, key: string): string | null {
  const value = parsePayload(raw)?.[key];
  return typeof value === 'string' && value ? value : null;
}
