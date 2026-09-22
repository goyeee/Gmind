import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import { AppModule } from '../../src/app.module';
import { QuotaExceptionFilter } from '../../src/common/quota-exception.filter';
import { ZodExceptionFilter } from '../../src/common/zod-exception.filter';
import { MulterExceptionFilter } from '../../src/storage/storage.multer.filter';
import { createDataSource } from '../../src/database/data-source';

/** e2e 统一装置：连 gmind_test 库 + Redis db1（环境变量由 vitest.e2e.config.ts 的 setupFiles 固定），
 *  跑迁移并清库，返回已初始化的 app。全局过滤器与 body 限宽均与 main.ts bootstrap 保持一致
 *  （json 2mb：满额 docState(b64)≈110KB 超默认 100KB，600 节点级配额用例必须走与线上一致的限宽）。 */
export async function createTestApp(): Promise<INestApplication> {
  const setup = createDataSource('gmind_test');
  await setup.initialize();
  await setup.runMigrations();
  for (const t of ['versions', 'events', 'notifications', 'comments', 'invites', 'share_links', 'file_stars', 'file_collaborators', 'files', 'folders', 'users']) {
    await setup.query(`DELETE FROM ${t}`);
  }
  await setup.destroy();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(json({ limit: '2mb' }));
  app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter(), new MulterExceptionFilter());
  await app.init();
  return app;
}
