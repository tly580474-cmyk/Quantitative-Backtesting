import { canonicalHash, type ExperimentSpec } from './schema.js';

export const VALIDATION_CALCULATOR_VERSION = 'experiment-validation-1.0.0';
export const DEFAULT_VALIDATION_POLICY_VERSION = 'single-instrument-v1';

export interface ValidationPolicyConfig {
  minimumTotalReturn: number;
  maximumDrawdown: number;
  minimumTrades: number;
  maximumTrainTestDecay: number;
  perturbationMaximumDecay: number;
  requireLockedTest: boolean;
}

export const DEFAULT_VALIDATION_POLICY: ValidationPolicyConfig = {
  minimumTotalReturn: 0,
  maximumDrawdown: 0.35,
  minimumTrades: 1,
  maximumTrainTestDecay: 0.5,
  perturbationMaximumDecay: 0.5,
  requireLockedTest: true,
};

export interface SamplePlanConfig {
  trainRatio: number;
  validationRatio: number;
  lockedTestRatio: number;
  purgeBars: number;
  embargoBars: number;
  walkForwardFolds: number;
}

export const DEFAULT_SAMPLE_PLAN: SamplePlanConfig = {
  trainRatio: 0.6,
  validationRatio: 0.2,
  lockedTestRatio: 0.2,
  purgeBars: 1,
  embargoBars: 1,
  walkForwardFolds: 3,
};

export interface SampleRange {
  kind: 'train' | 'validation' | 'locked_test';
  startIndex: number;
  endIndex: number;
  startTime: string;
  endTime: string;
}

export interface WalkForwardFold {
  fold: number;
  train: SampleRange;
  validation: SampleRange;
  warmupEndIndex: number;
}

export function buildSampleIsolationPlan(
  times: string[],
  config: SamplePlanConfig = DEFAULT_SAMPLE_PLAN,
): { ranges: SampleRange[]; walkForward: WalkForwardFold[]; config: SamplePlanConfig } {
  if (times.length < 15) throw new Error('样本数量不足，至少需要 15 个交易日');
  const ratioSum = config.trainRatio + config.validationRatio + config.lockedTestRatio;
  if (Math.abs(ratioSum - 1) > 1e-9) throw new Error('训练、验证和锁定测试比例之和必须为 1');
  const trainEnd = Math.max(0, Math.floor(times.length * config.trainRatio) - 1);
  const validationStart = trainEnd + 1 + config.purgeBars;
  const validationEnd = Math.max(validationStart, Math.floor(times.length * (config.trainRatio + config.validationRatio)) - 1);
  const lockedStart = validationEnd + 1 + config.embargoBars;
  if (lockedStart >= times.length) throw new Error('purge/embargo 后锁定测试区间为空');
  const range = (kind: SampleRange['kind'], startIndex: number, endIndex: number): SampleRange => ({
    kind, startIndex, endIndex, startTime: times[startIndex], endTime: times[endIndex],
  });
  const ranges = [
    range('train', 0, trainEnd),
    range('validation', validationStart, validationEnd),
    range('locked_test', lockedStart, times.length - 1),
  ];
  const validationLength = validationEnd - validationStart + 1;
  const foldSize = Math.max(1, Math.floor(validationLength / config.walkForwardFolds));
  const walkForward = Array.from({ length: config.walkForwardFolds }, (_, index) => {
    const foldValidationStart = validationStart + index * foldSize;
    const foldValidationEnd = index === config.walkForwardFolds - 1
      ? validationEnd
      : Math.min(validationEnd, foldValidationStart + foldSize - 1);
    const foldTrainEnd = Math.max(0, foldValidationStart - config.purgeBars - 1);
    return {
      fold: index + 1,
      train: range('train', 0, foldTrainEnd),
      validation: range('validation', foldValidationStart, foldValidationEnd),
      warmupEndIndex: foldValidationStart - 1,
    };
  });
  return { ranges, walkForward, config };
}

export interface PerturbationCase {
  id: string;
  category: 'parameter' | 'cost' | 'date' | 'delay';
  patch: Record<string, unknown>;
}

export function buildPerturbationPlan(params: Record<string, unknown>): PerturbationCase[] {
  const cases: PerturbationCase[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) continue;
    for (const ratio of [-0.1, -0.05, 0.05, 0.1]) {
      cases.push({
        id: `parameter:${name}:${ratio > 0 ? '+' : ''}${ratio}`,
        category: 'parameter',
        patch: { strategyParams: { [name]: Number((value * (1 + ratio)).toPrecision(12)) } },
      });
    }
  }
  for (const multiplier of [2, 3]) {
    cases.push({ id: `cost:${multiplier}x`, category: 'cost', patch: { costMultiplier: multiplier } });
  }
  cases.push(
    { id: 'date:start:+5bars', category: 'date', patch: { startShiftBars: 5 } },
    { id: 'date:end:-5bars', category: 'date', patch: { endShiftBars: -5 } },
    { id: 'delay:+1bar', category: 'delay', patch: { executionDelayBars: 1 } },
  );
  return cases.slice(0, 24);
}

