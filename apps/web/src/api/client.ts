const TOKEN_KEY = 'gmind.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 带 HTTP 状态码的请求错误：调用方按状态分流（saveLoop 对 403 配额拒绝走非重试路径）。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  // 请求时刻的 token 快照：同一效果里常有多路并发（users/me + files + folders），
  // 首个 401 即清 token——若抛错时才读 localStorage，后续并发 401 会因 token 已清
  // 走不进「登录过期」分支、透出裸服务端 message
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token ?? ''}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    // 登录过期（NFR-USE-005）：带 token 的 401 是会话失效的确定性终态——清 token 并
    // 以固定「原因+下一步」文案抛出（服务端「未登录或会话已过期」缺下一步动作）；
    // 此后任意导航经 RequireAuth 落登录页。无 token 的 401（登录失败等）不受影响
    if (res.status === 401 && token) {
      clearToken();
      throw new ApiError('登录已过期，请重新登录', res.status);
    }
    throw new ApiError(data.message ?? `请求失败（${res.status}）`, res.status);
  }
  // 204 无响应体（M5 Task 1：POST /users/me/password、/users/me/rebind 成功 204）
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 语义化便捷封装（M3a Task 9）：PATCH/PUT/POST/DELETE 走同一鉴权与错误通道。 */
export const apiPost = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'POST', body });
export const apiPut = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'PATCH', body });
export const apiDel = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });
