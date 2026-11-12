import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * files.kind（2026-10-24 第二期批次 D，spec §五）：文件类型 map|table。
 * 表格文件=同构 docState（裁定：不做独立数据模型），仅默认打开表格视图 +
 * 新建入口/徽标/类型筛选差异；缺省 'map' 存量数据零影响。
 */
export class FilesKind20261024200000 implements MigrationInterface {
  name = 'FilesKind20261024200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `files` ADD COLUMN `kind` varchar(16) NOT NULL DEFAULT 'map'");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `files` DROP COLUMN `kind`');
  }
}
