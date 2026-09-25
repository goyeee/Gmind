import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { env } from './config/env';
import { ZodExceptionFilter } from './common/zod-exception.filter';
import { QuotaExceptionFilter } from './common/quota-exception.filter';
import { MulterExceptionFilter } from './storage/storage.multer.filter';
import { CollabService } from './collab/collab.service';
import { CleanupService } from './jobs/cleanup.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // doc-state PUT 携带全量 Yjs 状态（base64）：满额节点（MAX_DOC_NODES，@gmind/shared）docState(b64)≈110KB，
  // 超 Nest/Express 默认 100KB JSON 限制会 413（满额文档不可保存，perf T13 发现）。
  // 上限 2MB 远高于最大合法 docState，图片上传走 multipart（multer 10MB）不受此限。
  app.use(json({ limit: '2mb' }));
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter(), new MulterExceptionFilter());
  await app.listen(env.PORT);
  // 协同网关复用同一个 HTTP server：/collab 的 WebSocket upgrade 由 Hocuspocus 处理
  app.get(CollabService).attach(app.getHttpServer());
  // 回收站定时清理（M3a Task 7，FR-FIL-007/010）：每 24h 一轮（满 30 天 purge / 剩 3 天
  // 提醒，逻辑见 CleanupService.runCleanup）。unref() 使定时器不阻止进程退出；逐轮
  // catch 防单轮失败以 unhandled rejection 击穿进程。e2e 不经此路径（直调 runCleanup）。
  const cleanup = app.get(CleanupService);
  const cleanupTimer = setInterval(
    () => void cleanup.runCleanup(new Date()).catch((err: unknown) => console.error('[cleanup] run failed', err)),
    24 * 60 * 60 * 1000,
  );
  cleanupTimer.unref();
  console.log(`[gmind-server] listening on :${env.PORT} (collab at ${env.PORT}/collab)`);
}

void bootstrap();
