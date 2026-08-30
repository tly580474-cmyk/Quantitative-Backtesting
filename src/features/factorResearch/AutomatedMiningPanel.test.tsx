import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App as AntApp } from 'antd';
import AutomatedMiningPanel from './AutomatedMiningPanel';
import { MOBILE_LAYOUT_QUERY } from '@/components/mobile/useMobileLayout';

const apiMocks = vi.hoisted(() => ({
  approveFactorCandidate: vi.fn(),
  archiveMiningTask: vi.fn(),
  cancelMiningTask: vi.fn(),
  createMiningTask: vi.fn(),
  deleteMiningTask: vi.fn(),
  fetchFactorCandidates: vi.fn(),
  fetchFactorCandidateAutomation: vi.fn(),
  fetchMiningTasks: vi.fn(),
  freezeFactorCandidate: vi.fn(),
  publishFactorCandidate: vi.fn(),
  rejectFactorCandidate: vi.fn(),
  startMiningTask: vi.fn(),
  testFactorCandidate: vi.fn(),
  fetchMiningTaskTrace: vi.fn(),
  createMiningSchedule: vi.fn(),
  updateFactorCandidateAutomation: vi.fn(),
}));

vi.mock('./api', () => apiMocks);

const task = {
  id: 'task-00000001',
  status: 'completed' as const,
  snapshotId: 'snapshot-1',
  config: {},
  totalGenerations: 10,
  completedGenerations: 10,
  createdAt: '2026-08-30T00:00:00.000Z',
};

const candidate = {
  id: 'candidate-1',
  taskId: task.id,
  name: '候选一',
  formula: 'momentum(close,20)',
  expression: { type: 'ast' as const, version: 1 as const, root: {} },
  direction: 'higher-is-better' as const,
  dependencies: ['close'],
  warmupDays: 20,
  status: 'tested' as const,
  validationMetrics: { test_rankic: 0.1, complexity_nodes: 4 },
  lockedTestMetrics: { averageRankIc: 0.08, portfolio: { stressedCostSharpe: 1.2 } },
  sourceLineage: { splits: { test: { start: '2026-01-01', end: '2026-06-30' } } },
  updatedAt: '2026-08-30T00:00:00.000Z',
};

beforeEach(() => {
  let seed = 1;
  vi.stubGlobal('crypto', { getRandomValues: (buffer: Uint32Array) => {
    buffer[0] = seed++;
    return buffer;
  } });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_LAYOUT_QUERY, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  apiMocks.fetchMiningTasks.mockResolvedValue({ items: [task] });
  apiMocks.fetchFactorCandidates.mockResolvedValue({ items: [candidate] });
  apiMocks.fetchFactorCandidateAutomation.mockResolvedValue({ setting: { id: 'setting-1', enabled: 0, updatedAt: '' } });
  apiMocks.fetchMiningTaskTrace.mockResolvedValue({ items: [] });
  apiMocks.approveFactorCandidate.mockResolvedValue({ candidate: { ...candidate, status: 'approved' } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AutomatedMiningPanel mobile approval', () => {
  it('opens the approval modal from the mobile candidate card and submits the reviewer', async () => {
    render(<AntApp><AutomatedMiningPanel /></AntApp>);

    fireEvent.click(await screen.findByRole('tab', { name: '候选 (1)' }));
    fireEvent.click(await screen.findByRole('button', { name: '提交批准' }));

    expect(await screen.findByRole('dialog', { name: '人工批准' })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '审批人' }), { target: { value: 'reviewer' } });
    fireEvent.click(screen.getByRole('button', { name: '确认批准' }));

    await waitFor(() => expect(apiMocks.approveFactorCandidate).toHaveBeenCalledWith('candidate-1', 'reviewer'));
  });
});
