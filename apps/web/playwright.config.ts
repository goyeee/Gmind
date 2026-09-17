import { defineConfig } from '@playwright/test';

// 本机 5173 被无关 vite 进程占用时，用 WEB_PORT 换端口（如 WEB_PORT=5174）。
// webServer 继承当前进程环境变量，vite.config.ts 会读到同一个 WEB_PORT / API_ORIGIN。
const webPort = process.env.WEB_PORT ?? '5173';
const baseURL = `http://localhost:${webPort}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: { baseURL },
  webServer: {
    command: 'pnpm dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
