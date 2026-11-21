import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/**
 * 人员列参与人索引行（任务第二轮，spec §5.1）：从 docState 节点 custom 人员列
 * 逐条目抽取——同一任务同一人多列各一行（唯一键 file_id+node_id+user_id+col_id）。
 * 「我的待办」按人圈范围（user_id,file_id 索引）与「我的子进度」取值都走本表；
 * 总负责人不入本表（owner 在 task_index.owners_csv，其执行子进度在 owner_progress）。
 */
@Entity('task_participant')
@Index('uk_task_part_node_user_col', ['fileId', 'nodeId', 'userId', 'colId'], { unique: true })
@Index('idx_task_part_user_file', ['userId', 'fileId'])
export class TaskParticipantEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'varchar', length: 64, name: 'node_id' })
  nodeId: string = '';

  @Column({ type: 'char', length: 26, name: 'user_id' })
  userId: string = '';

  /** 该人员该列条目的子进度（0-100）。 */
  @Column({ type: 'int', default: 0 })
  progress: number = 0;

  /** 所属人员自定义列 id（uuid，36 位；varchar(64) 留余量）。 */
  @Column({ type: 'varchar', length: 64, name: 'col_id' })
  colId: string = '';

  @Column({ type: 'datetime', precision: 3, name: 'updated_at' })
  updatedAt: Date = new Date();
}
