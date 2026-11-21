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

  /** 节点所属画布 id（第二轮）：NULL=旧口径行（未重建，画布显示「未知画布」）。 */
  @Column({ type: 'char', length: 26, nullable: true, name: 'canvas_id' })
  canvasId: string | null = null;

  /** 画布名快照（重建时值）：改名后下次落库重建自然刷新。 */
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'canvas_name' })
  canvasName: string | null = null;

  @Column({ type: 'varchar', length: 64, name: 'node_id' })
  nodeId: string = '';

  @Column({ type: 'varchar', length: 255 })
  text: string = '';

  /** 任务负责人 userId 逗号分隔（MySQL 5.6 无 JSON→text+FIND_IN_SET，纪律 3）。
   *  第二轮起至多一个 id（单总负责人模型），查询语义不变。 */
  @Column({ type: 'text', name: 'owners_csv' })
  ownersCsv: string = '';

  /** 派生总状态（第二轮）：与 taskStatusOf 同算法——自动父随子级汇总，手动=自身。 */
  @Column({ type: 'varchar', length: 16 })
  status: string = 'todo';

  /** 有效任务总进度（第二轮）：与 taskProgressOf 同算法——自动父=Σ直属真正任务均值。 */
  @Column({ type: 'int', default: 0 })
  progress: number = 0;

  /** 总负责人可选执行子进度（第二轮）：mySubProgress 的负责人来源；未设置为 NULL。 */
  @Column({ type: 'int', nullable: true, name: 'owner_progress' })
  ownerProgress: number | null = null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'start_date' })
  startDate: string | null = null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'due_date' })
  dueDate: string | null = null;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'done_date' })
  doneDate: string | null = null;

  @Column({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
