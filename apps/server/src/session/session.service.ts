import { Injectable, Inject } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';

export const DAY = 24 * 60 * 60;
export const MAX_SESSIONS = 5;

export interface SessionData {
  userId: string;
  createdAt: number;
}

@Injectable()
export class SessionService {
  // tsx 不发射装饰器元数据，类 token 注入必须显式 @Inject（约定见任务说明）
  constructor(@Inject(Redis) private readonly redis: Redis) {}

  private sessKey(token: string): string {
    return `sess:${token}`;
  }

  private userKey(userId: string): string {
    return `user_sessions:${userId}`;
  }

  /** 会话有效期 7 天，记住我 30 天；超 5 端踢最早（FR-ACC-002）。 */
  async create(userId: string, rememberMe: boolean): Promise<{ token: string; expiresAt: number }> {
    const ttlSec = (rememberMe ? 30 : 7) * DAY;
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    await this.redis.set(this.sessKey(token), JSON.stringify({ userId, createdAt: now } satisfies SessionData), 'EX', ttlSec);
    const zkey = this.userKey(userId);
    await this.redis.zadd(zkey, String(now), token);
    await this.redis.expire(zkey, 30 * DAY);
    const count = await this.redis.zcard(zkey);
    if (count > MAX_SESSIONS) {
      const oldest = await this.redis.zrange(zkey, 0, count - MAX_SESSIONS - 1);
      for (const t of oldest) {
        await this.redis.del(this.sessKey(t));
        await this.redis.zrem(zkey, t);
      }
    }
    return { token, expiresAt: now + ttlSec * 1000 };
  }

  async validate(token: string): Promise<SessionData | null> {
    const raw = await this.redis.get(this.sessKey(token));
    return raw ? (JSON.parse(raw) as SessionData) : null;
  }

  async revoke(token: string): Promise<void> {
    const data = await this.validate(token);
    if (!data) return;
    await this.redis.del(this.sessKey(token));
    await this.redis.zrem(this.userKey(data.userId), token);
  }

  private ticketKey(ticket: string): string {
    return `ws_ticket:${ticket}`;
  }

  /** 一次性 WS/SSE 票据（2026-10-28 P0）：浏览器 WebSocket/EventSource 不允许自定义
   *  Authorization 头，原先 URL query 直接带长效 session token——代理/访问日志即泄露。
   *  改为 POST /auth/ws-ticket 换 60s 一次性 ticket（GETDEL 单次消费），URL 只带
   *  ticket：泄露窗口分钟级且用后即焚。Hocuspocus token 支持 ()=>Promise<string>，
   *  每次连接/重连换一张新票。 */
  async issueWsTicket(userId: string): Promise<{ ticket: string }> {
    const ticket = randomBytes(24).toString('hex');
    await this.redis.set(this.ticketKey(ticket), userId, 'EX', 60);
    return { ticket };
  }

  /** 消费一次性票据：GETDEL 原子取删（不存在/已用过/过期一律 null，fail-closed）。 */
  async consumeWsTicket(ticket: string): Promise<{ userId: string } | null> {
    if (!ticket) return null;
    const userId = await this.redis.getdel(this.ticketKey(ticket));
    return userId ? { userId } : null;
  }
}
