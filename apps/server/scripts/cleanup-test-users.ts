/**
 * 测试账号清理（2026-10-28 P1 开发库卫生；2026-11-13 判据随账号邮箱化重做）：
 * e2e 与开发库共用。旧判据「昵称 用户NNNN + 138 手机前缀」随手机注册通道删除失效
 * （新注册无手机号、昵称注册时必填），改按 e2e 造号邮箱域识别：
 *   - server e2e：@test.dev（test/support/auth-test.ts uniqueEmail 默认域）
 *   - web e2e：@e2e.gmind.dev（apps/web/e2e/helpers/auth.ts E2E_DOMAIN）
 *
 * 只清同时满足以下条件的账号（**不误伤真实使用账号**）：
 *   - email 后缀为上述两个 e2e 域（演示号 @gmind.dev 等不在判据内）
 *   - 名下无任何文件（owner）且无任何协作者关系（file_collaborators 行）
 *
 * 用法（在 apps/server 目录）：
 *   DB_DATABASE=gmind_test npx tsx scripts/cleanup-test-users.ts            # dry-run：只列将删的数量与样本，不写库
 *   DB_DATABASE=gmind_test npx tsx scripts/cleanup-test-users.ts --apply    # 实删（连带 users 行；会话 Redis 无需处理）
 *
 * 环境：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE 同 server env（默认
 * 127.0.0.1:33061 / gmind；DB_DATABASE 可用环境变量覆盖，如 gmind_test）。
 */
import mysql from 'mysql2/promise';

interface TestUserRow {
  id: string;
  email: string;
  nickname: string;
  createdAt: Date;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 33061),
    user: process.env.DB_USER ?? 'root',
    password: process.env.DB_PASSWORD ?? 'gminddev',
    database: process.env.DB_DATABASE ?? 'gmind',
  });

  const [rows] = (await conn.query(
    `SELECT u.id, u.email, u.nickname, u.created_at AS createdAt
     FROM users u
     WHERE (u.email LIKE '%@test.dev' OR u.email LIKE '%@e2e.gmind.dev')
       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.owner_user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.user_id = u.id)`,
  )) as [TestUserRow[], unknown];

  console.log(`[cleanup] 命中测试账号 ${rows.length} 个（@test.dev/@e2e.gmind.dev + 无文件无协作）`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  样本：${r.id} ${r.email} ${r.nickname} 注册于 ${r.createdAt.toISOString().slice(0, 10)}`);
  }
  if (rows.length > 10) console.log(`  …另 ${rows.length - 10} 个未列出`);

  if (!apply) {
    console.log('[cleanup] dry-run 完成，未写库。确认无误后加 --apply 实删。');
    await conn.end();
    return;
  }
  if (rows.length === 0) {
    console.log('[cleanup] 无可清理账号。');
    await conn.end();
    return;
  }
  const ids = rows.map((r) => r.id);
  const [res] = (await conn.query('DELETE FROM users WHERE id IN (?)', [ids])) as [{ affectedRows: number }, unknown];
  console.log(`[cleanup] 已删除 ${res.affectedRows} 个测试账号。`);
  await conn.end();
}

void main().catch((e) => {
  console.error('[cleanup] 失败：', e);
  process.exit(1);
});
