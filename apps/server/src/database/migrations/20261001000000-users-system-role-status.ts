import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * users.system_role / users.status（账号管理，移植 mindgrid）：
 * - system_role：'super_admin' | 'member'，默认 member——首注册者=超管（对齐 mindgrid）；
 * - status：'active' | 'disabled'，默认 active——只停用不删除，停用后登录与会话即刻失效。
 *
 * 数据迁移：存量用户中「最早创建的一个」升 super_admin（created_at 同毫秒以 id 决出，
 * 口径同 mindgrid 的 ORDER BY created_at ASC, id ASC）。空表时 UPDATE 影响 0 行，无副作用。
 * 新环境首注册者的超管判定在建号路径（UsersService.create 按 count 判定）。
 */
export class UsersSystemRoleStatus20261001000000 implements MigrationInterface {
  name = 'UsersSystemRoleStatus20261001000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE `users` ADD COLUMN `system_role` varchar(20) NOT NULL DEFAULT 'member'");
    await queryRunner.query("ALTER TABLE `users` ADD COLUMN `status` varchar(20) NOT NULL DEFAULT 'active'");
    await queryRunner.query(
      "UPDATE `users` SET `system_role` = 'super_admin' ORDER BY `created_at` ASC, `id` ASC LIMIT 1",
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 角色无法无损回滚（升过超管的记录会丢失），down 仅还列
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `status`');
    await queryRunner.query('ALTER TABLE `users` DROP COLUMN `system_role`');
  }
}
