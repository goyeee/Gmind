import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// 本机 3000 端口被无关进程占用时，用 API_ORIGIN 指向实际后端（如 http://localhost:3001）。
// web 默认 5174，避开本机另一项目常用的 5173；仍可用 WEB_PORT 临时覆盖。
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';
const webPort = Number(process.env.WEB_PORT ?? 5174);

export default defineConfig({
  plugins: [react()],
  // 客户端版本号（M5 Task 4 埋点公共参数 clientVersion）：构建期以 package.json
  // version 静态替换（src/api/events.ts 消费），免运行时读取与 JSON 整体内联。
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: webPort,
    proxy: {
      '/api': apiOrigin,
      // 协同网关（M2 Task 1）：WS 升级路由随 REST 走同一后端（ws: true 必需，
      // 否则 /collab 升级请求不会被代理）
      '/collab': { target: apiOrigin, ws: true },
    },
  },
});
