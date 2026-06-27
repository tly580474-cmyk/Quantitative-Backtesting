import type { BacktestResult } from '@/models';

export function inferResultStrategyName(result: BacktestResult): string {
  if (result.config.backtestMode === 'dca' || result.strategyId === 'dca') {
    return '定投策略';
  }

  const parts = result.name.split(' - ');
  if (parts.length >= 3) {
    const embeddedName = parts.slice(1, -1).join(' - ').trim();
    if (embeddedName) return embeddedName;
  }

  return result.strategyId;
}

export function getResultStrategyName(
  result: BacktestResult,
  strategyNames: Readonly<Record<string, string>>,
): string {
  return strategyNames[result.strategyId] ?? inferResultStrategyName(result);
}
