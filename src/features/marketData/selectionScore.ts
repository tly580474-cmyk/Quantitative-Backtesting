import type { KlinePoint } from './types';
import {
  normalPriceLimitRatio,
  inferAshareBoard,
  resolveListingLifecycle,
  resolvePriceLimitRule,
  type ListingLifecycle,
} from './priceLimitRules';

export type SelectionStyleId = 'contrarian' | 'value' | 'growth' | 'trend' | 'limit-up';
export type SelectionScoreTier = 'core' | 'watch' | 'weak' | 'blocked';

export interface SelectionScoreContext {
  securityCode?: string;
  securityName?: string;
  listDate?: string | null;
  peTtm?: number | null;
  pb?: number | null;
  psTtm?: number | null;
  marketCapYi?: number | null;
  floatMarketCapYi?: number | null;
  dividendYieldPct?: number | null;
  roePct?: number | null;
  revenueGrowthPct?: number | null;
  netProfitGrowthPct?: number | null;
  debtRatioPct?: number | null;
  asOf?: string | null;
  sources?: string[];
}

export interface SelectionStyleOption {
  value: SelectionStyleId;
  label: string;
  riskLabel: string;
  horizon: number;
  description: string;
}

export const SELECTION_STYLE_OPTIONS: SelectionStyleOption[] = [
  { value: 'value', label: '价值投资', riskLabel: '稳健', horizon: 60, description: '股息、估值、盈利质量与低波动' },
  { value: 'growth', label: '成长型', riskLabel: '稳中求进', horizon: 60, description: '真实业绩增长、质量与相对强势' },
  { value: 'contrarian', label: '逆向抄底', riskLabel: '进取', horizon: 20, description: '超跌、缩量与反转修复' },
  { value: 'trend', label: '趋势型', riskLabel: '进取', horizon: 60, description: '趋势延续、突破与相对强势' },
  { value: 'limit-up', label: '短线打板', riskLabel: '激进', horizon: 10, description: '涨停结构、量价与接力强度' },
];

export interface SelectionScoreItem {
  label: string;
  points: number;
  matched: boolean;
  detail: string;
  kind: 'bonus' | 'penalty';
  available?: boolean;
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
  styleId: SelectionStyleId;
  styleLabel: string;
  riskLabel: string;
  horizon: number;
  score: number | null;
  tier: SelectionScoreTier | null;
  tierLabel: string;
  tierDescription: string;
  rawPositiveScore: number;
  normalizedBaseScore: number;
  riskDeduction: number;
  forcedCooling: boolean;
  dataCoveragePct: number;
  benchmarkAvailable: boolean;
  relativeStrength20d: number | null;
  relativeStrength60d: number | null;
  sections: SelectionScoreSection[];
  asOf: string | null;
  inputSampleSize: number;
  sampleSize: number;
  lifecycle: ListingLifecycle;
  tradingDayNumber: number | null;
  ipoNoLimitTradingDays: number;
  message?: string;
  assumptions: string[];
}

type FactorDirection = 'higher' | 'lower';
type FactorSection = 'valuation' | 'quality' | 'growth' | 'volume' | 'trend' | 'momentum' | 'pattern' | 'liquidity' | 'market';

interface FactorDefinition {
  id: string;
  label: string;
  section: FactorSection;
  weight: number;
  direction?: FactorDirection;
  warmup?: number;
  format: (value: number) => string;
  calculate?: (
    candles: KlinePoint[],
    endIndex: number,
    benchmark: KlinePoint[],
    context: SelectionScoreContext,
  ) => number | null;
  contextValue?: (context: SelectionScoreContext) => number | null;
  fixedScore?: (value: number) => number;
}

interface ScoredFactor {
  definition: FactorDefinition;
  value: number | null;
  percentileScore: number;
  contribution: number;
  observations: number;
  available: boolean;
}

interface StyleSpec extends SelectionStyleOption {
  factors: FactorDefinition[];
}

