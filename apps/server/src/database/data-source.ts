import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { Init20260918000000 } from './migrations/20260918000000-init';
import { FilesLastModifier20260925000000 } from './migrations/20260925000000-files-last-modifier';
import { VersionsRestoredFrom20260926000000 } from './migrations/20260926000000-versions-restored-from';

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
    charset: 'utf8mb4',
    timezone: 'Z',
    synchronize: false,
    migrations: [Init20260918000000, FilesLastModifier20260925000000, VersionsRestoredFrom20260926000000],
    logging: false,
  });
}

export default createDataSource(env.DB_DATABASE);
