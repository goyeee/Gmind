import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';

/** folders 表实体（M0 init 迁移即建表；M3a Task 5 首次接线，FR-FIL-002）。
 *  space_id 一期恒 NULL（个人空间口径），保留列位为 M4 团队空间预留。 */
@Entity('folders')
@Index('idx_folders_owner', ['ownerUserId'])
export class FolderEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'owner_user_id' })
  ownerUserId: string = '';

  @Column({ type: 'char', length: 26, nullable: true, name: 'space_id' })
  spaceId: string | null = null;

  @Column({ type: 'char', length: 26, nullable: true, name: 'parent_id' })
  parentId: string | null = null;

  @Column({ type: 'varchar', length: 64 })
  name: string = '';

  // 根为 1；上限 MAX_FOLDER_DEPTH（FR-FIL-002），创建/移动双入口共用校验
  @Column({ type: 'tinyint' })
  depth: number = 1;

  @Column({ type: 'datetime', precision: 3, nullable: true, name: 'deleted_at' })
  deletedAt: Date | null = null;

  // 显式 name 对齐迁移的 snake_case 列名（同 file.entity.ts 口径）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
