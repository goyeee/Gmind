import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { DatabaseModule } from './database/database.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { SessionModule } from './session/session.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [DatabaseModule, SessionModule, UsersModule, FilesModule, AuthModule],
  controllers: [HealthController],
})
export class AppModule {}
