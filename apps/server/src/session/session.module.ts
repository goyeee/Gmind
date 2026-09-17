import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';
import { SessionService } from './session.service';

@Global()
@Module({
  providers: [
    { provide: Redis, useFactory: () => new Redis(env.REDIS_URL) },
    SessionService,
  ],
  exports: [SessionService, Redis],
})
export class SessionModule {}
