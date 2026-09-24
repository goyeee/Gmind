import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 仅 src/ 单测（纯函数）；e2e/ 归 playwright 管辖，不得被 vitest 拾取
    include: ['src/**/*.test.ts'],
  },
});