const MIN_CANDLES = 65;
const MIN_FACTOR_OBSERVATIONS = 20;
const FACTOR_HISTORY_WINDOW = 252;
const LIQUIDITY_FLOOR_YUAN = 10_000_000;
const NEUTRAL_MISSING_SCORE = 50;

const SECTION_META: Record<FactorSection, { title: string; order: number }> = {
  valuation: { title: '估值与股息', order: 1 },
  quality: { title: '盈利质量', order: 2 },
  growth: { title: '业绩成长', order: 3 },
  market: { title: '相对大盘强弱', order: 4 },
  trend: { title: '趋势结构', order: 5 },
  momentum: { title: '动量与振荡', order: 6 },
  volume: { title: '量能', order: 7 },
  pattern: { title: '波幅形态', order: 8 },
  liquidity: { title: '流动性', order: 9 },
};

const TIER_META: Record<SelectionScoreTier, { label: string }> = {
  core: { label: '核心优选' },
  watch: { label: '持有观察' },
  weak: { label: '中性观察' },
  blocked: { label: '回避冷却' },
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : 0;
}

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function percent(value: number): string {
  return `${round(value * 100)}%`;
}

function percentPoint(value: number): string {
  return `${round(value, 2)}%`;
}

function ratio(value: number): string {
  return `${round(value, 3)} 倍`;
}

function number(value: number): string {
  return round(value, 2).toString();
}

function uniqueByDate<T extends { date: string }>(items: T[]): T[] {
  return items.filter((item, index) => index === 0 || item.date !== items[index - 1].date);
}

function smaAt(candles: KlinePoint[], period: number, endIndex: number): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return average(candles.slice(start, endIndex + 1).map((item) => item.close));
}

