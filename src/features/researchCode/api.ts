import { apiFetch } from '@/api/client';

// 阶段 C：研究代码执行页 API 客户端。

export interface ResearchCodeRun {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'rejected';
  request: {
    protocolVersion: string;
    code: string;
    humanApprovalId: string;
    input?: unknown;
  };
  codeHash: string;
  result: unknown | null;
  resultHash: string | null;
  authority: string;
  publishable: boolean;
  capturedOutput: string | null;
  error: { type: string; message: string; traceback?: string } | null;
  maxSeconds: number | null;
  createdAt: string;
  completedAt: string | null;
}

export async function submitResearchCode(code: string): Promise<ResearchCodeRun> {
  const result = await apiFetch<{ run: ResearchCodeRun }>('/api/research-code/runs', {
    method: 'POST',
    body: JSON.stringify({ code }),
    timeoutMs: 150_000,
  });
  return result.run;
}

export async function listResearchCodeRuns(limit = 50): Promise<ResearchCodeRun[]> {
  const result = await apiFetch<{ runs: ResearchCodeRun[] }>(
    `/api/research-code/runs?limit=${limit}`,
  );
  return result.runs;
}

export async function getResearchCodeRun(id: string): Promise<ResearchCodeRun> {
  const result = await apiFetch<{ run: ResearchCodeRun }>(`/api/research-code/runs/${id}`);
  return result.run;
}

export function researchCodeStatusLabel(status: ResearchCodeRun['status']): string {
  return {
    queued: '排队中',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
    rejected: '已拒绝',
  }[status];
}

export function researchCodeStatusColor(status: ResearchCodeRun['status']): string {
  return {
    queued: 'default',
    running: 'processing',
    completed: 'success',
    failed: 'error',
    rejected: 'warning',
  }[status];
}
