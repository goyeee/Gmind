// vitest.e2e.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 60000,
    // 多个 e2e spec 共用 gmind_test 库，必须串行执行
    fileParallelism: false,
    // env.ts 在模块导入时解析，必须在任何 import 之前固定环境变量
    setupFiles: ['./test/support/env.setup.ts'],
    server: { deps: { inline: ['@gmind/shared', '@gmind/core'] } },
  },
});
