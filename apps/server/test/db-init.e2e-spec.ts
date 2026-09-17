import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataSource } from '../src/database/data-source';

describe('init migration', () => {
  const ds = createDataSource('gmind_test');

  beforeAll(async () => {
    await ds.initialize();
    await ds.query('DROP TABLE IF EXISTS users, folders, files, file_collaborators, file_stars, share_links, invites, comments, notifications, events, versions');
    // 同时清掉 typeorm 的迁移记录表，保证每次 e2e 都真正重放 init migration
    await ds.query('DROP TABLE IF EXISTS migrations');
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('建出 spec §7.1 全部 11 张表且字符集为 utf8mb4', async () => {
    const rows: { Tables_in_gmind_test: string }[] = await ds.query('SHOW TABLES');
    // TypeORM 的迁移记录表（bookkeeping）不属于业务表
    const tables = rows.map((r) => Object.values(r)[0] as string).filter((t) => t !== 'migrations').sort();
    expect(tables).toEqual([
      'comments', 'events', 'file_collaborators', 'file_stars', 'files',
      'folders', 'invites', 'notifications', 'share_links', 'users', 'versions',
    ]);
    const cs: { TABLE_NAME: string; TABLE_COLLATION: string }[] = await ds.query(
      `SELECT TABLE_NAME, TABLE_COLLATION FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = 'gmind_test'`,
    );
    for (const row of cs) {
      expect(row.TABLE_COLLATION).toContain('utf8mb4');
    }
  });

  it('doc_state 为 longblob（Yjs 状态，spec §4.3）', async () => {
    const cols: { DATA_TYPE: string }[] = await ds.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA='gmind_test' AND TABLE_NAME='files' AND COLUMN_NAME='doc_state'`,
    );
    expect(cols[0]?.DATA_TYPE).toBe('longblob');
  });
});
