import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { TrashItem } from '@gmind/shared';
import { FileEntity } from '../files/file.entity';
import { FolderEntity } from '../folders/folder.entity';
import { NotificationEntity } from '../notifications/notification.entity';
import { StorageService } from '../storage/storage.service';

/** 原始行 → ISO 时刻（mysql2 对 datetime(3) 返回 Date；容错字符串形态；口径同 files.service）。 */
function toIso(v: unknown): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

/** purge 需级联硬删的关联表（M0 迁移建表，无实体——字面量清单，无注入面）。
 *  events **不在其中**：审计 180 天裁定，events 不随彻底删除清理。 */
const PURGE_TABLES = ['comments', 'versions', 'file_collaborators', 'invites', 'share_links', 'file_stars'] as const;

@Injectable()
export class TrashService {
  constructor(
    @InjectRepository(FileEntity) private readonly fileRepo: Repository<FileEntity>,
    // 原文件夹存活校验（restore）：folders 表含已删行（不看 deleted_at，看行再判）
    @InjectRepository(FolderEntity) private readonly folderRepo: Repository<FolderEntity>,
    // purge 关联行清理走 DataSource 原生 SQL（comments/versions/invites/share_links 无实体，
    // file_collaborators/file_stars 与 files 行一并事务硬删）；tsx 不发射装饰器元数据，
    // 类 token 注入必须显式 @Inject（约定同 session.service.ts）
    @Inject(DataSource) private readonly dataSource: DataSource,
    // 准入 7.9：restore 清旧到期提醒（notifications 表）
    @InjectRepository(NotificationEntity) private readonly notifRepo: Repository<NotificationEntity>,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** 回收站列表（FR-FIL-005）：仅 owner=me（deleted_by 任意）；deleted_at IS NOT NULL；
   *  原 folder 名 LEFT JOIN folders（不筛 deleted_at，已删文件夹回显旧名）；
   *  按 deleted_at DESC，id DESC 决出同毫秒稳定次序（口径同 listByView）。 */
  async listTrash(userId: string): Promise<TrashItem[]> {
    const raw = await this.fileRepo
      .createQueryBuilder('f')
      .leftJoin('users', 'del_u', 'del_u.id = f.deleted_by')
      .leftJoin('folders', 'fold', 'fold.id = f.folder_id')
      .where('f.owner_user_id = :userId')
      .andWhere('f.deleted_at IS NOT NULL')
      .select('f.id', 'id')
      .addSelect('f.title', 'title')
      .addSelect('f.node_count', 'nodeCount')
      .addSelect('f.deleted_at', 'deletedAt')
      .addSelect('del_u.nickname', 'deletedByName')
      .addSelect('fold.name', 'folderName')
      .orderBy('f.deleted_at', 'DESC')
      .addOrderBy('f.id', 'DESC')
      .setParameter('userId', userId)
      .getRawMany<Record<string, unknown>>();
    return raw.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      nodeCount: Number(r.nodeCount),
      deletedAt: toIso(r.deletedAt) as string,
      deletedByName: r.deletedByName == null ? null : String(r.deletedByName),
      folderName: r.folderName == null ? null : String(r.folderName),
    }));
  }

  /** 还原（FR-FIL-006）：owner=me；不在回收站（存活/缺失/他人）→ 404「文件不存在」，
   *  同口径不泄露存在性。落点：原文件夹存活 → 回原处；已删/缺失 → 根（folderId=null）。
   *  定点 update（updatedAt: () => 'updated_at'）不推进 updated_at——还原非内容修改，
   *  不应使文件浮到 mine 视图首位（口径同 markOpened，M1 遗留裁定）。
   *  准入 7.9（M3a 终审 Important #2）：还原 update 与旧提醒清除同事务——文件回到存活态
   *  时，其 type=system 且 payload 含 fileId 的到期提醒行原子消亡（防死链通知累积），
   *  且「还原→再删」进入的新 27 天窗口可再次提醒（配合 CleanupService 的 deletedAt 判重）。 */
  async restore(userId: string, fileId: string): Promise<{ ok: true }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, ownerUserId: userId } });
    if (!file || file.deletedAt == null) throw new NotFoundException('文件不存在');
    let folderId: string | null = file.folderId;
    if (folderId !== null) {
      const folder = await this.folderRepo.findOne({ where: { id: folderId, ownerUserId: userId } });
      if (!folder || folder.deletedAt != null) folderId = null; // 原文件夹已删/缺失 → 回根
    }
    await this.dataSource.transaction(async (em) => {
      await em.update(FileEntity, file.id, {
        deletedAt: null,
        deletedBy: null,
        folderId,
        updatedAt: () => 'updated_at',
      });
      // 提醒 payload 无 file_id 列可等值删，按写端同款 LIKE 标记命中（写端见 CleanupService.remind）
      await em
        .createQueryBuilder()
        .delete()
        .from(NotificationEntity)
        .where('user_id = :userId AND type = :type AND payload LIKE :marker', {
          userId,
          type: 'system',
          marker: `%\"fileId\":\"${fileId}\"%`,
        })
        .execute();
    });
    return { ok: true };
  }

  /** 彻底删除入口（FR-FIL-007，DELETE /api/trash/:fileId）：owner=me 且须确在回收站
   *  （存活/缺失/他人一律 404，同口径）；通过后交 purgeFile 核心。 */
  async purgeOwned(userId: string, fileId: string): Promise<void> {
    const file = await this.fileRepo.findOne({ where: { id: fileId, ownerUserId: userId } });
    if (!file || file.deletedAt == null) throw new NotFoundException('文件不存在');
    await this.purgeFile(fileId);
  }

  /** 彻底删除核心（供手动 purge 与 30 天定时清理复用，CleanupService.purge 亦走此）：
   *  files 行 + 关联行（comments/versions/file_collaborators/invites/share_links/file_stars）
   *  单事务硬删 + 对象存储前缀清理（files/{fileId}/ 递归删目录）。events 保留（审计 180 天
   *  裁定）。存储不可回滚 → 事务提交后再删对象：DB 失败最坏留孤儿对象可离线回收，
   *  反序（先删对象后删行失败）则出现「行在图丢」的更差态。
   *  消息/版本/协作/分享/邀请/星标均随文件本体消亡（PRD：彻底删除不可逆）。 */
  async purgeFile(fileId: string): Promise<void> {
    await this.dataSource.transaction(async (em) => {
      for (const table of PURGE_TABLES) {
        await em.query(`DELETE FROM ${table} WHERE file_id = ?`, [fileId]);
      }
      await em.delete(FileEntity, { id: fileId });
    });
    // 前缀不存在（无图片的文件）静默成功——deletePrefix 内 force 语义兜底
    await this.storage.deletePrefix(`files/${fileId}/`);
  }
}
