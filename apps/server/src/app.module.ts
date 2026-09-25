import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CollabModule } from './collab/collab.module';
import { DatabaseModule } from './database/database.module';
import { DevE2eModule } from './dev/dev-e2e.module';
import { FilesModule } from './files/files.module';
import { FoldersModule } from './folders/folders.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { SessionModule } from './session/session.module';
import { StorageModule } from './storage/storage.module';
import { TrashModule } from './trash/trash.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [DatabaseModule, SessionModule, UsersModule, FilesModule, FoldersModule, AuthModule, StorageModule, CollabModule, TrashModule, JobsModule, DevE2eModule],
  controllers: [HealthController],
})
export class AppModule {}
