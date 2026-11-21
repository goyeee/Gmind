/**
 * e2e 测试数据全量清理（2026-11-21，AGENTS 六.6「测试数据用完即删」的自动化兑现）：
 * web e2e 套件的 playwright globalTeardown（apps/web/e2e/global-teardown.ts）在整套
 * 跑完（含失败）后自动调用本脚本 --apply；也可手工单独执行。
 *
 * 判据（**只删可判据化的测试数据，不误伤真实账号**——与 docs/task-system-acceptance.md
 * 两批手工清理完全同口径）：
 *   - 账号：email 以 @e2e.gmind.dev / @test.dev 结尾，或 memberNNNN@、smoke9- 前缀；
 *   - 文件：上述账号名下的（含回收站）；连带清协作/星标/评论/版本/分享/邀请/事件/
 *     节点索引/任务索引/任务参与人/范围配置/通知/目录等关联行（按 file 与 user 双向）；
 *   - 分组/部门：name 以 `e2e-` 前缀（spec 建组判据化命名），或历史残留的
 *     `XX-数字` 结尾编号名；保留账号对它们的挂靠（department_id、org_user_groups）一并解绑；
 *   - 对象存储：删除上述文件 id 对应的 storage files/ 目录与账号 users/ 头像目录。
 *
 * 用法（任意目录，经 pnpm filter 落在 apps/server 内执行）：
 *   pnpm --filter @gmind/server cleanup:e2e            # dry-run：只打印将删数量，不写库
 *   pnpm --filter @gmind/server cleanup:e2e -- --apply # 实删
 *
 * 环境：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE、STORAGE_DIR 同 server env
 * （默认 127.0.0.1:33061 / gmind / ./.data/storage）。幂等：重复执行无残留可删。
 * MySQL 5.6 临时表同语句不可引用两次——圈定结果落普通表（tmp_clean_*），用完即 DROP。
 */
import mysql from 'mysql2/promise';
import fs from 'node:fs';
import path from 'node:path';

/** 与 web e2e helpers/auth.ts E2E_DOMAIN、server e2e uniqueEmail 域保持同源。 */
const E2E_USER_SQL = `(email LIKE '%@e2e.gmind.dev' OR email LIKE '%@test.dev'
  OR email REGEXP '^member[0-9]+@' OR email LIKE 'smoke9-%')`;
