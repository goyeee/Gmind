import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import { ulid } from 'ulid';

/** 全节点文本索引（2026-10-28 P1 全文搜索）：与 task_index 平行——只承载文本检索，
 *  不带任务语义（owners/status 等一律没有，避免待办统计口径被搜索稀释）。 */
@Entity('node_index')
@Index('uk_node_file_node', ['fileId', 'nodeId'], { unique: true })
@Index('idx_node_file', ['fileId'])
export class NodeIndexEntity {
  @PrimaryColumn({ type: 'char', length: 26 })
  id: string = ulid();

  @Column({ type: 'char', length: 26, name: 'file_id' })
  fileId: string = '';

  @Column({ type: 'varchar', length: 64, name: 'node_id' })
  nodeId: string = '';

  /** 节点文本（全量，不截断——搜索召回优先；节点文本本身有 core 长度上限）。 */
  @Column({ type: 'text' })
  text: string = '';
}
