import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';

@Entity('files')
@Index('idx_files_owner', ['ownerUserId'])
export class FileEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'owner_user_id' })
  ownerUserId: string = '';

  @Column({ type: 'char', length: 26, nullable: true, name: 'space_id' })
  spaceId: string | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'folder_id' })
  folderId: string | null = null;

  @Column({ type: 'varchar', length: 255 })
  title: string = '未命名脑图';

  @Column({ type: 'varchar', length: 16 })
  structure: string = 'mindmap';

  @Column({ type: 'varchar', length: 32, name: 'theme_id' })
  themeId: string = 'gmind-light';

  @Column({ type: 'int', name: 'node_count' })
  nodeCount: number = 1;

  @Column({ type: 'longblob', nullable: true, name: 'doc_state' })
  docState: Buffer | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'last_opened_at' })
  lastOpenedAt: Date | null = null;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'deleted_at' })
  deletedAt: Date | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'deleted_by' })
  deletedBy: string | null = null;

  // 显式 name 对齐迁移的 snake_case 列名（typeorm 默认用属性名，会生成 `createdAt` 而非 `created_at`）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
