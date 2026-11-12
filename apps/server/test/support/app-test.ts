import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import Redis from 'ioredis';
import { AppModule } from '../../src/app.module';
import { CollabService } from '../../src/collab/collab.service';
import { QuotaExceptionFilter } from '../../src/common/quota-exception.filter';
import { ZodExceptionFilter } from '../../src/common/zod-exception.filter';
import { MulterExceptionFilter } from '../../src/storage/storage.multer.filter';
import { createDataSource } from '../../src/database/data-source';

/** e2e 统一装置：连 gmind_test 库 + Redis db1（环境变量由 vitest.e2e.config.ts 的 setupFiles 固定），
 *  跑迁移并清库，返回已初始化的 app。全局过滤器与 body 限宽均与 main.ts bootstrap 保持一致
 *  （json 2mb：满额 docState(b64)≈110KB 超默认 100KB，600 节点级配额用例必须走与线上一致的限宽）。
 *  协同网关同样与 main.ts 平价：挂在 app 自己的 HTTP server 上（WS 用例自行 listen(0)）。 */
export async function createTestApp(): Promise<INestApplication> {
  const setup = createDataSource('gmind_test');
  await setup.initialize();
  await setup.runMigrations();
  for (const t of ['versions', 'events', 'notifications', 'comments', 'invites', 'share_links', 'file_stars', 'file_collaborators', 'files', 'folders', 'users']) {
    await setup.query(`DELETE FROM ${t}`);
  }
  await setup.destroy();

  // Redis db1 同步清场（2026-11-12 邮箱注册制，Task 5）：email_code/email_code_wait/
  // email_code_fail 键（60s 重发冷却）与旧会话残留在 MySQL 清库后仍存活——固定邮箱
  // （如 trash711@test.dev）一分钟内重跑同 spec 会撞 429。串行执行下先 flush 再建号，
  // 清掉的本文件会话在后续 beforeAll 里重建，语义安全。
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:16379/1', { lazyConnect: true });
  try {
    await redis.connect();
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(json({ limit: '2mb' }));
  app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter(), new MulterExceptionFilter());
  await app.init();
  app.get(CollabService).attach(app.getHttpServer());
  return app;
}
