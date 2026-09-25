import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEntity } from './event.entity';

/**
 * 埋点事件域（M4 Task 7）：events 表的唯一写入面。
 *
 * record(type, fileId, userId, payload)：一行一事件（id 由实体默认 ulid() 生成，
 * users/files/comments 同款来源）；payload 序列化为 JSON 文本存储（未传为 null）。
 * 事件是旁路遥测：写入失败由调用方决定兜底策略（业务主流程不与之强耦合，
 * 见 VersionsService.restoreVersion 的尽力而为边界）。
 */
@Injectable()
export class EventsService {
  constructor(@InjectRepository(EventEntity) private readonly repo: Repository<EventEntity>) {}

  /** 落一行埋点事件；payload 为任意可 JSON 化对象（缺省 null）。 */
  async record(
    type: string,
    fileId: string | null,
    userId: string | null,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const row = this.repo.create();
    row.type = type;
    row.fileId = fileId;
    row.userId = userId;
    row.payload = payload === undefined ? null : JSON.stringify(payload);
    await this.repo.save(row);
  }
}
