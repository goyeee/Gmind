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
  DEV_SMS_CODE: z.string().default('123456'),
});

export const env = envSchema.parse(process.env);
