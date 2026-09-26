import { defineConfig } from '@playwright/test';

// 本机 5173 被无关 vite 进程占用时，用 WEB_PORT 换端口（如 WEB_PORT=5174）。
// webServer 继承当前进程环境变量，vite.config.ts 会读到同一个 WEB_PORT / API_ORIGIN。
const webPort = process.env.WEB_PORT ?? '5173';
const baseURL = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './e2e',
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
});
