import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { FilesService } from '../files/files.service';
import { UserEntity } from '../users/user.entity';
import { EventEntity } from './event.entity';

/** 动态流条目（binding 形状）：payload 为 JSON 文本列还原后的对象（损坏/缺省 null）；
 *  userName 来自 users.nickname JOIN（versions 列表 createdByName 同源）。 */
export interface ActivityListItem {
  id: string;
  type: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  userName: string | null;
}

/**
 * 文档动态读侧（M6 Task 8，企微对标，FR-COL-007 提前）：events 表的只读查询面。
 *
 * 权限：canAccess 口径（owner 或协作者）——经 FilesService.findAliveOr404 单点闸，
 * 缺失/已删/无权限统一 404「文件不存在」（versions/comments 同口径）。
 * 排序：created_at DESC + id DESC（ulid 单调性兜底同毫秒，versions 列表同纪律）。
 *
 * 与 EventsService（写侧）分置：本服务注入 FilesService，而 FilesService 注入
 * EventsService 落 doc_create——两侧若合并在同一服务/模块会形成服务级循环依赖，
 * 读侧独立成 EventsQueryModule（storage-core/storage 分模块先例），环不存在。
 */
@Injectable()
export class EventsQueryService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定同 session.service.ts）
  constructor(
    @InjectRepository(EventEntity) private readonly repo: Repository<EventEntity>,
    @InjectRepository(UserEntity) private readonly userRepo: Repository<UserEntity>,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  /** GET /api/files/:fileId/events?limit=50 → {items}（倒序，条数已由 controller 收拢）。 */
  async list(userId: string, fileId: string, limit: number): Promise<{ items: ActivityListItem[] }> {
    const file = await this.files.findAliveOr404(userId, fileId);
    const rows = await this.repo.find({
      where: { fileId: file.id },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
    });
    const names = await this.nicknamesOf(
      rows.map((r) => r.userId).filter((v): v is string => v !== null),
    );
    return { items: rows.map((r) => this.toItem(r, names)) };
  }

  // ---- 内部 ---------------------------------------------------------------

  /** 行 → 条目（payload JSON 文本还原对象；损坏行防御 null，不炸动态流）。 */
  private toItem(row: EventEntity, names: Map<string, string>): ActivityListItem {
    let payload: Record<string, unknown> | null = null;
    if (row.payload !== null) {
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        payload = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        payload = null; // 遥测旁路的历史脏行：展示层跳过载荷即可
      }
    }
    return {
      id: row.id,
      type: row.type,
      payload,
      createdAt: row.createdAt.toISOString(),
      userName: row.userId === null ? null : (names.get(row.userId) ?? null),
    };
  }

  /** userId 集 → nickname 映射（versions.service list 的 joinUsers 模式）。 */
  private async nicknamesOf(userIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await this.userRepo.find({ where: { id: In(ids) }, select: ['id', 'nickname'] });
    return new Map(users.map((u) => [u.id, u.nickname]));
  }
}
