import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { EventEntity } from './event.entity';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

/**
 * 埋点事件域（M4 Task 7）。EventEntity 已在 database.module 注册（M0 init 建表，
 * 本任务首次接线），此处仅仓库接线。UsersModule 供 UserGuard 查用户（非 global，
 * 须显式引入）；VersionsModule 引入本模块以落 version_restore 事件（本模块不反向
 * 依赖任何业务域，无环）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventEntity]), UsersModule],
  providers: [EventsService],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
