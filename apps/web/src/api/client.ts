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
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken() ?? ''}`,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    if (res.status === 401 && getToken()) clearToken();
    throw new ApiError(data.message ?? `请求失败（${res.status}）`, res.status);
  }
  return (await res.json()) as T;
}

/** 语义化便捷封装（M3a Task 9）：PATCH/PUT/POST/DELETE 走同一鉴权与错误通道。 */
export const apiPost = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'POST', body });
export const apiPut = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'PUT', body });
export const apiPatch = <T>(path: string, body?: unknown): Promise<T> => api<T>(path, { method: 'PATCH', body });
export const apiDel = <T>(path: string): Promise<T> => api<T>(path, { method: 'DELETE' });
