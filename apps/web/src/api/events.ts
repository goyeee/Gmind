import { apiPost } from './client';

/**
 * 前端埋点统一出口 — M5 Task 4（PRD 6.4 十一事件全清单）。
 *
 * track(type, payload, fileId?)：POST /api/events（M4 端点，204 无返回体——api() 对
 * 204 短路，token 由其附加）；fire-and-forget：失败静默（void + catch），遥测绝不
 * 干扰业务主流程。
 *
 * 公共参数（Global Constraints）：clientVersion（构建期由 vite define 注入的
 * package.json version）与 sessionId（sessionStorage `gmind.sid` 惰性生成——
 * crypto.randomUUID() 即满足唯一性需求，未引入 ULID 依赖）合并进 payload 对象
 * （服务端 payload 原样存储，公共参数与事件参数同居 payload 内；服务端不校验二者
 * 存在——客户端职责）。sessionId 生命周期 = 标签页会话（sessionStorage 关页即逝，
 * 同页跨文件共享同一会话 id）。
 */

/** vite define 注入（见 vite.config.ts）：构建期替换为 package.json 的 version。 */
declare const __APP_VERSION__: string;

const SESSION_KEY = 'gmind.sid';

/** 会话 id：sessionStorage 惰性生成（首次调用时写入，此后复用）。 */
function sessionId(): string {
  let sid = sessionStorage.getItem(SESSION_KEY);
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem(SESSION_KEY, sid);
  }
  return sid;
}

export type TrackPayload = Record<string, unknown>;

/** 上报一条埋点事件；fileId 缺省为 null（非文件上下文，如引导/全局性能采样）。 */
export function track(type: string, payload: TrackPayload, fileId?: string): void {
  try {
    void apiPost('/events', {
      type,
      fileId,
      payload: { ...payload, clientVersion: __APP_VERSION__, sessionId: sessionId() },
    }).catch(() => undefined);
  } catch {
    // fire-and-forget：组装阶段（如非浏览器环境缺 sessionStorage/__APP_VERSION__）
    // 同样静默——遥测任何形态的失败都不外溢
  }
}
