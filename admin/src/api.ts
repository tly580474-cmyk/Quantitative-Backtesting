import type { AdminConfigItem, AdminHealth, AdminOverview, MetricsHistoryResponse } from './types';

const API_BASE_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:3001';

export class AdminApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function getAdminStatus(): Promise<{ enabled: boolean }> {
  return request('/api/admin/auth/status');
}

export async function verifyAdminToken(token: string): Promise<void> {
  await request('/api/admin/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  }, token);
}

export async function getAdminOverview(token: string): Promise<AdminOverview> {
  return request('/api/admin/overview', {}, token);
}

export async function getAdminHealth(token: string): Promise<AdminHealth> {
  return request('/api/admin/health', {}, token);
}

export async function getMetricsHistory(token: string, since?: string): Promise<MetricsHistoryResponse> {
  const query = since ? `?since=${encodeURIComponent(since)}` : '';
  return request(`/api/admin/metrics/history${query}`, {}, token);
}

export async function getAdminConfig(token: string): Promise<AdminConfigItem[]> {
  const response = await request<{ items: AdminConfigItem[] }>('/api/admin/config', {}, token);
  return response.items;
}

export async function updateAdminConfig(
  token: string,
  updates: Record<string, string>,
): Promise<{ updatedKeys: string[]; restartRequired: boolean; message: string }> {
  return request('/api/admin/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates }),
  }, token);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...options,
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch {
    throw new AdminApiError('无法连接后端服务，请确认 3001 端口上的服务正在运行', 0, 'NETWORK_ERROR');
  }

  const body = await response.json().catch(() => ({})) as {
    message?: string;
    error?: string;
  };
  if (!response.ok) {
    throw new AdminApiError(body.message ?? `请求失败（HTTP ${response.status}）`, response.status, body.error);
  }
  return body as T;
}
