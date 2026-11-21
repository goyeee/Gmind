import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 任务第二轮（2026-11-21，spec 2026-11-21-task-round2-design §5.1）：
 * - 新表 task_participant：人员列参与人逐条目索引（逐人子进度要按人查询并取值，
 *   CSV 存不了逐人进度也无索引可用，故独立成表）；唯一键 (file_id,node_id,user_id,col_id)
 *   ——同节点多列同人各一行；KEY(user_id,file_id) 供「我的待办」按人圈范围。
 * - task_index 加列：canvas_id/canvas_name（待办行显示画布、文件→画布两级分组）；
 *   owner_progress（总负责人可选执行子进度——mySubProgress 的负责人来源）。
 *   progress/status/done_date 语义改存派生口径（列不动，重建写入时换值）。
 * - 旧口径行 canvas_id IS NULL：文件装载后触发一次后台重建（与装载触发点同通道），
 *   未打开过的文件画布显示「未知画布」——不跑全量离线重建（避免部署期长事务）。
 */
export class TaskParticipant20261121100000 implements MigrationInterface {
  name = 'TaskParticipant20261121100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `task_participant` (' +
        '`id` char(26) NOT NULL PRIMARY KEY, ' +
        '`file_id` char(26) NOT NULL, ' +
        '`node_id` varchar(64) NOT NULL, ' +
        '`user_id` char(26) NOT NULL, ' +
        '`progress` int NOT NULL DEFAULT 0, ' +
        '`col_id` varchar(64) NOT NULL, ' +
        '`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'UNIQUE KEY `uk_task_part_node_user_col` (`file_id`, `node_id`, `user_id`, `col_id`), ' +
        'KEY `idx_task_part_user_file` (`user_id`, `file_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
    // MySQL 5.6：ADD COLUMN 单条原子；canvas 系列可空=旧行「未知画布」标记
    await queryRunner.query(
      'ALTER TABLE `task_index` ' +
        'ADD COLUMN `canvas_id` char(26) NULL AFTER `node_id`, ' +
        'ADD COLUMN `canvas_name` varchar(100) NULL AFTER `canvas_id`, ' +
        'ADD COLUMN `owner_progress` int NULL AFTER `progress`',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `task_participant`');
    await queryRunner.query(
      'ALTER TABLE `task_index` DROP COLUMN `canvas_id`, DROP COLUMN `canvas_name`, DROP COLUMN `owner_progress`',
    );
  }
}
