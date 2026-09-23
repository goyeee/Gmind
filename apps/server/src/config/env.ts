import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().default(33061),
  DB_USER: z.string().default('root'),
  DB_PASSWORD: z.string().default('gminddev'),
  DB_DATABASE: z.string().default('gmind'),
  REDIS_URL: z.string().default('redis://127.0.0.1:63790/0'),
  // 本地磁盘图片存储根目录（一期 Provider；根 .gitignore 已忽略 .data/）
  STORAGE_DIR: z.string().default('./.data/storage'),
  DEV_SMS_CODE: z.string().default('123456'),
  // 协同网关（M2 Task 1）：onStoreDocument 防抖窗口与最长强制落库间隔（ms）。
  // 默认与 Hocuspocus 内置一致（2000/10000）；e2e 压低以加速回写断言。
  COLLAB_DEBOUNCE_MS: z.coerce.number().default(2000),
  COLLAB_MAX_DEBOUNCE_MS: z.coerce.number().default(10000),
});

export const env = envSchema.parse(process.env);
