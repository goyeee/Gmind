import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

export type InviteContactType = 'email' | 'phone';
export type InviteStatus = 'pending' | 'accepted' | 'revoked';

/**
 * 邀请（迁移表 invites，M0 建表无迁移改动）。M3b Task 5，FR-SHR-004。
 *
 * uk_invite (file_id, contact_type, contact) 唯一键在 DB 层：同一文件同一联系号
 * 至多一行，重邀/回填均收敛到该行状态流转，不繁殖行。idx_invite_contact 与迁移对齐。
 */
@Entity('invites')
@Index('idx_invite_contact', ['contact'])
export class InviteEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'enum', enum: ['email', 'phone'], name: 'contact_type' })
  contactType: InviteContactType = 'email';

  @Column({ type: 'varchar', length: 191 })
  contact: string = '';

  @Column({ type: 'char', length: 26, name: 'invited_by' })
  invitedBy: string = '';

  @Column({ type: 'enum', enum: ['pending', 'accepted', 'revoked'] })
  status: InviteStatus = 'pending';

  @Column({ type: 'char', length: 26, nullable: true, name: 'accepted_user_id' })
  acceptedUserId: string | null = null;

  // 显式 name 对齐迁移的 snake_case 列名（同 share-link.entity.ts 的约定）
  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
