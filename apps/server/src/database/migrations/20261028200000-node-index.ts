import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * node_index（2026-10-28 P1 节点内容全文搜索）：全节点文本索引（区别于 task_index
 * 仅任务节点——待办统计口径不被搜索稀释）。重建挂 TaskIndexService.rebuildForFile
 * 同一事务（docState 落库点 fire-and-forget 同模式）。utf8mb4_unicode_ci 对齐全库。
 */
export class NodeIndex20261028200000 implements MigrationInterface {
  name = 'NodeIndex20261028200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS \`node_index\` (
      \`id\` char(26) NOT NULL,
      \`file_id\` char(26) NOT NULL,
      \`node_id\` varchar(64) NOT NULL,
      \`text\` text NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_node_file_node\` (\`file_id\`, \`node_id\`),
      KEY \`idx_node_file\` (\`file_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `node_index`');
  }
}
