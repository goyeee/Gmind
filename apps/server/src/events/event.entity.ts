import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/**
 * 埋点事件（迁移表 events，M0 init 即建表；M4 Task 7 首次接线，FR-VER-004）。
 *
 * 列对齐迁移 DDL（synchronize=false，实体仅为既有表提供类型化读写面，显式 snake_case
 * 列名纪律同 version.entity.ts）：type varchar(64) 事件类型；file_id/user_id 可空
 * （埋点允许非文件/匿名上下文）；payload 为 JSON 文本（text 列，MySQL 5.6 无 JSON 类型）。
 * 索引 idx_events_type_time / idx_events_file 由迁移建出，不在此重复声明。
 */
@Entity('events')
export class EventEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'varchar', length: 64 })
  type: string = '';

  @Column({ type: 'char', length: 26, nullable: true, name: 'file_id' })
  fileId: string | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'user_id' })
  userId: string | null = null;

  @Column({ type: 'text', nullable: true })
  payload: string | null = null;

  // events 表无 updated_at 列（同 notifications/file_collaborators 口径）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
