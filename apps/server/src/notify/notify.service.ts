import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import type { Response } from 'express';
import { NotificationEntity, type NotificationType } from '../notifications/notification.entity';

/** SSE 推送事件（binding 形状）：payload 为已解析对象（与 GET /api/notifications 条目同形）。 */
export interface NotifySseEvent {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

/** 通知中心条目（GET /api/notifications）。 */
export interface NotificationView {
  id: string;
  type: NotificationType;
  payload: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** 列表条数上限（binding：ORDER BY created_at DESC LIMIT 50）。 */
const LIST_LIMIT = 50;
/** SSE 心跳间隔：30s 一条注释帧，防止中间层空闲超时断链（binding）。 */
const HEARTBEAT_MS = 30_000;

/**
 * 站内通知域（M3b Task 8，FR-CMT-005）：通知落库 + SSE 实时推送 + 通知中心查询。
 *
 * 推送拓扑（单实例内存注册表，binding 裁定）：Map<userId, Set<Response>>——评论触发
 * notify() 后向该用户全部活跃连接写 `data: {JSON}` 帧；多实例部署需换 Redis pub/sub，
 * 一期单实例不做。连接关闭（res close）即摘除并清心跳；进程关停
 * onApplicationShutdown 统一 end 全部连接（e2e app.close() 不因长连接挂起）。
 */
@Injectable()
export class NotifyService implements OnApplicationShutdown {
  private readonly logger = new Logger(NotifyService.name);
  private readonly connections = new Map<string, Set<Response>>();
  private readonly heartbeats = new WeakMap<Response, ReturnType<typeof setInterval>>();

  constructor(@InjectRepository(NotificationEntity) private readonly repo: Repository<NotificationEntity>) {}

  /** 通知写入 + 推送：INSERT notifications 行（payload 存 JSON 文本）→ SSE 推全部连接。 */
  async notify(userId: string, type: NotificationType, payload: Record<string, unknown>): Promise<void> {
    const row = this.repo.create();
    row.userId = userId;
    row.type = type;
    row.payload = JSON.stringify(payload);
    const saved = await this.repo.save(row);
    this.push(userId, { id: saved.id, type: saved.type, payload, createdAt: saved.createdAt.toISOString() });
  }

  /** 注册 SSE 连接（controller 已完成鉴权与响应头写入）：进入注册表 + 心跳保活。 */
  registerConnection(userId: string, res: Response): void {
    const set = this.connections.get(userId) ?? new Set<Response>();
    set.add(res);
    this.connections.set(userId, set);
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, HEARTBEAT_MS);
    // 心跳不阻止进程退出（关停路径走 onApplicationShutdown 统一清理）
    heartbeat.unref();
    this.heartbeats.set(res, heartbeat);
    res.on('close', () => this.unregister(userId, res));
  }

  /** 进程关停：结束全部 SSE 连接并清心跳（否则 httpServer.close 等长连接，app.close 挂起）。 */
  onApplicationShutdown(): void {
    for (const [userId, set] of this.connections) {
      for (const res of set) {
        this.unregister(userId, res);
        res.end();
      }
    }
    this.connections.clear();
  }

  /** GET /api/notifications：本人最近 50 条，created_at DESC（binding）。 */
  async list(userId: string): Promise<NotificationView[]> {
    const rows = await this.repo.find({ where: { userId }, order: { createdAt: 'DESC' }, take: LIST_LIMIT });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: this.parsePayload(r.payload),
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** POST /api/notifications/:id/read：read_at=now（仅本人行；重复已读幂等）。 */
  async markRead(userId: string, id: string): Promise<{ ok: true }> {
    await this.repo.update({ id, userId }, { readAt: new Date() });
    return { ok: true };
  }

  /** GET /api/notifications/unread-count。 */
  async unreadCount(userId: string): Promise<{ count: number }> {
    return { count: await this.repo.countBy({ userId, readAt: IsNull() }) };
  }

  // ---- 内部 ---------------------------------------------------------------

  private unregister(userId: string, res: Response): void {
    const heartbeat = this.heartbeats.get(res);
    if (heartbeat) {
      clearInterval(heartbeat);
      this.heartbeats.delete(res);
    }
    const set = this.connections.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.connections.delete(userId);
  }

  private push(userId: string, event: NotifySseEvent): void {
    const set = this.connections.get(userId);
    if (!set || set.size === 0) return; // 无人在线为 no-op：拉取端打开工作台时自会读列表
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      try {
        res.write(frame);
      } catch (e) {
        this.logger.warn(`SSE write 失败（连接将被 close 回调摘除）：${String(e)}`);
      }
    }
  }

  /** payload 反序列化容错（同 comments.toView 口径：坏 JSON 不炸接口）。 */
  private parsePayload(raw: string | null): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
}
