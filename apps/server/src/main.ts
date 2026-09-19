import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { env } from './config/env';
import { ZodExceptionFilter } from './common/zod-exception.filter';
import { QuotaExceptionFilter } from './common/quota-exception.filter';
import { MulterExceptionFilter } from './storage/storage.multer.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: ['http://localhost:5173'], credentials: true });
  app.useGlobalFilters(new ZodExceptionFilter(), new QuotaExceptionFilter(), new MulterExceptionFilter());
  await app.listen(env.PORT);
  console.log(`[gmind-server] listening on :${env.PORT}`);
}

void bootstrap();
