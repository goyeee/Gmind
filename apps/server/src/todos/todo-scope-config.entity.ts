import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/**
 * 待办/统计参与范围配置行（2026-11-21 需求方追加）：一行 = 用户对某文件（或其中
 * 一个画布）的排除。默认全关联——无行即参与，新文件自动生效，无需任何写入。
 * canvas_id = '' 哨兵表示**整个文件**排除（MySQL 唯一索引对 NULL 不去重，不用 NULL）。
 */
@Entity('todo_scope_config')
@Index('uk_todo_scope', ['userId', 'fileId', 'canvasId'], { unique: true })
export class TodoScopeConfigEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  /** '' = 整个文件排除；否则为画布 id（任务所在画布）。 */
  @Column({ type: 'varchar', length: 64, name: 'canvas_id', default: '' })
  canvasId: string = '';

  @CreateDateColumn({ type: 'datetime', precision: 3, name: 'created_at' })
  createdAt: Date = new Date();
}
