import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { FileCollaboratorEntity } from '../files/file-collaborator.entity';
import { FileEntity } from '../files/file.entity';
import { TaskIndexModule } from '../todos/task-index.module';
import { VersionEntity } from '../versions/version.entity';
import { CollabService } from './collab.service';

/**
 * 协同网关（M2 Task 1）：Hocuspocus 挂载到 Nest HTTP server 的 /collab 升级路由。
 * 不经 FilesModule（避免模块环），直接 forFeature 注入文件/协作者仓库；
 * SessionModule 为 @Global，SessionService 可直接注入。
 * 第二轮引入 EventsModule（任务动态声明盖章落库；EventsModule 无反向依赖，无环）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([FileEntity, FileCollaboratorEntity, VersionEntity]), TaskIndexModule, EventsModule],
  providers: [CollabService],
  exports: [CollabService],
})
export class CollabModule {}
