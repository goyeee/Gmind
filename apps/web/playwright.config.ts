import { defineConfig } from '@playwright/test';

// 默认与 vite.config.ts 一致使用 5174，避开本机另一项目常用的 5173；可用 WEB_PORT 覆盖。
// webServer 继承当前进程环境变量，vite.config.ts 会读到同一个 WEB_PORT / API_ORIGIN。
const webPort = process.env.WEB_PORT ?? '5174';
const baseURL = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  // 整套结束（含失败）后自动清理本轮测试数据（AGENTS 六.6）：调 server 判据化脚本，
  // 只删 e2e 判据命中的账号/文件/编号分组部门，不误伤真实账号；见 e2e/global-teardown.ts。
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 30000,
  use: {
    baseURL,
    // 三步新手引导（M5 Task 3）默认对所有上下文置「已完成」：引导是模态浮层，会阻塞
    // 既有用例在工作台页上的一切点击。需要引导本身的 guide.e2e.spec.ts 以空 storageState
    // 覆盖（test.use），从干净 localStorage 起测。
    storageState: {
      cookies: [],
      origins: [
        {
          origin: baseURL,
          localStorage: [{ name: 'gmind.guide.done', value: '1' }],
        },
      ],
    },
  },
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60000,
  },
  // 2026-11-13 稳定性裁定：默认 workers=cpu/2（本机 14 核=7 个）会让 ~28 路并发
  // 打满 dev API 的 DB 连接池（TypeORM 默认 10）+ 单实例 MySQL 5.6 + 单 vite，
  // 断言默认 5s 窗口随机饿死（负载相关偶发失败，失败集合逐轮漂移：193/9、195/5
  // 两轮仅 3 例重合，隔离重跑全过）。降到 4 worker + 失败重试 1 次。
  workers: 4,
  retries: 1,
});
