import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ulid } from 'ulid';

export type CommentStatus = 'open' | 'resolved';

/**
 * 评论（迁移表 comments，M0 init 即建表；M3b Task 6 首次接线，FR-CMT-001/003）。
 *
 * 列对齐迁移 DDL（synchronize=false，实体仅为既有表提供类型化读写面）：
 * - node_text_snapshot：创建时节点文本快照（≤500 字符截断），不随节点编辑/删除变化；
 * - parent_id：楼中楼挂载点——一律指向线程楼主行（reply-to-reply 拍平到顶层祖先，
 *   见 CommentsService.reply），null = 楼主；
 * - mentions：JSON 文本（text 列，MySQL 5.6 无 JSON 类型），值为归一化后的 userId 数组
 *   （仅 owner+协作者，见 CommentsService.filterMentions）；T8 通知以此为准。
 */
@Entity('comments')
@Index('idx_comments_file', ['fileId'])
@Index('idx_comments_node', ['nodeId'])
@Index('idx_comments_parent', ['parentId'])
export class CommentEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'char', length: 26, name: 'node_id' })
  nodeId: string = '';

  @Column({ type: 'varchar', length: 500, name: 'node_text_snapshot' })
  nodeTextSnapshot: string = '';

  @Column({ type: 'char', length: 26, nullable: true, name: 'parent_id' })
  parentId: string | null = null;

  @Column({ type: 'char', length: 26, name: 'author_id' })
  authorId: string = '';

  @Column({ type: 'text' })
  content: string = '';

  @Column({ type: 'text', nullable: true })
  mentions: string | null = null;

  @Column({ type: 'enum', enum: ['open', 'resolved'] })
  status: CommentStatus = 'open';

  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();

  @UpdateDateColumn({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
