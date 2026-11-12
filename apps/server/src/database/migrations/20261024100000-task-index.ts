import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * task_index（2026-10-24 第二期批次 B，spec §三）：跨文件待办的服务端任务索引。
 * - 持久化落库（collab storeDocument / PUT doc-state）后从 docState 全量重建本表；
 * - owners_csv：任务负责人 userId 逗号分隔（MySQL 5.6 无 JSON→text+FIND_IN_SET，纪律 3）；
 * - UNIQUE(file_id, node_id) 幂等锚点；KEY(owners_csv) 前缀无意义（FIND_IN_SET 全表扫），
 *   量级=有任务节点数，可接受。
 */
export class TaskIndex20261024100000 implements MigrationInterface {
  name = 'TaskIndex20261024100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `task_index` (' +
        '`id` char(26) NOT NULL PRIMARY KEY, ' +
        '`file_id` char(26) NOT NULL, ' +
        '`node_id` char(64) NOT NULL, ' +
        '`text` varchar(255) NOT NULL, ' +
        '`owners_csv` text NOT NULL, ' +
        '`status` varchar(16) NOT NULL, ' +
        '`progress` int NOT NULL DEFAULT 0, ' +
        '`start_date` varchar(10) NULL, ' +
        '`due_date` varchar(10) NULL, ' +
        '`done_date` varchar(10) NULL, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'UNIQUE KEY `uk_task_file_node` (`file_id`, `node_id`), ' +
        'KEY `idx_task_file` (`file_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `task_index`');
  }
}
