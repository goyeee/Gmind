import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 账号体系重做地基（2026-11-12，spec §4.1）：email 升非空（邮箱注册制唯一身份键）+
 * 预留微信扫码登录 unionid 列（微信通道已删，真实绑定/扫码登录待公众号与开放平台
 * 条件就绪另做任务）。存量 NULL email 行由部署流程清库重跑（compose:up + db:migrate，
 * 不清库直接迁移会撞存量 NULL 行）；uk_users_phone/email/wechat 原样保留，不建新表
 * （验证码存 Redis）。唯一键对 NULL 不去重：存量/新增行 wechat_unionid=NULL 不冲突。
 */
export class AuthEmailFoundation20261112100000 implements MigrationInterface {
  name = 'AuthEmailFoundation20261112100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`users\`
      MODIFY COLUMN \`email\` varchar(191) NOT NULL,
      ADD COLUMN \`wechat_unionid\` varchar(64) NULL,
      ADD UNIQUE KEY \`uk_users_unionid\` (\`wechat_unionid\`)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`users\`
      DROP INDEX \`uk_users_unionid\`,
      DROP COLUMN \`wechat_unionid\`,
      MODIFY COLUMN \`email\` varchar(191) NULL`);
  }
}
