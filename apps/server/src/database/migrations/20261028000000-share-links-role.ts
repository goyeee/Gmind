import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * share_links.role（2026-10-28 P0）：链接分享权限档位 editor|viewer。
 * 缺省 'editor'——存量链接行为零变化（此前链接默认可编辑正是要堵的权限漏洞，
 * 新链接可由 owner 选「仅查看」）；viewer 链接 join 的协作者行 role=viewer（只读）。
 */
export class ShareLinksRole20261028000000 implements MigrationInterface {
  name = 'ShareLinksRole20261028000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `share_links` ADD COLUMN `role` enum('editor','viewer') NOT NULL DEFAULT 'editor'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `share_links` DROP COLUMN `role`');
  }
}
