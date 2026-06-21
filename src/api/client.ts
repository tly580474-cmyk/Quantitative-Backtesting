import { API_BASE_URL } from './config';

export interface ApiErrorResponse {
  error: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const DEFAULT_TIMEOUT = 30000;

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const { timeoutMs, ...fetchOptions } = options;
  const url = `${API_BASE_URL}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    });

    if (!response.ok) {
      let body: ApiErrorResponse | null = null;
      try {
        body = await response.json();
      } catch {
        // Response is not JSON
      }
      throw new ApiError(
        body?.error ?? 'UNKNOWN',
        body?.message ?? `HTTP ${response.status}`,
        response.status,
        body?.details,
      );
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查后端服务是否运行', 0);
    }
    throw new ApiError('NETWORK_ERROR', '网络请求失败，请检查后端服务是否运行', 0);
  } finally {
    clearTimeout(timeout);
  }
}
