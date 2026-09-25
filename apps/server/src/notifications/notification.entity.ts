import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

export type NotificationType = 'mention' | 'reply' | 'permission' | 'system';

/** 站内通知（迁移表 notifications，M0 init 即建表；M3a Task 7 首次接线，FR-FIL-010）。
 *  payload 为 JSON 文本（text 列，MySQL 5.6 无 JSON 类型）；read_at/emailed_at 由
 *  通知中心（M4）回写，本任务只产出行。 */
@Entity('notifications')
@Index('idx_notif_user_read', ['userId', 'readAt'])
export class NotificationEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  @Column({ type: 'enum', enum: ['mention', 'reply', 'permission', 'system'] })
  type: NotificationType = 'system';

  @Column({ type: 'text', nullable: true })
  payload: string | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'read_at' })
  readAt: Date | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'emailed_at' })
  emailedAt: Date | null = null;

  // notifications 表无 updated_at 列（同 file_stars/file_collaborators 口径）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
