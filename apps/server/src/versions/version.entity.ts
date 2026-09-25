import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 版本快照行（M4 Task 6，FR-VER-001）：collab 网关 auto 节流快照 / 手动版本 / 恢复前
 * pre_restore 共用一表。表结构由 init migration 建出，restored_from 列由
 * 20260926000000 迁移新增；本实体仅补 ORM 映射（显式列名纪律：snake_case 对齐迁移）。
 * id 由写入方生成（collab insertVersionSnapshot 与后续 versions 域同用 ulid()，
 * users/files 同款来源），非 @PrimaryGeneratedColumn。
 */
@Entity('versions')
export class VersionEntity {
  @PrimaryColumn({ type: 'char', length: 26, name: 'id' }) id!: string;
  @Column({ type: 'char', length: 26, name: 'file_id' }) fileId!: string;
  @Column({ type: 'int', name: 'node_count' }) nodeCount!: number;
  @Column({ type: 'char', length: 26, name: 'created_by', nullable: true }) createdBy!: string | null;
  @Column({ type: 'enum', enum: ['auto', 'manual', 'pre_restore'], name: 'type' }) type!: 'auto' | 'manual' | 'pre_restore';
  @Column({ type: 'longblob', name: 'state' }) state!: Buffer;
  @Column({ type: 'datetime', precision: 3, name: 'created_at' }) createdAt!: Date;
  // 恢复溯源（FR-VER-002）：恢复自某版本时指向来源版本行 id；auto/manual 为 null
  @Column({ type: 'char', length: 26, name: 'restored_from', nullable: true }) restoredFrom!: string | null;
}
