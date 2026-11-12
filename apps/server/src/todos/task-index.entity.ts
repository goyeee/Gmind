import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/** 跨文件待办的任务索引行（抽取自 docState 节点 task；第二期批次 B）。 */
@Entity('task_index')
@Index('uk_task_file_node', ['fileId', 'nodeId'], { unique: true })
@Index('idx_task_file', ['fileId'])
export class TaskIndexEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'varchar', length: 64, name: 'node_id' })
  nodeId: string = '';

  @Column({ type: 'varchar', length: 255 })
  text: string = '';

  /** 任务负责人 userId 逗号分隔（MySQL 5.6 无 JSON→text+FIND_IN_SET，纪律 3）。 */
  @Column({ type: 'text', name: 'owners_csv' })
  ownersCsv: string = '';

  @Column({ type: 'varchar', length: 16 })
  status: string = 'todo';

  @Column({ type: 'int', default: 0 })
  progress: number = 0;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'start_date' })
  startDate: string | null = null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'due_date' })
  dueDate: string | null = null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'done_date' })
  doneDate: string | null = null;

  @Column({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
