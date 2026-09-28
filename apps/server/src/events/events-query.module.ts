import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { UserEntity } from '../users/user.entity';
import { EventEntity } from './event.entity';
import { EventsQueryController } from './events-query.controller';
import { EventsQueryService } from './events-query.service';

/**
 * 文档动态读侧模块（M6 Task 8，企微对标，FR-COL-007 提前）。
 *
 * 为什么不并入 EventsModule：FilesModule 已引入 EventsModule（doc_create 埋点），
 * 若 EventsModule 反向引入 FilesModule（findAliveOr404）即成模块环；读侧独立成
 * 本模块挂到 app.module（storage-core/storage 同域双模块先例），依赖单向：
 * EventsQueryModule → FilesModule → EventsModule，无环。
 *
 * - UsersModule：UserGuard 查用户（非 global，须显式引入）；
 * - FilesModule：findAliveOr404 单点提供「存活 + canAccess」（404 口径）；
 * - EventEntity（events 表读取）+ UserEntity（userName 的 nickname JOIN）。
 */
@Module({
  imports: [TypeOrmModule.forFeature([EventEntity, UserEntity]), UsersModule, FilesModule],
  providers: [EventsQueryService],
  controllers: [EventsQueryController],
})
export class EventsQueryModule {}
