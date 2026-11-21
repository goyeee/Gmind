/**
 * web e2e 全局收尾（2026-11-21，AGENTS 六.6「测试数据用完即删」的自动化兑现）：
 * 整套用例结束（**失败也会执行**）后，调用 server 的判据化清理脚本，把本轮注册的
 * e2e 账号、名下文件、编号命名的分组/部门及其关联行、对象存储目录一次清掉。
 * 判据与手工清理批次同口径（@e2e.gmind.dev / memberNNNN@ / e2e- 前缀 / XX-数字 编号），
 * 只删测试数据不误伤真实账号；明细见 apps/server/scripts/cleanup-e2e-data.ts 头注。
 *
 * 失败即抛：清理失败=开发库残留测试数据，必须显眼报错而不是静默吞掉。
 * 手工补救：pnpm --filter @gmind/server cleanup:e2e -- --apply
 */
import { spawnSync } from 'node:child_process';

export default function globalTeardown(): void {
  // pnpm --filter exec 落在 @gmind/server 目录内执行，与调用方 cwd 无关；
  // 清理脚本 DB/STORAGE_DIR 默认值即开发库口径（见脚本头注）。
  const r = spawnSync(
    'pnpm',
    ['--filter', '@gmind/server', 'exec', 'tsx', 'scripts/cleanup-e2e-data.ts', '--apply'],
    { stdio: 'inherit' },
  );
  if (r.error ?? r.status !== 0) {
    throw new Error(
      `[global-teardown] e2e 数据清理失败（exit ${r.status ?? r.error?.message}）——` +
        '开发库可能残留测试数据，请手工执行 pnpm --filter @gmind/server cleanup:e2e -- --apply',
    );
  }
}
