import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

export type FileCollaboratorRole = 'owner' | 'editor' | 'commenter' | 'viewer';

/** 协作者（迁移表 file_collaborators，uk_fc_file_user 唯一键在 DB 层）。一期 collaborator 即可编辑。 */
@Entity('file_collaborators')
@Index('idx_fc_user', ['userId'])
export class FileCollaboratorEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  @Column({ type: 'enum', enum: ['owner', 'editor', 'commenter', 'viewer'] })
  role: FileCollaboratorRole = 'viewer';

  // 显式 name 对齐迁移的 snake_case 列名（同 file.entity.ts 的约定）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
