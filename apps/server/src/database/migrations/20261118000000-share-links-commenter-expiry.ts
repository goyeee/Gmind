import { MigrationInterface, QueryRunner } from 'typeorm';

/** 分享链接三档角色 + 持久化有效期档位；存量角色/密码/到期时间原值保留。 */
export class ShareLinksCommenterExpiry20261118000000 implements MigrationInterface {
  name = 'ShareLinksCommenterExpiry20261118000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `share_links` MODIFY COLUMN `role` enum('editor','viewer','commenter') NOT NULL DEFAULT 'editor'");
    await queryRunner.query("ALTER TABLE `share_links` ADD COLUMN `expires_in` enum('forever','7','30') NOT NULL DEFAULT 'forever' AFTER `expires_at`");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `share_links` DROP COLUMN `expires_in`');
    await queryRunner.query("ALTER TABLE `share_links` MODIFY COLUMN `role` enum('editor','viewer') NOT NULL DEFAULT 'editor'");
  }
}
