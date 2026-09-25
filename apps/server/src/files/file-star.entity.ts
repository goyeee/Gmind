import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/** 星标（迁移表 file_stars，uk_star_file_user 唯一键在 DB 层兜底；Task 6，FR-FIL-004）。
 *  用户级星标：同一 (file_id, user_id) 至多一行，加星时间即 created_at（starred 视图排序依据）。 */
@Entity('file_stars')
@Index('idx_star_user', ['userId'])
export class FileStarEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  // 显式 name 对齐迁移的 snake_case 列名（同 file.entity.ts 的约定）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
