import type { StoredMultiAssetRun } from './types';

export interface MultiAssetRunMetrics {
  endingEquity: number | null;
  totalReturn: number | null;
  cumulativeCosts: number | null;
  orderCount: number;
  rebalanceCount: number;
  positionCount: number;
}

export function deriveMultiAssetRunMetrics(run: StoredMultiAssetRun | null): MultiAssetRunMetrics {
  const ledger = run?.executionResult?.ledger ?? [];
  const last = ledger.length ? ledger[ledger.length - 1] : undefined;
  const endingEquity = last?.equity ?? null;
  return {
    endingEquity,
    totalReturn: endingEquity == null || !run || run.initialCash <= 0
      ? null
      : endingEquity / run.initialCash - 1,
    cumulativeCosts: last?.cumulativeCosts ?? null,
    orderCount: run?.executionResult?.orders.length ?? 0,
    rebalanceCount: run?.rebalancePlan?.decisions.length ?? 0,
    positionCount: last?.positions.length ?? 0,
  };
}

export function multiAssetStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    queued: '等待调度',
    recovered_after_restart: '重启后等待恢复',
    loading_snapshot: '读取只读快照',
    building_rebalance_plan: '生成并校验调仓计划',
    loading_execution_bars: '读取执行行情',
    executing_portfolio: '权威撮合与资金记账',
    completed: '运行完成',
    failed: '运行失败',
  };
  return labels[stage] ?? stage;
}
