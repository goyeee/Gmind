import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

export type ShareLinkStatus = 'active' | 'closed';

/** 分享链接（迁移表 share_links，uk_share_token 唯一键在 DB 层）。M3b Task 4，FR-SHR-001。
 *  password/expires_at 为二期预留列（FR-SHR-003），实体照映射、业务暂不读写。 */
@Entity('share_links')
export class ShareLinkEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  // 128bit 随机数的 hex 表示，恰好 32 字符（spec §5.7「128bit token」）
  @Column({ type: 'varchar', length: 32 })
  token: string = '';

  @Column({ type: 'enum', enum: ['active', 'closed'] })
  status: ShareLinkStatus = 'active';

  @Column({ type: 'char', length: 26, name: 'created_by' })
  createdBy: string = '';

  @Column({ type: 'varchar', length: 64, nullable: true })
  password: string | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'expires_at' })
  expiresAt: Date | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'closed_at' })
  closedAt: Date | null = null;

  // 显式 name 对齐迁移的 snake_case 列名（同 file.entity.ts 的约定）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
