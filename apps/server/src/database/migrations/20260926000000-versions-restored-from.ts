import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * versions.restored_from（M4 Task 6，FR-VER-002）：恢复溯源列——从某版本恢复出的
 * 文件写入 pre_restore 快照时，指向被恢复的来源版本行 id（26 位 ULID）。
 * 可空：auto/manual 快照无恢复来源。versions 表已由 init migration 建出，此处仅加列。
 */
export class VersionsRestoredFrom20260926000000 implements MigrationInterface {
  name = 'VersionsRestoredFrom20260926000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `versions` ADD COLUMN `restored_from` char(26) NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `versions` DROP COLUMN `restored_from`');
  }
}
