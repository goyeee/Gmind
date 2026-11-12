import { Module } from '@nestjs/common';
import { CollabModule } from '../collab/collab.module';
import { FilesModule } from '../files/files.module';
import { NotifyModule } from '../notify/notify.module';
import { OrgModule } from '../org/org.module';
import { UsersModule } from '../users/users.module';
import { TaskIndexEntity } from './task-index.entity';
import { TaskIndexModule } from './task-index.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

/**
 * 跨文件待办模块（第二期批次 B/C）：TaskIndexService 另导出给 Collab/Files 落库钩子。
 * 依赖均无环：Collab/Files/Org/Notify 各自独立导出服务；UsersModule 供 UserGuard 依赖解析
 * （同 admin/org.module 先例）。
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TaskIndexEntity]),
    TaskIndexModule,
    CollabModule,
    FilesModule,
    OrgModule,
    NotifyModule,
    UsersModule,
  ],
  controllers: [TodosController],
  providers: [TodosService],
})
export class TodosModule {}
