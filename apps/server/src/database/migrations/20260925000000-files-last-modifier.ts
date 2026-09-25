import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * files.last_modifier_user_id（M3a Task 4，FR-FIL-001）：最后修改人链路落库列。
 *
 * 写入通道（两条，均为「与请求者身份校验后」的值）：
 * - 协同持久化：collab onStoreDocument 读 doc meta.lastEditorUserId 回写；
 * - PUT 兜底：body.lastEditorUserId === token 用户才落库（离线补报，防代写）。
 * 可空：历史行与从未编辑的文件无修改人信息；索引支撑「按修改人查询」的列表视图。
 */
export class FilesLastModifier20260925000000 implements MigrationInterface {
  name = 'FilesLastModifier20260925000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // MySQL 5.6：ADD COLUMN 与 ADD KEY 同语句完成（单次表重建）
    await queryRunner.query(
      'ALTER TABLE `files` ADD COLUMN `last_modifier_user_id` char(26) NULL, ADD KEY `idx_files_last_modifier` (`last_modifier_user_id`)',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE `files` DROP KEY `idx_files_last_modifier`, DROP COLUMN `last_modifier_user_id`',
    );
  }
}
