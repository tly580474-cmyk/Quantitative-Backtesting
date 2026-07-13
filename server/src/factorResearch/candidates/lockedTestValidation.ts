export const MIN_LOCKED_TEST_SAMPLES = 1000;
export const MIN_LOCKED_TEST_TRADING_DAYS = 60;

interface LockedTestRequest {
  startDate: string;
  endDate: string;
}

export function assertLockedTestLineage(
  sourceLineage: unknown,
  request: LockedTestRequest,
): void {
  const lineage = asRecord(sourceLineage);
  const splits = asRecord(lineage.splits);
  const test = asRecord(splits.test);
  const start = typeof test.start === 'string' ? test.start : '';
  const end = typeof test.end === 'string' ? test.end : '';
  if (!start || !end) throw new Error('候选血缘中缺少锁定测试区间');
  if (request.startDate !== start || request.endDate !== end) {
    throw new Error(`锁定测试区间必须与候选冻结血缘一致（${start} 至 ${end}）`);
  }
  const rows = finite(test.rows);
  if (rows !== null && rows < MIN_LOCKED_TEST_SAMPLES) {
    throw new Error(`锁定测试血缘样本仅 ${rows} 行，不足 ${MIN_LOCKED_TEST_SAMPLES} 行，请等待更多新交易日`);
  }
  const calendarDays = inclusiveCalendarDays(start, end);
  if (calendarDays < MIN_LOCKED_TEST_TRADING_DAYS) {
    throw new Error(`锁定测试区间仅 ${calendarDays} 个自然日，不可能满足 ${MIN_LOCKED_TEST_TRADING_DAYS} 个交易日`);
  }
}

export function assertLockedTestCoverage(metrics: unknown): void {
  const value = asRecord(metrics);
  const sampleCount = finite(value.sampleCount);
  const tradingDays = finite(value.tradingDays);
  if (sampleCount === null || sampleCount < MIN_LOCKED_TEST_SAMPLES) {
    throw new Error(`锁定测试实际样本数不足 ${MIN_LOCKED_TEST_SAMPLES}（实际 ${sampleCount ?? 0}）`);
  }
  if (tradingDays === null || tradingDays < MIN_LOCKED_TEST_TRADING_DAYS) {
    throw new Error(`锁定测试实际交易日不足 ${MIN_LOCKED_TEST_TRADING_DAYS}（实际 ${tradingDays ?? 0}）`);
  }
}

export function hasMinimumLockedTestCalendarSpan(priorEndDate: string, currentEndDate: string): boolean {
  return inclusiveCalendarDays(nextDay(priorEndDate), currentEndDate) >= MIN_LOCKED_TEST_TRADING_DAYS;
}

function nextDay(date: string): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function inclusiveCalendarDays(start: string, end: string): number {
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 0;
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
