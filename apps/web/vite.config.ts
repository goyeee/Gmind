import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 本机 3000 端口被无关进程占用时，用 API_ORIGIN 指向实际后端（如 http://localhost:3001）。
// 本机 5173 端口被无关 vite 进程占用时，用 WEB_PORT 换端口（如 5174）。
const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:3000';
const webPort = Number(process.env.WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react()],
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
