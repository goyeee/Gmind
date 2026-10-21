import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * files.thumb_svg（2026-10-21 工作台真实缩略图，需求方裁定真实内容快照）：
 * 编辑器在保存落库（persisted ack）后由引擎 layout 直出 SVG 字符串上传存此列；
 * 工作台文件卡片经 GET /api/files/:id/thumbnail 懒加载。MEDIUMTEXT（≤16MB，
 * 实际服务端准入 ≤256KB）；NULL = 尚无快照（卡片回退装饰性缩略图）。
 */
export class FilesThumbSvg20261021000000 implements MigrationInterface {
  name = 'FilesThumbSvg20261021000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `files` ADD COLUMN `thumb_svg` mediumtext NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `files` DROP COLUMN `thumb_svg`');
  }
}
