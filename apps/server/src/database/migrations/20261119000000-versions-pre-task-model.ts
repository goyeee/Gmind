import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * versions.type 枚举扩展（Task 2，2026-11-20 任务模型迁移）：新增 'pre_task_model'
 * ——旧多负责人/人员列旧形状文档首次装载（任务模型迁移）前的原状存档，恢复口径
 * 与 pre_restore 同源（恢复目标=迁移前旧模型，恢复产物经装载通道再迁移）。
 * MySQL enum MODIFY 全值重写（既有值域不动，零数据风险）。
 */
export class VersionsPreTaskModel20261119000000 implements MigrationInterface {
  name = 'VersionsPreTaskModel20261119000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `versions` MODIFY COLUMN `type` enum('auto','manual','pre_restore','pre_task_model') NOT NULL",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "ALTER TABLE `versions` MODIFY COLUMN `type` enum('auto','manual','pre_restore') NOT NULL",
    );
  }
}
