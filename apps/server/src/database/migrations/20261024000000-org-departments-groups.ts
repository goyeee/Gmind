import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 组织管理（2026-10-24 第二期批次 A，spec 2026-10-24-phase2-features-design §二）：
 * - org_departments：部门（账号单选挂靠）；
 * - org_groups：分组（账号多选挂靠，color 为标签底色可空）；
 * - org_user_groups：账号↔分组多对多；
 * - users.department_id：账号所属部门（可空）。
 * 均为可空/独立表，存量数据零影响。
 */
export class OrgDepartmentsGroups20261024000000 implements MigrationInterface {
  name = 'OrgDepartmentsGroups20261024000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE `org_departments` (`id` char(26) NOT NULL PRIMARY KEY, `name` varchar(64) NOT NULL UNIQUE, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))',
    );
    await queryRunner.query(
      'CREATE TABLE `org_groups` (`id` char(26) NOT NULL PRIMARY KEY, `name` varchar(64) NOT NULL UNIQUE, `color` varchar(16) NULL, `created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3))',
    );
    await queryRunner.query(
      'CREATE TABLE `org_user_groups` (`user_id` char(26) NOT NULL, `group_id` char(26) NOT NULL, PRIMARY KEY (`user_id`, `group_id`))',
    );
    await queryRunner.query('ALTER TABLE `users` ADD COLUMN `department_id` char(26) NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `department_id`');
    await queryRunner.query('DROP TABLE `org_user_groups`');
    await queryRunner.query('DROP TABLE `org_groups`');
    await queryRunner.query('DROP TABLE `org_departments`');
  }
}
