import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NodeIndexEntity } from './node-index.entity';
import { TaskIndexEntity } from './task-index.entity';
import { TaskIndexService } from './task-index.service';

/**
 * 任务索引叶子模块（第二期批次 B）：仅实体仓库 + 重建服务，无其他依赖——
 * CollabModule/FilesModule（落库钩子）与 TodosModule（查询/直写）都可安全引入，无环。
 * NodeIndexEntity（2026-10-28 P1 全文搜索）随同事务重建通道一并注册。
 */
@Module({
  imports: [TypeOrmModule.forFeature([TaskIndexEntity, NodeIndexEntity])],
  providers: [TaskIndexService],
  exports: [TaskIndexService],
})
export class TaskIndexModule {}
