import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { QuotaExceptionFilter } from '../../src/common/quota-exception.filter';
import { ZodExceptionFilter } from '../../src/common/zod-exception.filter';
import { MulterExceptionFilter } from '../../src/storage/storage.multer.filter';
import { createDataSource } from '../../src/database/data-source';

/** e2e 统一装置：连 gmind_test 库 + Redis db1（环境变量由 vitest.e2e.config.ts 的 setupFiles 固定），
 *  跑迁移并清库，返回已初始化的 app。全局过滤器与 main.ts bootstrap 保持一致。 */
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
  app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter(), new MulterExceptionFilter());
  await app.init();
  return app;
}
