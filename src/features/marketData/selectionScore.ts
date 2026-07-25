import type { KlinePoint } from './types';

export type SelectionScoreTier = 'core' | 'watch' | 'weak' | 'blocked';

export interface SelectionScoreItem {
  label: string;
  points: number;
  matched: boolean;
  detail: string;
  kind: 'bonus' | 'penalty';
}

export interface SelectionScoreSection {
  key: string;
  title: string;
  score: number;
  maxScore: number | null;
  items: SelectionScoreItem[];
}

export interface SelectionScoreResult {
  status: 'ready' | 'insufficient';
  score: number | null;
  tier: SelectionScoreTier | null;
  tierLabel: string;
  tierDescription: string;
  rawPositiveScore: number;
  normalizedBaseScore: number;
  riskDeduction: number;
  forcedCooling: boolean;
  sections: SelectionScoreSection[];
  asOf: string | null;
  inputSampleSize: number;
  sampleSize: number;
  message?: string;
  assumptions: string[];
}

type FactorDirection = 'higher' | 'lower';
type FactorSection = 'volume' | 'trend' | 'momentum' | 'pattern' | 'liquidity';

interface FactorDefinition {
  id: string;
  label: string;
  section: FactorSection;
  rankIcIr: number;
  direction: FactorDirection;
  warmup: number;
  format: (value: number) => string;
  calculate: (candles: KlinePoint[], endIndex: number) => number | null;
}

interface ScoredFactor {
  definition: FactorDefinition;
  value: number;
  percentileScore: number;
  normalizedWeight: number;
  contribution: number;
  observations: number;
}

const MIN_CANDLES = 65;
const MIN_FACTOR_OBSERVATIONS = 20;
const FACTOR_HISTORY_WINDOW = 252;
const LIQUIDITY_FLOOR_YUAN = 10_000_000;

const TIER_META: Record<SelectionScoreTier, { label: string; description: string }> = {
  core: {
    label: '核心优选',
    description: '反转复合分位位于前 20%，建议纳入 10 个交易日持有候选。',
  },
  watch: {
    label: '持有观察',
    description: '反转复合分位位于 60–80%，可继续观察或持有，避免追涨换手。',
  },
  weak: {
    label: '中性观察',
    description: '反转复合信号居中，暂不作为新增仓位的优先候选。',
  },
  blocked: {
    label: '回避冷却',
    description: '反转复合分位偏低，建议回避并在约 10 个交易日后重新评分。',
  },
};

const SECTION_META: Record<FactorSection, { title: string; order: number }> = {
  volume: { title: '量能反转', order: 1 },
  trend: { title: '趋势反转', order: 2 },
  momentum: { title: '动量与振荡反转', order: 3 },
  pattern: { title: '波幅形态', order: 4 },
  liquidity: { title: '换手率', order: 5 },
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percent(value: number): string {
  return `${round(value * 100)}%`;
}

function ratio(value: number): string {
  return `${round(value, 3)} 倍`;
}

function smaAt(candles: KlinePoint[], period: number, endIndex: number): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return average(candles.slice(start, endIndex + 1).map((item) => item.close));
}

function uniqueByDate<T extends { date: string }>(items: T[]): T[] {
  return items.filter((item, index) => index === 0 || item.date !== items[index - 1].date);
}

