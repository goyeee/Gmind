import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDataSource } from '../src/database/data-source';

describe('init migration', () => {
  const ds = createDataSource('gmind_test');

  beforeAll(async () => {
    await ds.initialize();
    // drop 清单必须随新迁移的表同步（组织管理批次 A：org_* 三表；漏加会导致
    // Org 迁移重放 "already exists" 半途失败且账本不记——2026-10-24 实证）
    await ds.query('DROP TABLE IF EXISTS users, folders, files, file_collaborators, file_stars, share_links, invites, comments, notifications, events, versions, org_user_groups, org_groups, org_departments, task_index, task_participant, todo_scope_config, node_index');
    // 同时清掉 typeorm 的迁移记录表，保证每次 e2e 都真正重放 init migration
    await ds.query('DROP TABLE IF EXISTS migrations');
    await ds.runMigrations();
  });

  afterAll(async () => {
    await ds.destroy();
  });

  it('建出 spec §7.1 全部业务表（含后续迁移的 org_* 三表）且字符集为 utf8mb4', async () => {
    const rows: { Tables_in_gmind_test: string }[] = await ds.query('SHOW TABLES');
    // TypeORM 的迁移记录表（bookkeeping）不属于业务表
    const tables = rows.map((r) => Object.values(r)[0] as string).filter((t) => t !== 'migrations').sort();
    expect(tables).toEqual([
      'comments', 'events', 'file_collaborators', 'file_stars', 'files',
      'folders', 'invites', 'node_index', 'notifications', 'org_departments', 'org_groups',
      'org_user_groups', 'share_links', 'task_index', 'task_participant', 'todo_scope_config', 'users', 'versions',
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