export interface ValidationCheck {
  id: string;
  category: 'data' | 'causality' | 'sample' | 'risk' | 'trading' | 'robustness' | 'governance';
  status: 'passed' | 'failed' | 'pending';
  message: string;
  sourcePath: string;
  value?: unknown;
  threshold?: unknown;
}

function walk(value: unknown, path: string, visitor: (value: unknown, path: string) => void): void {
  visitor(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`, visitor));
  else if (value && typeof value === 'object') {
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => walk(item, `${path}.${key}`, visitor));
  }
}

export function validateStaticCausality(spec: ExperimentSpec | unknown): ValidationCheck[] {
  const failures: ValidationCheck[] = [];
  const forbidden = /future|next(Open|Close|High|Low)|forward(Return|Price)|lookahead/i;
  walk(spec, '$.spec', (value, path) => {
    if (path.endsWith('.offset') && typeof value === 'number' && value > 0) {
      failures.push({ id: `positive-offset:${path}`, category: 'causality', status: 'failed', message: '引用了未来时刻数据', sourcePath: path, value, threshold: '<= 0' });
    }
    const key = path.split('.').at(-1) ?? '';
    const executableString = typeof value === 'string' && /\.(field|type|source)$/.test(path);
    if (forbidden.test(key) || (executableString && forbidden.test(value))) {
      failures.push({ id: `forbidden-future-reference:${path}`, category: 'causality', status: 'failed', message: '包含禁止的未来数据引用', sourcePath: path, value });
    }
  });
  if (failures.length > 0) return failures;
  return [{ id: 'static-causality', category: 'causality', status: 'passed', message: '未发现正向 offset 或未来数据引用', sourcePath: '$.spec' }];
}

export function validateDynamicCausality(
  signals: unknown,
  trades: unknown,
  startTime: string,
  endTime: string,
): ValidationCheck[] {
  const signalRows = Array.isArray(signals) ? signals as Array<Record<string, unknown>> : [];
  const tradeRows = Array.isArray(trades) ? trades as Array<Record<string, unknown>> : [];
  const outOfRange = [...signalRows, ...tradeRows].filter((row) => typeof row.time !== 'string' || row.time < startTime || row.time > endTime);
  const chronological = (rows: Array<Record<string, unknown>>) => rows.every((row, index) => index === 0 || String(rows[index - 1].time) <= String(row.time));
  const sameBarExecution = tradeRows.filter((trade) => signalRows.some((signal) => (
    signal.time === trade.time && signal.action === trade.side
  )));
  return [
    { id: 'timestamps-in-snapshot', category: 'data', status: outOfRange.length === 0 ? 'passed' : 'failed', message: outOfRange.length === 0 ? '信号和成交均位于快照区间' : '发现快照区间外记录', sourcePath: '$.result.signals|trades', value: outOfRange.length, threshold: 0 },
    { id: 'chronological-order', category: 'causality', status: chronological(signalRows) && chronological(tradeRows) ? 'passed' : 'failed', message: '信号和成交必须按时间递增', sourcePath: '$.result.signals|trades' },
    { id: 'no-same-bar-fill', category: 'causality', status: sameBarExecution.length === 0 ? 'passed' : 'failed', message: sameBarExecution.length === 0 ? '未发现当日收盘信号当日成交' : '发现同 bar 信号与成交', sourcePath: '$.result.signals|trades', value: sameBarExecution.length, threshold: 0 },
  ];
}

function finiteMetric(metrics: Record<string, unknown>, key: string): number | null {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function evaluateDeterministicGate(input: {
  metrics: Record<string, unknown>;
  lockedTestOpened: boolean;
  staticChecks: ValidationCheck[];
  dynamicChecks: ValidationCheck[];
  policy?: ValidationPolicyConfig;
  perturbationWorstDecay?: number | null;
  perturbationExpectedCases?: number;
  perturbationObservedCases?: number;
  sampleResults?: {
    train?: { totalReturn: number };
    validation?: { totalReturn: number };
    lockedTest?: { totalReturn: number };
    walkForward?: Array<{ totalReturn: number }>;
  };
  /**
   * screening：筛选层轻校验（ADR-05）。backtrader/向量引擎只做筛选，
   * 候选必须经权威复算后才能进入完整门禁。因此只校验链路正确性
   * （因果性、数据区间、不可变版本），不套用样本层与收益/风险门槛。
   */
  mode?: 'full' | 'screening';
}): { status: 'candidate' | 'rejected' | 'pending'; checks: ValidationCheck[]; evaluationHash: string } {
  const mode = input.mode ?? 'full';
  const policy = input.policy ?? DEFAULT_VALIDATION_POLICY;
  const totalReturn = finiteMetric(input.metrics, 'totalReturn');
  const maxDrawdown = finiteMetric(input.metrics, 'maxDrawdown');
  const tradeCount = finiteMetric(input.metrics, 'tradeCount');
  const trainReturn = input.sampleResults?.train?.totalReturn;
  const lockedReturn = input.sampleResults?.lockedTest?.totalReturn;
  const trainTestDecay = trainReturn !== undefined && lockedReturn !== undefined
    ? Math.abs(trainReturn) > 1e-12
      ? (trainReturn - lockedReturn) / Math.abs(trainReturn)
      : lockedReturn >= 0 ? 0 : Number.POSITIVE_INFINITY
    : null;
  const walkForward = input.sampleResults?.walkForward ?? [];
  const governanceCheck: ValidationCheck = { id: 'frozen-version', category: 'governance', status: 'passed', message: '运行绑定不可变实验版本', sourcePath: '$.run.experimentVersionId' };
  const checks: ValidationCheck[] = [
    ...input.staticChecks,
    ...input.dynamicChecks,
    ...(mode === 'screening'
      ? [governanceCheck]
      : ([
        { id: 'locked-test-opened', category: 'sample', status: !policy.requireLockedTest || input.lockedTestOpened ? 'passed' : 'pending', message: input.lockedTestOpened ? '锁定测试已原子开启' : '锁定测试尚未开启', sourcePath: '$.validationPlan.lockedTestStatus' },
        { id: 'locked-test-evaluated', category: 'sample', status: !policy.requireLockedTest || lockedReturn !== undefined ? 'passed' : 'pending', message: lockedReturn !== undefined ? '锁定测试区间已独立执行' : '锁定测试尚无独立结果', sourcePath: '$.sampleResults.lockedTest.totalReturn', value: lockedReturn },
        { id: 'locked-test-minimum-return', category: 'sample', status: lockedReturn === undefined ? 'pending' : lockedReturn >= policy.minimumTotalReturn ? 'passed' : 'failed', message: '锁定测试成本后收益门槛', sourcePath: '$.sampleResults.lockedTest.totalReturn', value: lockedReturn, threshold: policy.minimumTotalReturn },
        { id: 'train-test-decay', category: 'sample', status: trainTestDecay == null ? 'pending' : trainTestDecay <= policy.maximumTrainTestDecay ? 'passed' : 'failed', message: '锁定测试相对训练集收益衰减', sourcePath: '$.sampleResults', value: trainTestDecay, threshold: policy.maximumTrainTestDecay },
        { id: 'walk-forward-completed', category: 'sample', status: walkForward.length > 0 && walkForward.every((item) => Number.isFinite(item.totalReturn)) ? 'passed' : 'pending', message: 'Walk-forward 各折验证结果完整', sourcePath: '$.sampleResults.walkForward', value: walkForward.length },
        // null（如无交易时回撤不可用）= 不适用 → pending，而非 failed
        { id: 'minimum-total-return', category: 'trading', status: totalReturn === null ? 'pending' : totalReturn >= policy.minimumTotalReturn ? 'passed' : 'failed', message: '成本后总收益门槛', sourcePath: '$.result.metrics.totalReturn', value: totalReturn, threshold: policy.minimumTotalReturn },
        { id: 'maximum-drawdown', category: 'risk', status: maxDrawdown === null ? 'pending' : maxDrawdown <= policy.maximumDrawdown ? 'passed' : 'failed', message: '最大回撤门槛', sourcePath: '$.result.metrics.maxDrawdown', value: maxDrawdown, threshold: policy.maximumDrawdown },
        { id: 'minimum-trades', category: 'trading', status: tradeCount !== null && tradeCount >= policy.minimumTrades ? 'passed' : 'failed', message: '最少成交笔数门槛', sourcePath: '$.result.metrics.tradeCount', value: tradeCount, threshold: policy.minimumTrades },
        { id: 'perturbation-completeness', category: 'robustness', status: (input.perturbationExpectedCases ?? 0) > 0 && input.perturbationObservedCases === input.perturbationExpectedCases ? 'passed' : 'pending', message: '扰动矩阵结果完整', sourcePath: '$.perturbations', value: input.perturbationObservedCases ?? 0, threshold: input.perturbationExpectedCases ?? 0 },
        { id: 'perturbation-decay', category: 'robustness', status: input.perturbationWorstDecay == null || input.perturbationObservedCases !== input.perturbationExpectedCases ? 'pending' : input.perturbationWorstDecay <= policy.perturbationMaximumDecay ? 'passed' : 'failed', message: '参数、成本、日期和延迟扰动最差衰减', sourcePath: '$.perturbations.worstDecay', value: input.perturbationWorstDecay, threshold: policy.perturbationMaximumDecay },
        governanceCheck,
      ] as ValidationCheck[])),
  ];
  const status = checks.some((check) => check.status === 'failed')
    ? 'rejected'
    : checks.some((check) => check.status === 'pending') ? 'pending' : 'candidate';
  return { status, checks, evaluationHash: canonicalHash({ calculatorVersion: VALIDATION_CALCULATOR_VERSION, policy, checks }) };
}
