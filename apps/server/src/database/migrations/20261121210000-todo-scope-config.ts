import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 我的待办/统计面板参与范围配置（2026-11-21 需求方追加）：每用户可把文件/画布从
 * 「我的待办 + 统计面板」中排除。
 * - canvas_id = '' 表示**整个文件**排除；非空 = 仅排除该画布（任务所在画布）；
 * - 默认语义 = 全关联（无排除行即参与），新文件无需任何写入；
 * - 唯一键 (user_id, file_id, canvas_id) 幂等；canvas_id NOT NULL（MySQL 唯一索引
 *   对 NULL 不去重，用空串作「文件级」哨兵）。
 */
export class TodoScopeConfig20261121210000 implements MigrationInterface {
  name = 'TodoScopeConfig20261121210000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `todo_scope_config` (' +
        '`id` char(26) NOT NULL PRIMARY KEY, ' +
        '`user_id` char(26) NOT NULL, ' +
        '`file_id` char(26) NOT NULL, ' +
        "`canvas_id` varchar(64) NOT NULL DEFAULT '', " +
        '`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ' +
        'UNIQUE KEY `uk_todo_scope` (`user_id`, `file_id`, `canvas_id`)' +
        ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `todo_scope_config`');
  }
}