function returnAt(candles: KlinePoint[], endIndex: number, period: number): number | null {
  if (endIndex < period) return null;
  const start = candles[endIndex - period].close;
  return start > 0 ? candles[endIndex].close / start - 1 : null;
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

function drawdownAt(candles: KlinePoint[], endIndex: number, period = 20): number | null {
  if (endIndex < period - 1) return null;
  const high = Math.max(...candles.slice(endIndex - period + 1, endIndex + 1).map((item) => item.high));
  return high > 0 ? candles[endIndex].close / high - 1 : null;
}

function volatilityAt(candles: KlinePoint[], endIndex: number, period = 20): number | null {
  if (endIndex < period) return null;
  const returns = candles.slice(endIndex - period, endIndex + 1)
    .slice(1)
    .map((item, index) => item.close / candles[endIndex - period + index].close - 1);
  const mean = average(returns);
  const variance = average(returns.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance * 252);
}

function atrPctAt(candles: KlinePoint[], endIndex: number, period = 20): number | null {
  if (endIndex < period) return null;
  const ranges = candles.slice(endIndex - period + 1, endIndex + 1).map((item, index) => {
    const previousClose = candles[endIndex - period + index].close;
    return Math.max(item.high - item.low, Math.abs(item.high - previousClose), Math.abs(item.low - previousClose));
  });
  return candles[endIndex].close > 0 ? average(ranges) / candles[endIndex].close : null;
}

function alignBenchmark(stock: KlinePoint[], benchmark: KlinePoint[]): KlinePoint[] {
  if (benchmark.length === 0) return [];
  const sorted = uniqueByDate([...benchmark].sort((left, right) => left.date.localeCompare(right.date)));
  const byDate = new Map(sorted.map((item) => [item.date, item]));
  let cursor = 0;
  let latest: KlinePoint = sorted[0];
  return stock.map((item) => {
    const exact = byDate.get(item.date);
    if (exact) {
      latest = exact;
      return exact;
    }
    while (cursor < sorted.length && sorted[cursor].date <= item.date) {
      latest = sorted[cursor];
      cursor += 1;
    }
    return { ...latest, date: item.date };
  });
}

function relativeReturnAt(stock: KlinePoint[], endIndex: number, benchmark: KlinePoint[], period: number): number | null {
  if (benchmark.length !== stock.length || endIndex < period) return null;
  const stockReturn = returnAt(stock, endIndex, period);
  const benchmarkReturn = returnAt(benchmark, endIndex, period);
  return stockReturn != null && benchmarkReturn != null ? stockReturn - benchmarkReturn : null;
}

function kdjJAt(candles: KlinePoint[], endIndex: number): number | null {
  if (endIndex < 8) return null;
  let k = 50;
  let d = 50;
  for (let index = 8; index <= endIndex; index += 1) {
    const window = candles.slice(index - 8, index + 1);
    const low = Math.min(...window.map((item) => item.low));
    const high = Math.max(...window.map((item) => item.high));
    const rsv = high > low ? (candles[index].close - low) / (high - low) * 100 : 50;
    k = k * 2 / 3 + rsv / 3;
    d = d * 2 / 3 + k / 3;
  }
  return 3 * k - 2 * d;
}

export function limitUpThreshold(securityCode = ''): number {
  return normalPriceLimitRatio(inferAshareBoard(securityCode)) - 0.005;
}

function consecutiveLimitUpsAt(
  candles: KlinePoint[],
  endIndex: number,
  context: SelectionScoreContext,
): number | null {
  if (endIndex < 1) return null;
  const firstListedIndex = context.listDate
    ? candles.findIndex((item) => item.date >= context.listDate!)
    : -1;
  let count = 0;
  for (let index = endIndex; index > 0; index -= 1) {
    const tradingDayNumber = firstListedIndex >= 0 ? index - firstListedIndex + 1 : null;
    const rule = resolvePriceLimitRule({
      securityCode: context.securityCode ?? '',
      listDate: context.listDate,
      tradeDate: candles[index].date,
      tradingDayNumber,
      isRiskWarning: /^\*?ST/i.test(context.securityName ?? ''),
    });
    if (rule.detectionThreshold == null) break;
    const previous = candles[index].previousClose ?? candles[index - 1].close;
    if (previous <= 0 || candles[index].close / previous - 1 < rule.detectionThreshold) break;
    count += 1;
  }
  return count;
}

function bellScore(value: number, target: number, tolerance: number): number {
  return clamp(100 - Math.abs(value - target) / tolerance * 50);
}

function lowerPositiveScore(value: number, good: number, bad: number): number {
  if (value <= 0) return 0;
  return clamp((bad - value) / (bad - good) * 100);
}

const common = {
  breakout: (weight: number, direction: FactorDirection): FactorDefinition => ({
    id: 'breakout_20d', label: '20 日突破强度', section: 'volume', weight, direction, warmup: 21, format: percent,
    calculate: (candles, endIndex) => {
      if (endIndex < 20) return null;
      const high = Math.max(...candles.slice(endIndex - 20, endIndex).map((item) => item.high));
      return high > 0 ? candles[endIndex].close / high - 1 : null;
    },
  }),
  volumeRatio: (weight: number, direction: FactorDirection): FactorDefinition => ({
    id: 'volume_ratio', label: '当日量比', section: 'volume', weight, direction, warmup: 21, format: ratio,
    calculate: (candles, endIndex) => {
      if (endIndex < 20) return null;
      const baseline = average(candles.slice(endIndex - 20, endIndex).map((item) => item.volume));
      return baseline > 0 ? candles[endIndex].volume / baseline : null;
    },
  }),
  return: (period: number, weight: number, direction: FactorDirection): FactorDefinition => ({
    id: `return_${period}d`, label: `${period} 日收益率`, section: 'momentum', weight, direction, warmup: period + 1, format: percent,
    calculate: (candles, endIndex) => returnAt(candles, endIndex, period),
  }),
  relative: (period: number, weight: number, direction: FactorDirection): FactorDefinition => ({
    id: `relative_${period}d`, label: `相对沪深300 ${period}日强弱`, section: 'market', weight, direction, warmup: period + 1, format: percent,
    calculate: (candles, endIndex, benchmark) => relativeReturnAt(candles, endIndex, benchmark, period),
    fixedScore: (value) => clamp(50 + (direction === 'higher' ? value : -value) * 500),
  }),
  ma20Distance: (weight: number, direction: FactorDirection): FactorDefinition => ({
    id: 'price_above_ma20', label: '价格相对 MA20', section: 'trend', weight, direction, warmup: 20, format: percent,
    calculate: (candles, endIndex) => {
      const ma20 = smaAt(candles, 20, endIndex);
      return ma20 && ma20 > 0 ? candles[endIndex].close / ma20 - 1 : null;
    },
  }),
  ma60Slope: (weight: number, direction: FactorDirection): FactorDefinition => ({
    id: 'ma60_slope_5d', label: 'MA60 5日斜率', section: 'trend', weight, direction, warmup: 65, format: percent,
    calculate: (candles, endIndex) => {
      const current = smaAt(candles, 60, endIndex);
      const previous = smaAt(candles, 60, endIndex - 5);
      return current != null && previous != null && previous > 0 ? current / previous - 1 : null;
    },
  }),
};

const STYLE_SPECS: Record<SelectionStyleId, StyleSpec> = {
  contrarian: {
    ...SELECTION_STYLE_OPTIONS.find((item) => item.value === 'contrarian')!,
    factors: [
      common.relative(20, 12, 'lower'),
      common.breakout(15, 'lower'),
      common.volumeRatio(9, 'lower'),
      common.return(20, 12, 'lower'),
      common.ma60Slope(9, 'lower'),
      common.ma20Distance(9, 'lower'),
      {
        id: 'rsi_14', label: 'RSI(14)', section: 'momentum', weight: 11, direction: 'lower', warmup: 15, format: number,
        calculate: (candles, endIndex) => rsiAt(candles, endIndex),
      },
      {
        id: 'contraction', label: '近5日/前15日波幅', section: 'pattern', weight: 11, direction: 'higher', warmup: 20, format: ratio,
        calculate: (candles, endIndex) => {
          if (endIndex < 19) return null;
          const previous = candles.slice(endIndex - 19, endIndex - 4);
          const recent = candles.slice(endIndex - 4, endIndex + 1);
          const oldRange = Math.max(...previous.map((item) => item.high)) - Math.min(...previous.map((item) => item.low));
          const newRange = Math.max(...recent.map((item) => item.high)) - Math.min(...recent.map((item) => item.low));
          return oldRange > 0 ? newRange / oldRange : null;
        },
      },
      {
        id: 'turnover_rate', label: '换手率', section: 'liquidity', weight: 12, direction: 'lower', warmup: 1, format: percentPoint,
        calculate: (candles, endIndex) => candles[endIndex].turnoverRatePct ?? null,
      },
    ],
  },
  value: {
    ...SELECTION_STYLE_OPTIONS.find((item) => item.value === 'value')!,
    factors: [
      {
        id: 'dividend_yield', label: '近12个月股息率', section: 'valuation', weight: 22, format: percentPoint,
        contextValue: (context) => context.dividendYieldPct ?? null,
        fixedScore: (value) => clamp(value / 5 * 100),
      },
      {
        id: 'pe_ttm', label: 'PE(TTM)', section: 'valuation', weight: 13, format: number,
        contextValue: (context) => context.peTtm ?? null,
        fixedScore: (value) => lowerPositiveScore(value, 8, 45),
      },
      {
        id: 'pb', label: 'PB', section: 'valuation', weight: 12, format: number,
        contextValue: (context) => context.pb ?? null,
        fixedScore: (value) => lowerPositiveScore(value, 0.8, 6),
      },
      {
        id: 'roe', label: 'ROE', section: 'quality', weight: 15, format: percentPoint,
        contextValue: (context) => context.roePct ?? null,
        fixedScore: (value) => clamp((value - 5) / 15 * 100),
      },
      {
        id: 'market_cap', label: '总市值稳健度', section: 'valuation', weight: 8, format: (value) => `${round(value)} 亿`,
        contextValue: (context) => context.marketCapYi ?? null,
        fixedScore: (value) => clamp(Math.log10(Math.max(value, 1)) / 3 * 100),
      },
      {
        id: 'drawdown_20d', label: '20日回撤控制', section: 'pattern', weight: 10, direction: 'higher', warmup: 20, format: percent,
        calculate: (candles, endIndex) => drawdownAt(candles, endIndex),
      },
      {
        id: 'volatility_20d', label: '20日年化波动', section: 'pattern', weight: 8, direction: 'lower', warmup: 21, format: percent,
        calculate: (candles, endIndex) => volatilityAt(candles, endIndex),
      },
      common.relative(60, 12, 'higher'),
    ],
  },
  growth: {
    ...SELECTION_STYLE_OPTIONS.find((item) => item.value === 'growth')!,
    factors: [
      {
        id: 'revenue_growth', label: '营收同比增长', section: 'growth', weight: 18, format: percentPoint,
        contextValue: (context) => context.revenueGrowthPct ?? null,
        fixedScore: (value) => clamp((value + 5) / 45 * 100),
      },
      {
        id: 'profit_growth', label: '净利润同比增长', section: 'growth', weight: 20, format: percentPoint,
        contextValue: (context) => context.netProfitGrowthPct ?? null,
        fixedScore: (value) => clamp((value + 10) / 70 * 100),
      },
      {
        id: 'roe', label: 'ROE质量', section: 'quality', weight: 10, format: percentPoint,
        contextValue: (context) => context.roePct ?? null,
        fixedScore: (value) => clamp((value - 5) / 15 * 100),
      },
      common.relative(60, 15, 'higher'),
      common.return(60, 12, 'higher'),
      common.volumeRatio(8, 'higher'),
      common.ma60Slope(7, 'higher'),
      common.breakout(5, 'higher'),
      {
        id: 'market_cap', label: '市值承载力', section: 'valuation', weight: 5, format: (value) => `${round(value)} 亿`,
        contextValue: (context) => context.marketCapYi ?? null,
        fixedScore: (value) => clamp(Math.log10(Math.max(value, 1)) / 3 * 100),
      },
    ],
  },
  trend: {
    ...SELECTION_STYLE_OPTIONS.find((item) => item.value === 'trend')!,
    factors: [
      {
        id: 'ma_alignment', label: 'MA5/10/20/60多头排列', section: 'trend', weight: 18, format: number,
        calculate: (candles, endIndex) => {
          const values = [5, 10, 20, 60].map((period) => smaAt(candles, period, endIndex));
          if (values.some((value) => value == null)) return null;
          return Number(values[0]! > values[1]!) + Number(values[1]! > values[2]!) + Number(values[2]! > values[3]!);
        },
        fixedScore: (value) => value / 3 * 100,
      },
      common.relative(60, 15, 'higher'),
      common.return(60, 15, 'higher'),
      common.breakout(12, 'higher'),
      common.ma60Slope(10, 'higher'),
      common.ma20Distance(10, 'higher'),
      {
        id: 'atr_20', label: 'ATR(20)/价格', section: 'pattern', weight: 8, direction: 'lower', warmup: 21, format: percent,
        calculate: (candles, endIndex) => atrPctAt(candles, endIndex),
      },
      common.return(20, 7, 'higher'),
      common.volumeRatio(5, 'higher'),
    ],
  },
  'limit-up': {
    ...SELECTION_STYLE_OPTIONS.find((item) => item.value === 'limit-up')!,
    factors: [
      {
        id: 'limit_up_consecutive', label: '连续涨停天数', section: 'momentum', weight: 20, format: (value) => `${value} 天`,
        calculate: (candles, endIndex, _benchmark, context) => (
          consecutiveLimitUpsAt(candles, endIndex, context)
        ),
        fixedScore: (value) => clamp(value / 3 * 100),
      },
      common.breakout(12, 'higher'),
      common.volumeRatio(12, 'higher'),
      {
        id: 'bias_6', label: 'BIAS(6)', section: 'momentum', weight: 10, format: percent,
        calculate: (candles, endIndex) => {
          const ma6 = smaAt(candles, 6, endIndex);
          return ma6 && ma6 > 0 ? candles[endIndex].close / ma6 - 1 : null;
        },
        fixedScore: (value) => bellScore(value * 100, 6, 10),
      },
      {
        id: 'kdj_j', label: 'KDJ-J强势区', section: 'momentum', weight: 10, format: number,
        calculate: (candles, endIndex) => kdjJAt(candles, endIndex),
        fixedScore: (value) => bellScore(value, 85, 65),
      },
      {
        id: 'intraday_strength', label: '日内收盘强度', section: 'pattern', weight: 10, format: number,
        calculate: (candles, endIndex) => {
          const item = candles[endIndex];
          return item.high > item.low ? (item.close - item.open) / (item.high - item.low) : 0;
        },
        fixedScore: (value) => clamp((value + 1) / 2 * 100),
      },
      common.return(10, 10, 'higher'),
      common.relative(20, 8, 'higher'),
      {
        id: 'rsi_14', label: 'RSI(14)接力区', section: 'momentum', weight: 8, format: number,
        calculate: (candles, endIndex) => rsiAt(candles, endIndex),
        fixedScore: (value) => bellScore(value, 72, 42),
      },
    ],
  },
};

function percentileScore(values: number[], latestValue: number, direction: FactorDirection): number {
  const lower = values.filter((value) => value < latestValue).length;
  const equal = values.filter((value) => value === latestValue).length;
  const percentile = (lower + equal * 0.5) / values.length;
  return clamp((direction === 'higher' ? percentile : 1 - percentile) * 100);
}

function scoreFactors(
  spec: StyleSpec,
  candles: KlinePoint[],
  benchmark: KlinePoint[],
  context: SelectionScoreContext,
): ScoredFactor[] {
  const latestIndex = candles.length - 1;
  return spec.factors.map((definition) => {
    const contextValue = definition.contextValue?.(context);
    if (definition.contextValue) {
      const available = contextValue != null && Number.isFinite(contextValue);
      const score = available ? definition.fixedScore!(contextValue) : NEUTRAL_MISSING_SCORE;
      return {
        definition,
        value: available ? contextValue : null,
        percentileScore: score,
        contribution: score / 100 * definition.weight,
        observations: available ? 1 : 0,
        available,
      };
    }

    const latestValue = definition.calculate?.(candles, latestIndex, benchmark, context) ?? null;
    if (latestValue == null || !Number.isFinite(latestValue)) {
      return {
        definition,
        value: null,
        percentileScore: NEUTRAL_MISSING_SCORE,
        contribution: NEUTRAL_MISSING_SCORE / 100 * definition.weight,
        observations: 0,
        available: false,
      };
    }
    if (definition.fixedScore) {
      const score = definition.fixedScore(latestValue);
      return {
        definition,
        value: latestValue,
        percentileScore: score,
        contribution: score / 100 * definition.weight,
        observations: 1,
        available: true,
      };
    }
    const firstIndex = Math.max((definition.warmup ?? 1) - 1, latestIndex - FACTOR_HISTORY_WINDOW + 1);
    const history: number[] = [];
    for (let index = firstIndex; index <= latestIndex; index += 1) {
      const value = definition.calculate?.(candles, index, benchmark, context);
      if (value != null && Number.isFinite(value)) history.push(value);
    }
    const available = history.length >= MIN_FACTOR_OBSERVATIONS;
    const score = available
      ? percentileScore(history, latestValue, definition.direction ?? 'higher')
      : NEUTRAL_MISSING_SCORE;
    return {
      definition,
      value: latestValue,
      percentileScore: score,
      contribution: score / 100 * definition.weight,
      observations: available ? history.length : 0,
      available,
    };
  });
}

function buildSections(factors: ScoredFactor[], forcedCooling: boolean, liquidityDetail: string): SelectionScoreSection[] {
  const factorSections = Object.entries(SECTION_META)
    .sort(([, left], [, right]) => left.order - right.order)
    .flatMap(([key, meta]) => {
      const items = factors.filter((factor) => factor.definition.section === key);
      if (items.length === 0) return [];
      return [{
        key,
        title: meta.title,
        score: round(items.reduce((sum, item) => sum + item.contribution, 0), 1),
        maxScore: round(items.reduce((sum, item) => sum + item.definition.weight, 0), 1),
        items: items.map((item): SelectionScoreItem => ({
          label: item.definition.label,
          points: round(item.contribution, 1),
          matched: item.available && item.percentileScore >= 50,
          available: item.available,
          detail: item.available
            ? [
                `原值 ${item.definition.format(item.value!)}`,
                item.definition.fixedScore ? '规则映射' : `${item.definition.direction === 'lower' ? '越低越优' : '越高越优'}历史分位`,
                `因子得分 ${round(item.percentileScore, 1)}`,
                `权重 ${item.definition.weight}%`,
                item.observations > 1 ? `${item.observations} 个观测` : null,
              ].filter(Boolean).join('；')
            : `数据缺失，按中性 ${NEUTRAL_MISSING_SCORE} 分占位；权重 ${item.definition.weight}%，不因缺失而重新分配`,
          kind: 'bonus',
        })),
      }];
    });
  return [...factorSections, {
    key: 'risk',
    title: '流动性硬过滤',
    score: 0,
    maxScore: null,
    items: [{
      label: '20日均成交额低于1000万',
      points: 0,
      matched: forcedCooling,
      available: true,
      detail: liquidityDetail,
      kind: 'penalty',
    }],
  }];
}

function tierFor(score: number): SelectionScoreTier {
  if (score >= 80) return 'core';
  if (score >= 60) return 'watch';
  if (score >= 40) return 'weak';
  return 'blocked';
}

function cleanCandles(items: KlinePoint[]): KlinePoint[] {
  return uniqueByDate([...items]
    .filter((item) => [item.open, item.close, item.high, item.low].every(
      (value) => Number.isFinite(value) && value > 0,
    ) && Number.isFinite(item.volume) && item.volume >= 0)
    .sort((left, right) => left.date.localeCompare(right.date)));
}

export function calculateSelectionScore(
  inputCandles: KlinePoint[],
  inputBenchmarkCandles: KlinePoint[],
  styleId: SelectionStyleId = 'contrarian',
  context: SelectionScoreContext = {},
): SelectionScoreResult {
  const spec = STYLE_SPECS[styleId];
  const inputSampleSize = inputCandles.length;
  const candles = cleanCandles(inputCandles);
  const benchmark = alignBenchmark(candles, cleanCandles(inputBenchmarkCandles));
  const listedCandles = context.listDate
    ? candles.filter((item) => item.date >= context.listDate!)
    : candles;
  const lifecycleState = resolveListingLifecycle({
    securityCode: context.securityCode ?? '',
    listDate: context.listDate,
    asOf: candles[candles.length - 1]?.date ?? null,
    validTradingDays: listedCandles.length,
    scoreWarmupDays: MIN_CANDLES,
  });
  const relativeStrength20d = relativeReturnAt(candles, candles.length - 1, benchmark, 20);
  const relativeStrength60d = relativeReturnAt(candles, candles.length - 1, benchmark, 60);
  const base = {
    styleId,
    styleLabel: spec.label,
    riskLabel: spec.riskLabel,
    horizon: spec.horizon,
    benchmarkAvailable: benchmark.length === candles.length,
    relativeStrength20d,
    relativeStrength60d,
    inputSampleSize,
    sampleSize: candles.length,
    asOf: candles[candles.length - 1]?.date ?? null,
    ...lifecycleState,
  };

  if (candles.length < MIN_CANDLES) {
    return {
      ...base,
      status: 'insufficient',
      score: null,
      tier: null,
      tierLabel: context.listDate && (
        lifecycleState.lifecycle === 'score_warmup'
        || lifecycleState.lifecycle === 'early_listing'
      )
        ? '新股预热'
        : '数据不足',
      tierDescription: '',
      rawPositiveScore: 0,
      normalizedBaseScore: 0,
      riskDeduction: 0,
      forcedCooling: false,
      dataCoveragePct: 0,
      sections: [],
      message: context.listDate && (
        lifecycleState.lifecycle === 'score_warmup'
        || lifecycleState.lifecycle === 'early_listing'
      )
        ? `新股评分预热中：当前有 ${listedCandles.length} 个有效交易日，正式评分至少需要 ${MIN_CANDLES} 个。`
        : `收到 ${inputSampleSize} 根日 K，清洗并按日期去重后有 ${candles.length} 根有效日 K，至少需要 ${MIN_CANDLES} 根。`,
      assumptions: [],
    };
  }

  const factors = scoreFactors(spec, candles, benchmark, context);
  const availableWeight = factors.filter((item) => item.available)
    .reduce((sum, item) => sum + item.definition.weight, 0);
  const dataCoveragePct = round(availableWeight);
  const amountWindow = candles.slice(-20);
  const actualAmountCount = amountWindow.filter(
    (item) => item.amount != null && Number.isFinite(item.amount) && item.amount >= 0,
  ).length;
  const amounts = amountWindow.map((item) => (
    item.amount != null && Number.isFinite(item.amount) && item.amount >= 0
      ? item.amount
      : item.volume * ((item.high + item.low + item.close) / 3)
  ));
  const averageAmountYuan = average(amounts);
  const forcedCooling = averageAmountYuan < LIQUIDITY_FLOOR_YUAN;
  const baseScore = round(factors.reduce((sum, item) => sum + item.contribution, 0));
  const score = forcedCooling ? Math.min(baseScore, 39) : baseScore;
  const tier = forcedCooling ? 'blocked' : tierFor(score);
  const missing = factors.filter((item) => !item.available).map((item) => item.definition.label);
  const relativeText = relativeStrength20d == null
    ? '沪深300基准数据不足，相对强弱因子按中性分占位。'
    : `近20日相对沪深300 ${relativeStrength20d >= 0 ? '强' : '弱'} ${percent(Math.abs(relativeStrength20d))}。`;

  return {
    ...base,
    status: 'ready',
    score,
    tier,
    tierLabel: TIER_META[tier].label,
    tierDescription: forcedCooling
      ? '20日均成交额低于1000万，触发流动性硬过滤。'
      : `${spec.label}评分建议按约${spec.horizon}个交易日观察或持有；${relativeText}`,
    rawPositiveScore: baseScore,
    normalizedBaseScore: baseScore,
    riskDeduction: baseScore - score,
    forcedCooling,
    dataCoveragePct,
    sections: buildSections(factors, forcedCooling, `20日均成交额 ${round(averageAmountYuan / 100_000_000)} 亿`),
    assumptions: [
      `采用五年全市场研究的推荐周期：${spec.label} ${spec.horizon}日；页面使用单股历史分位与财务规则映射，不能等同于回测中的全市场横截面z-score。`,
      '每种风格都显式比较沪深300；缺少基准时相对强弱因子保留权重并按中性分占位。',
      styleId === 'value'
        ? '股息率是价值评分最高权重因子（22%），使用近12个月已除权现金分红合计÷当前股价；缺失时明确展示且不静默移除。'
        : `当前风格：${spec.description}。`,
      missing.length > 0
        ? `本次数据覆盖 ${dataCoveragePct}%；缺失项：${missing.join('、')}。缺失项按中性分处理，未把权重转嫁给其他因子。`
        : '本次所需因子数据完整。',
      actualAmountCount === amountWindow.length
        ? '流动性硬过滤使用历史K线提供的真实成交额。'
        : `最近20日有${actualAmountCount}日提供真实成交额，其余使用成交量（股）×典型价估算。`,
    ],
  };
}
