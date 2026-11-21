import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsModule } from '../events/events.module';
import { NodeIndexEntity } from './node-index.entity';
import { TaskIndexEntity } from './task-index.entity';
import { TaskParticipantEntity } from './task-participant.entity';
import { TaskIndexService } from './task-index.service';

/**
 * 任务索引叶子模块（第二期批次 B；第二轮引入 EventsModule）：
 * 实体仓库 + 重建服务 + EventsService（自动父派生变化补记动态事件）。
 * EventsModule 不反向依赖本模块（→UsersModule 止），引入无环；
 * CollabModule/FilesModule（落库钩子）与 TodosModule（查询/直写）都可安全引入。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaskIndexEntity, NodeIndexEntity, TaskParticipantEntity]), EventsModule],
  providers: [TaskIndexService],
  exports: [TaskIndexService],
})
export class TaskIndexModule {}
