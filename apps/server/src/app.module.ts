import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { CollabModule } from './collab/collab.module';
import { CommentsModule } from './comments/comments.module';
import { DatabaseModule } from './database/database.module';
import { DevE2eModule } from './dev/dev-e2e.module';
import { EventsModule } from './events/events.module';
import { EventsQueryModule } from './events/events-query.module';
import { FilesModule } from './files/files.module';
import { FoldersModule } from './folders/folders.module';
import { HealthController } from './health/health.controller';
import { JobsModule } from './jobs/jobs.module';
import { NotifyModule } from './notify/notify.module';
import { SessionModule } from './session/session.module';
import { ShareModule } from './share/share.module';
import { StorageModule } from './storage/storage.module';
import { TrashModule } from './trash/trash.module';
import { UsersModule } from './users/users.module';
import { VersionsModule } from './versions/versions.module';

@Module({
  imports: [DatabaseModule, SessionModule, UsersModule, FilesModule, FoldersModule, AuthModule, StorageModule, CollabModule, CommentsModule, NotifyModule, TrashModule, JobsModule, ShareModule, VersionsModule, EventsModule, EventsQueryModule, DevE2eModule],
  controllers: [HealthController],
})
export class AppModule {}