function rsiAt(candles: KlinePoint[], endIndex: number, period = 14): number | null {
  if (endIndex < period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  return 100 - 100 / (1 + gains / losses);
}

const FACTORS: FactorDefinition[] = [
  {
    id: 'breakout_20d',
    label: '20 日突破强度',
    section: 'volume',
    rankIcIr: 8.64,
    direction: 'lower',
    warmup: 21,
    format: percent,
    calculate: (candles, endIndex) => {
      if (endIndex < 20) return null;
      const previousHigh = Math.max(...candles.slice(endIndex - 20, endIndex).map((item) => item.high));
      return previousHigh > 0 ? candles[endIndex].close / previousHigh - 1 : null;
    },
  },
  {
    id: 'amount_20d_avg',
    label: '3 日 / 20 日均量比',
    section: 'volume',
    rankIcIr: 7.03,
    direction: 'lower',
    warmup: 20,
    format: ratio,
    calculate: (candles, endIndex) => {
      if (endIndex < 19) return null;
      const average3 = average(candles.slice(endIndex - 2, endIndex + 1).map((item) => item.volume));
      const average20 = average(candles.slice(endIndex - 19, endIndex + 1).map((item) => item.volume));
      return average20 > 0 ? average3 / average20 : null;
    },
  },
  {
    id: 'turnover_rate',
    label: '换手率',
    section: 'liquidity',
    rankIcIr: 5.85,
    direction: 'lower',
    warmup: 1,
    format: (value) => `${round(value, 2)}%`,
    calculate: (candles, endIndex) => {
      const value = candles[endIndex].turnoverRatePct;
      return value != null && Number.isFinite(value) && value >= 0 ? value : null;
    },
  },
  {
    id: 'rsi_14',
    label: 'RSI(14)',
    section: 'momentum',
    rankIcIr: 5.14,
    direction: 'lower',
    warmup: 15,
    format: (value) => round(value, 1).toString(),
    calculate: (candles, endIndex) => rsiAt(candles, endIndex),
  },
  {
    id: 'return_20d',
    label: '20 日收益率',
    section: 'momentum',
    rankIcIr: 5.10,
    direction: 'lower',
    warmup: 21,
    format: percent,
    calculate: (candles, endIndex) => {
      if (endIndex < 20) return null;
      const start = candles[endIndex - 20].close;
      return start > 0 ? candles[endIndex].close / start - 1 : null;
    },
  },
  {
    id: 'contraction',
    label: '近 5 日 / 前 15 日波幅比',
    section: 'pattern',
    rankIcIr: 4.77,
    direction: 'higher',
    warmup: 20,
    format: ratio,
    calculate: (candles, endIndex) => {
      if (endIndex < 19) return null;
      const previous = candles.slice(endIndex - 19, endIndex - 4);
      const recent = candles.slice(endIndex - 4, endIndex + 1);
      const previousRange = Math.max(...previous.map((item) => item.high))
        - Math.min(...previous.map((item) => item.low));
      const recentRange = Math.max(...recent.map((item) => item.high))
        - Math.min(...recent.map((item) => item.low));
      return previousRange > 0 ? recentRange / previousRange : null;
    },
  },
  {
    id: 'volume_ratio',
    label: '当日量比',
    section: 'volume',
    rankIcIr: 4.73,
    direction: 'lower',
    warmup: 21,
    format: ratio,
    calculate: (candles, endIndex) => {
      if (endIndex < 20) return null;
      const average20 = average(candles.slice(endIndex - 20, endIndex).map((item) => item.volume));
      return average20 > 0 ? candles[endIndex].volume / average20 : null;
    },
  },
  {
    id: 'ma60_slope_5d',
    label: 'MA60 5 日斜率',
    section: 'trend',
    rankIcIr: 4.51,
    direction: 'lower',
    warmup: 65,
    format: percent,
    calculate: (candles, endIndex) => {
      if (endIndex < 64) return null;
      const current = smaAt(candles, 60, endIndex);
      const previous = smaAt(candles, 60, endIndex - 5);
      return current != null && previous != null && previous > 0 ? current / previous - 1 : null;
    },
  },
  {
    id: 'price_above_ma20',
    label: '价格相对 MA20 距离',
    section: 'trend',
    rankIcIr: 4.48,
    direction: 'lower',
    warmup: 20,
    format: percent,
    calculate: (candles, endIndex) => {
      const ma20 = smaAt(candles, 20, endIndex);
      return ma20 != null && ma20 > 0 ? candles[endIndex].close / ma20 - 1 : null;
    },
  },
];

function percentileScore(
  values: number[],
  latestValue: number,
  direction: FactorDirection,
): number {
  const lower = values.filter((value) => value < latestValue).length;
  const equal = values.filter((value) => value === latestValue).length;
  const rawPercentile = (lower + equal * 0.5) / values.length;
  return clamp((direction === 'higher' ? rawPercentile : 1 - rawPercentile) * 100, 0, 100);
}

function scoreFactors(candles: KlinePoint[]): ScoredFactor[] {
  const latestIndex = candles.length - 1;
  const available = FACTORS.flatMap((definition) => {
    const latestValue = definition.calculate(candles, latestIndex);
    if (latestValue == null || !Number.isFinite(latestValue)) return [];
    const firstIndex = Math.max(definition.warmup - 1, latestIndex - FACTOR_HISTORY_WINDOW + 1);
    const history: number[] = [];
    for (let index = firstIndex; index <= latestIndex; index += 1) {
      const value = definition.calculate(candles, index);
      if (value != null && Number.isFinite(value)) history.push(value);
    }
    if (history.length < MIN_FACTOR_OBSERVATIONS) return [];
    return [{
      definition,
      value: latestValue,
      percentileScore: percentileScore(history, latestValue, definition.direction),
      observations: history.length,
    }];
  });
  const weightSum = available.reduce((sum, item) => sum + item.definition.rankIcIr, 0);
  return available.map((item) => {
    const normalizedWeight = weightSum > 0 ? item.definition.rankIcIr / weightSum * 100 : 0;
    return {
      ...item,
      normalizedWeight,
      contribution: item.percentileScore / 100 * normalizedWeight,
    };
  });
}

function buildSections(factors: ScoredFactor[], forcedCooling: boolean, liquidityDetail: string) {
  const factorSections = Object.entries(SECTION_META)
    .sort(([, left], [, right]) => left.order - right.order)
    .flatMap(([key, meta]) => {
      const sectionFactors = factors.filter((item) => item.definition.section === key);
      if (sectionFactors.length === 0) return [];
      return [{
        key,
        title: meta.title,
        score: round(sectionFactors.reduce((sum, item) => sum + item.contribution, 0), 1),
        maxScore: round(sectionFactors.reduce((sum, item) => sum + item.normalizedWeight, 0), 1),
        items: sectionFactors.map((item): SelectionScoreItem => ({
          label: item.definition.label,
          points: round(item.contribution, 1),
          matched: item.percentileScore >= 50,
          detail: [
            `原值 ${item.definition.format(item.value)}`,
            `${item.definition.direction === 'lower' ? '越低越优' : '越高越优'}`,
            `历史分位得分 ${round(item.percentileScore, 1)}`,
            `权重 ${round(item.normalizedWeight, 1)}%`,
            `${item.observations} 个观测`,
          ].join('；'),
          kind: 'bonus',
        })),
      }];
    });
  const risk: SelectionScoreSection = {
    key: 'risk',
    title: '流动性硬过滤',
    score: 0,
    maxScore: null,
    items: [{
      label: '20 日均成交额低于 1000 万',
      points: 0,
      matched: forcedCooling,
      detail: liquidityDetail,
      kind: 'penalty',
    }],
  };
  return [...factorSections, risk];
}

function tierFor(score: number): SelectionScoreTier {
  if (score >= 80) return 'core';
  if (score >= 60) return 'watch';
  if (score >= 40) return 'weak';
  return 'blocked';
}

export function calculateSelectionScore(
  inputCandles: KlinePoint[],
  _benchmarkCandles: KlinePoint[],
): SelectionScoreResult {
  const inputSampleSize = inputCandles.length;
  const candles = uniqueByDate([...inputCandles]
    .filter((item) => [item.open, item.close, item.high, item.low].every(
      (value) => Number.isFinite(value) && value > 0,
    ) && Number.isFinite(item.volume) && item.volume >= 0)
    .sort((left, right) => left.date.localeCompare(right.date)));

  if (candles.length < MIN_CANDLES) {
    return {
      status: 'insufficient',
      score: null,
      tier: null,
      tierLabel: '数据不足',
      tierDescription: '',
      rawPositiveScore: 0,
      normalizedBaseScore: 0,
      riskDeduction: 0,
      forcedCooling: false,
      sections: [],
      asOf: candles[candles.length - 1]?.date ?? null,
      inputSampleSize,
      sampleSize: candles.length,
      message: `收到 ${inputSampleSize} 根日 K，清洗并按日期去重后有 ${candles.length} 根有效日 K，至少需要 ${MIN_CANDLES} 根。`,
      assumptions: [],
    };
  }

  const scoredFactors = scoreFactors(candles);
  if (scoredFactors.length === 0) {
    return {
      status: 'insufficient',
      score: null,
      tier: null,
      tierLabel: '因子不足',
      tierDescription: '',
      rawPositiveScore: 0,
      normalizedBaseScore: 0,
      riskDeduction: 0,
      forcedCooling: false,
      sections: [],
      asOf: candles[candles.length - 1].date,
      inputSampleSize,
      sampleSize: candles.length,
      message: `没有因子达到至少 ${MIN_FACTOR_OBSERVATIONS} 个历史观测，暂时无法计算稳定分位。`,
      assumptions: [],
    };
  }

  const amountWindow = candles.slice(-20);
  const actualAmountCount = amountWindow.filter(
    (item) => item.amount != null && Number.isFinite(item.amount) && item.amount >= 0,
  ).length;
  const amounts = amountWindow.map((item) => (
    item.amount != null && Number.isFinite(item.amount) && item.amount >= 0
      ? item.amount
      : item.volume * ((item.high + item.low + item.close) / 3) * 100
  ));
  const averageAmountYuan = average(amounts);
  const forcedCooling = averageAmountYuan < LIQUIDITY_FLOOR_YUAN;
  const liquidityDetail = `20 日均成交额 ${round(averageAmountYuan / 100_000_000)} 亿`;
  const baseScore = round(scoredFactors.reduce((sum, item) => sum + item.contribution, 0));
  const score = forcedCooling ? Math.min(baseScore, 39) : baseScore;
  const tier = forcedCooling ? 'blocked' : tierFor(score);
  const missingFactorLabels = FACTORS
    .filter((definition) => !scoredFactors.some((item) => item.definition.id === definition.id))
    .map((definition) => definition.label);

  return {
    status: 'ready',
    score,
    tier,
    tierLabel: TIER_META[tier].label,
    tierDescription: forcedCooling
      ? `20 日均成交额低于 1000 万，先执行流动性硬过滤；${TIER_META.blocked.description}`
      : TIER_META[tier].description,
    rawPositiveScore: baseScore,
    normalizedBaseScore: baseScore,
    riskDeduction: baseScore - score,
    forcedCooling,
    sections: buildSections(scoredFactors, forcedCooling, liquidityDetail),
    asOf: candles[candles.length - 1].date,
    inputSampleSize,
    sampleSize: candles.length,
    assumptions: [
      '采用研究报告 Top 10 强信号精简方案；PB 缺少历史输入，当前使用其余 9 个量价因子并按可用因子重新归一化。',
      `各因子使用最近最多 ${FACTOR_HISTORY_WINDOW} 个单股历史观测转换为方向调整后的分位分；这是页面即时评分代理，不等同于报告的全市场横截面 z-score。`,
      '权重取报告 horizon=5d 的 |Rank ICIR|；评分建议按约 10 个交易日持有期使用，不适合作为 T+1 信号。',
      missingFactorLabels.length > 0
        ? `本次缺失或历史观测不足的因子：${missingFactorLabels.join('、')}；其权重已分配给其余可用因子。`
        : '9 个可计算量价因子均已纳入。',
      actualAmountCount === amountWindow.length
        ? '流动性硬过滤使用历史 K 线提供的真实成交额。'
        : `最近 20 日有 ${actualAmountCount} 日提供真实成交额，其余日期使用成交量 × 典型价 × 100 股/手估算。`,
    ],
  };
}