/** spec 建组判据化命名（e2e- 前缀）+ 历史编号残留（研发部-52312、连选甲-725351…）。 */
const E2E_ORG_SQL = `(name LIKE 'e2e-%' OR name REGEXP '-[0-9]+$')`;

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const storageRoot = path.resolve(process.env.STORAGE_DIR ?? './.data/storage');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 33061),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'gminddev',
    database: process.env.DB_DATABASE ?? 'gmind',
    multipleStatements: false,
  });

  // —— 圈定（普通表，可幂等重跑）——
  await conn.query('DROP TABLE IF EXISTS tmp_clean_users, tmp_clean_files, tmp_clean_orgs');
  await conn.query(`CREATE TABLE tmp_clean_users AS SELECT id FROM users WHERE ${E2E_USER_SQL}`);
  await conn.query(
    'CREATE TABLE tmp_clean_files AS SELECT id FROM files WHERE owner_user_id IN (SELECT id FROM tmp_clean_users)',
  );
  await conn.query(
    `CREATE TABLE tmp_clean_orgs AS SELECT id, 'group' AS kind FROM org_groups WHERE ${E2E_ORG_SQL}
     UNION ALL SELECT id, 'dept' AS kind FROM org_departments WHERE ${E2E_ORG_SQL}`,
  );
  const [sweep] = (await conn.query(
    `SELECT (SELECT COUNT(*) FROM tmp_clean_users) AS users,
            (SELECT COUNT(*) FROM tmp_clean_files) AS files,
            (SELECT COUNT(*) FROM tmp_clean_orgs WHERE kind = 'group') AS groups,
            (SELECT COUNT(*) FROM tmp_clean_orgs WHERE kind = 'dept') AS depts`,
  )) as unknown as [Array<{ users: number; files: number; groups: number; depts: number }>];
  const sweep0 = sweep[0]!;
  console.log(
    `[cleanup-e2e] 判据命中：账号 ${sweep0.users}、名下文件 ${sweep0.files}、分组 ${sweep0.groups}、部门 ${sweep0.depts}`,
  );
  if (!apply) {
    console.log('[cleanup-e2e] dry-run 完成，未写库。加 --apply 实删（playwright globalTeardown 自动带）。');
    await conn.query('DROP TABLE IF EXISTS tmp_clean_users, tmp_clean_files, tmp_clean_orgs');
    await conn.end();
    return;
  }
  if (sweep0.users === 0 && sweep0.files === 0 && sweep0.groups === 0 && sweep0.depts === 0) {
    console.log('[cleanup-e2e] 无可清理测试数据。');
    await conn.query('DROP TABLE IF EXISTS tmp_clean_users, tmp_clean_files, tmp_clean_orgs');
    await conn.end();
    return;
  }

  // —— 依赖序删除（文件子表 → 用户子表 → 目录表 → 文件 → 账号）——
  const delByFile = async (table: string): Promise<void> => {
    await conn.query(
      `DELETE t FROM ${table} t LEFT JOIN tmp_clean_files f ON t.file_id = f.id WHERE f.id IS NOT NULL`,
    );
  };
  const delByUser = async (table: string, column: string): Promise<void> => {
    await conn.query(
      `DELETE t FROM ${table} t WHERE t.${column} IN (SELECT id FROM tmp_clean_users)`,
    );
  };
  await delByFile('comments');
  await delByUser('comments', 'author_id');
  await delByFile('events');
  await delByUser('events', 'user_id');
  await delByFile('versions');
  await delByFile('node_index');
  await delByFile('share_links');
  await delByUser('share_links', 'created_by');
  await delByFile('invites');
  await conn.query(
    `DELETE i FROM invites i WHERE i.invited_by IN (SELECT id FROM tmp_clean_users)
       OR i.accepted_user_id IN (SELECT id FROM tmp_clean_users)`,
  );
  await delByFile('file_collaborators');
  await delByUser('file_collaborators', 'user_id');
  await delByFile('file_stars');
  await delByUser('file_stars', 'user_id');
  await delByFile('task_index');
  await conn.query(
    `DELETE tp FROM task_participant tp LEFT JOIN tmp_clean_files f ON tp.file_id = f.id
       WHERE f.id IS NOT NULL OR tp.user_id IN (SELECT id FROM tmp_clean_users)`,
  );
  await conn.query(
    `DELETE ts FROM todo_scope_config ts WHERE ts.user_id IN (SELECT id FROM tmp_clean_users)
       OR ts.file_id IN (SELECT id FROM tmp_clean_files)`,
  );
  await delByUser('notifications', 'user_id');
  await delByUser('folders', 'owner_user_id');
  await conn.query(
    `DELETE oug FROM org_user_groups oug WHERE oug.user_id IN (SELECT id FROM tmp_clean_users)
       OR oug.group_id IN (SELECT id FROM tmp_clean_orgs)`,
  );
  // 保留账号挂到被删部门的引用解绑（无外键，应用层兜底）
  await conn.query(
    'UPDATE users SET department_id = NULL WHERE department_id IN (SELECT id FROM tmp_clean_orgs)',
  );
  await conn.query(
    `DELETE d FROM org_departments d WHERE d.id IN (SELECT id FROM tmp_clean_orgs)`,
  );
  await conn.query(`DELETE g FROM org_groups g WHERE g.id IN (SELECT id FROM tmp_clean_orgs)`);
  // 存储目录先取 id 清单再删行（目录名=文件 id）
  const [fileIds] = (await conn.query('SELECT id FROM tmp_clean_files')) as unknown as [
    Array<{ id: string }>,
  ];
  const [userIds] = (await conn.query('SELECT id FROM tmp_clean_users')) as unknown as [
    Array<{ id: string }>,
  ];
  // files 表主键是 id（没有 file_id 列），不能走 delByFile 的 ON t.file_id
  await conn.query('DELETE f FROM files f WHERE f.id IN (SELECT id FROM tmp_clean_files)');
  await delByUser('users', 'id');

  // —— 对象存储：命中文件/账号的目录直接移除（不存在则跳过）——
  let removedDirs = 0;
  for (const id of [...fileIds.map((r) => r.id)]) {
    const dir = path.join(storageRoot, 'files', id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removedDirs++;
    }
  }
  for (const id of [...userIds.map((r) => r.id)]) {
    const dir = path.join(storageRoot, 'users', id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removedDirs++;
    }
  }

  // —— 复核输出 ——
  const [after] = (await conn.query(
    `SELECT (SELECT COUNT(*) FROM users) AS users,
            (SELECT COUNT(*) FROM org_groups) AS groups,
            (SELECT COUNT(*) FROM org_departments) AS depts,
            (SELECT COUNT(*) FROM files) AS files`,
  )) as unknown as [Array<{ users: number; groups: number; depts: number; files: number }>];
  const a = after[0]!;
  console.log(
    `[cleanup-e2e] 已清理。库内现状：账号 ${a.users}、分组 ${a.groups}、部门 ${a.depts}、文件 ${a.files}；移除存储目录 ${removedDirs} 个。`,
  );
  await conn.query('DROP TABLE IF EXISTS tmp_clean_users, tmp_clean_files, tmp_clean_orgs');
  await conn.end();
}

void main().catch((e) => {
  console.error('[cleanup-e2e] 失败：', e);
  process.exit(1);
});
