import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { Init20260918000000 } from './migrations/20260918000000-init';
import { FilesLastModifier20260925000000 } from './migrations/20260925000000-files-last-modifier';
import { VersionsRestoredFrom20260926000000 } from './migrations/20260926000000-versions-restored-from';
import { UsersSystemRoleStatus20261001000000 } from './migrations/20261001000000-users-system-role-status';
import { FilesThumbSvg20261021000000 } from './migrations/20261021000000-files-thumb-svg';
import { OrgDepartmentsGroups20261024000000 } from './migrations/20261024000000-org-departments-groups';
import { TaskIndex20261024100000 } from './migrations/20261024100000-task-index';
import { FilesKind20261024200000 } from './migrations/20261024200000-files-kind';
import { ShareLinksRole20261028000000 } from './migrations/20261028000000-share-links-role';
import { NodeIndex20261028200000 } from './migrations/20261028200000-node-index';
import { AuthEmailFoundation20261112100000 } from './migrations/20261112100000-auth-email-foundation';

/** CLI 与 e2e 共用的数据源工厂；migration 在此显式注册。
 * 说明：不用 glob —— typeorm 的 glob 加载器会在运行时原生 require/import .ts 文件，
 * 依赖 Node strip-types 且无法消除 type-only import（MigrationInterface 等运行时不存在）。
 * 显式类注册在 vitest / tsx / tsc 三种管线下行为一致。 */
export function createDataSource(database: string): DataSource {
  return new DataSource({
    type: 'mysql',
    connectorPackage: 'mysql2',
    host: env.DB_HOST,
    port: env.DB_PORT,
    username: env.DB_USER,
    password: env.DB_PASSWORD,
    database,
    charset: 'utf8mb4_unicode_ci', // mysql2 的 charset 选项=连接排序规则：对齐全库建表 COLLATE（init 迁移显式 unicode_ci），避免字面量与列比较 mix collation（批次 B 实证）
    timezone: 'Z',
    synchronize: false,
    migrations: [Init20260918000000, FilesLastModifier20260925000000, VersionsRestoredFrom20260926000000, UsersSystemRoleStatus20261001000000, FilesThumbSvg20261021000000, OrgDepartmentsGroups20261024000000, TaskIndex20261024100000, FilesKind20261024200000, ShareLinksRole20261028000000, NodeIndex20261028200000, AuthEmailFoundation20261112100000],
    logging: false,
  });
}

export default createDataSource(env.DB_DATABASE);
