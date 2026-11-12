/**
 * 测试账号清理（2026-10-28 P1 开发库卫生）：
 * e2e 与开发库共用，长期累积「138 前缀 + 昵称 用户NNNN」的注册账号（曾 2.3 万+）。
 *
 * 只清同时满足以下条件的账号（**不误伤真实使用账号**）：
 *   - nickname 匹配 ^用户\d{4}$（e2e 默认昵称形态）
 *   - phone 以 '138' 开头（e2e 随机手机号前缀）
 *   - 名下无任何文件（owner）且无任何协作者关系（file_collaborators 行）
 *
 * 用法（在 apps/server 目录）：
 *   npx tsx scripts/cleanup-test-users.ts            # dry-run：只列出将删除的数量与样本，不写库
 *   npx tsx scripts/cleanup-test-users.ts --apply    # 实删（连带 users 行；会话 Redis 无需处理）
 *
 * 环境：DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE 同 server env（默认 127.0.0.1:33061）。
 */
import mysql from 'mysql2/promise';

interface TestUserRow {
  id: string;
  nickname: string;
  phone: string | null;
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
    `SELECT u.id, u.nickname, u.phone, u.created_at AS createdAt
     FROM users u
     WHERE u.nickname REGEXP '^用户[0-9]{4}$'
       AND u.phone LIKE '138%'
       AND NOT EXISTS (SELECT 1 FROM files f WHERE f.owner_user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM file_collaborators fc WHERE fc.user_id = u.id)`,
  )) as [TestUserRow[], unknown];

  console.log(`[cleanup] 命中测试账号 ${rows.length} 个（昵称 用户NNNN + 138 前缀 + 无文件无协作）`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  样本：${r.id} ${r.nickname} ${r.phone} 注册于 ${r.createdAt.toISOString().slice(0, 10)}`);
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
