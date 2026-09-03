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
  const { timeoutMs, signal: externalSignal, ...fetchOptions } = options;
  const url = `${API_BASE_URL}${path}`;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (externalSignal?.aborted) {
    abortFromCaller();
  } else {
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs ?? DEFAULT_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...(fetchOptions.body != null && !(fetchOptions.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
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
    if (externalSignal?.aborted && !timedOut) {
      throw new ApiError('ABORTED', '请求已取消', 0);
    }
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '请求超时，请检查后端服务是否运行', 0);
    }
    throw new ApiError('NETWORK_ERROR', '网络请求失败，请检查后端服务是否运行', 0);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function apiFetchNdjson<T>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {},
  onEvent: (event: T) => void,
): Promise<void> {
  const { timeoutMs = DEFAULT_TIMEOUT, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abortFromCaller = () => controller.abort();
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  armTimeout();

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        Accept: 'application/x-ndjson',
        ...(fetchOptions.body != null && !(fetchOptions.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...fetchOptions.headers,
      },
    });
    if (!response.ok) {
      let body: ApiErrorResponse | null = null;
      try { body = await response.json(); } catch { /* Response is not JSON. */ }
      throw new ApiError(body?.error ?? 'UNKNOWN', body?.message ?? `HTTP ${response.status}`, response.status, body?.details);
    }
    if (!response.body) throw new ApiError('STREAM_UNAVAILABLE', '浏览器不支持流式响应', 0);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const emitLines = (final = false) => {
      const lines = buffer.split('\n');
      buffer = final ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        const value = line.trim();
        if (value) onEvent(JSON.parse(value) as T);
      }
      if (final && buffer.trim()) onEvent(JSON.parse(buffer.trim()) as T);
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armTimeout();
      buffer += decoder.decode(value, { stream: true });
      emitLines();
    }
    buffer += decoder.decode();
    emitLines(true);
  } catch (err) {
    if (externalSignal?.aborted && !timedOut) throw new ApiError('ABORTED', '请求已取消', 0);
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('TIMEOUT', '流式响应超时，请稍后重试', 0);
    }
    throw new ApiError('NETWORK_ERROR', '网络请求失败，请检查后端服务是否运行', 0);
  } finally {
    if (timeout) clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}
