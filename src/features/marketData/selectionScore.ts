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
  sampleSize: number;
  message?: string;
  assumptions: string[];
}

const POSITIVE_SCORE_MAX = 100;

const TIER_META: Record<SelectionScoreTier, { label: string; description: string }> = {
  core: {
    label: '核心优选池',
    description: '趋势较好、量价健康，适合作为重点跟踪对象，等待回踩或突破确认。',
  },
  watch: {
    label: '观察备选池',
    description: '整体结构不差，等待补量、突破或回踩企稳。',
  },
  weak: {
    label: '弱势观察池',
    description: '技术信号尚未统一，暂不操作，但保留观察等待趋势修复。',
  },
  blocked: {
    label: '冷却剔除池',
    description: '短期结构偏弱，暂时移出选股池，20–40 个交易日后重新评分。',
  },
};

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percent(value: number): string {
  return `${round(value * 100)}%`;
}

function smaAt(candles: KlinePoint[], period: number, endIndex = candles.length - 1): number | null {
  const start = endIndex - period + 1;
  if (start < 0) return null;
  return average(candles.slice(start, endIndex + 1).map((item) => item.close));
}

function priceReturn(candles: KlinePoint[], periods: number): number | null {
  if (candles.length <= periods) return null;
  const start = candles[candles.length - 1 - periods].close;
  const end = candles[candles.length - 1].close;
  return start > 0 ? end / start - 1 : null;
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index++) {
    result.push((values[index] - result[index - 1]) * multiplier + result[index - 1]);
  }
  return result;
}

function macd(candles: KlinePoint[]) {
  const closes = candles.map((item) => item.close);
  const fast = ema(closes, 12);
  const slow = ema(closes, 26);
  const dif = fast.map((value, index) => value - slow[index]);
  const dea = ema(dif, 9);
  const histogram = dif.map((value, index) => (value - dea[index]) * 2);
  return { dif, dea, histogram };
}

function rsi14(candles: KlinePoint[]): number | null {
  if (candles.length < 15) return null;
  const closes = candles.map((item) => item.close);
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= 14; index++) {
    const change = closes[index] - closes[index - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let avgGain = gains / 14;
  let avgLoss = losses / 14;
  for (let index = 15; index < closes.length; index++) {
    const change = closes[index] - closes[index - 1];
    avgGain = (avgGain * 13 + Math.max(change, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-change, 0)) / 14;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function addBonus(
  items: SelectionScoreItem[],
  label: string,
  points: number,
  matched: boolean,
  detail: string,
) {
  items.push({ label, points: matched ? points : 0, matched, detail, kind: 'bonus' });
}

function addPenalty(
  items: SelectionScoreItem[],
  label: string,
  points: number,
  matched: boolean,
  detail: string,
) {
  items.push({ label, points: matched ? -Math.abs(points) : 0, matched, detail, kind: 'penalty' });
}

function section(
  key: string,
  title: string,
  maxScore: number,
  items: SelectionScoreItem[],
): SelectionScoreSection {
  const score = Math.min(maxScore, Math.max(0, items.reduce((sum, item) => sum + item.points, 0)));
  return { key, title, maxScore, score, items };
}

function tierFor(score: number): SelectionScoreTier {
  if (score >= 75) return 'core';
  if (score >= 60) return 'watch';
  if (score >= 45) return 'weak';
  return 'blocked';
}

export function calculateSelectionScore(
  inputCandles: KlinePoint[],
  benchmarkCandles: KlinePoint[],
): SelectionScoreResult {
  const candles = [...inputCandles]
    .filter((item) => [item.open, item.close, item.high, item.low, item.volume].every(Number.isFinite))
    .sort((a, b) => a.date.localeCompare(b.date));
  const benchmark = [...benchmarkCandles]
    .filter((item) => Number.isFinite(item.close))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (candles.length < 65) {
    return {
      status: 'insufficient',
      score: null,
      tier: null,
      tierLabel: '数据不足',
      tierDescription: '至少需要 65 根日 K 才能计算 60 日均线趋势和完整评分。',
      rawPositiveScore: 0,
      normalizedBaseScore: 0,
      riskDeduction: 0,
      forcedCooling: false,
      sections: [],
      asOf: candles[candles.length - 1]?.date ?? null,
      sampleSize: candles.length,
      message: `当前仅有 ${candles.length} 根有效日 K，至少需要 65 根。`,
      assumptions: [],
    };
  }

  const latest = candles[candles.length - 1];
  const latestClose = latest.close;
  const sma5 = smaAt(candles, 5)!;
  const sma10 = smaAt(candles, 10)!;
  const sma20 = smaAt(candles, 20)!;
  const sma60 = smaAt(candles, 60)!;
  const sma5Prev = smaAt(candles, 5, candles.length - 6)!;
  const sma10Prev = smaAt(candles, 10, candles.length - 6)!;
  const sma60Prev = smaAt(candles, 60, candles.length - 6)!;
  const return5 = priceReturn(candles, 5)!;
  const return10 = priceReturn(candles, 10)!;
  const return20 = priceReturn(candles, 20)!;
  const benchmarkReturn20 = priceReturn(benchmark, 20);
  const previous20 = candles.slice(-21, -1);
  const previous60 = candles.slice(-61, -1);
  const recent5 = candles.slice(-5);
  const recent10 = candles.slice(-10);
  const averageVolume20 = average(previous20.map((item) => item.volume));
  const averageVolume3 = average(candles.slice(-3).map((item) => item.volume));
  const averageVolume5 = average(recent5.map((item) => item.volume));
  const previous20High = Math.max(...previous20.map((item) => item.high));
  const previous60High = Math.max(...previous60.map((item) => item.high));
  const distanceToSma20 = Math.abs(latestClose - sma20) / sma20;
  const distanceToPreviousHigh = Math.max(0, previous60High - latestClose) / previous60High;
  const latestVolumeRatio = averageVolume20 > 0 ? latest.volume / averageVolume20 : 0;
  const latestChange = latest.close / candles[candles.length - 2].close - 1;
  const dailyChanges = candles.map((item, index) => index === 0 ? 0 : item.close / candles[index - 1].close - 1);

  const trendItems: SelectionScoreItem[] = [];
  const sma60Change = sma60 / sma60Prev - 1;
  const sma60FlatOrUp = sma60Change >= -0.005;
  addBonus(trendItems, '60 日均线向上或走平', 8, sma60FlatOrUp, `MA60 ${round(sma60Prev)} → ${round(sma60)}（${percent(sma60Change)}）`);
  const sma20NearCross = sma20 >= sma60 * 0.98;
  addBonus(trendItems, '20 日线在 60 日线上方或即将上穿', 5, sma20NearCross, `MA20 ${round(sma20)} / MA60 ${round(sma60)}`);
  addBonus(trendItems, '股价站上或距离 20 日线不超过 5%', 5, latestClose >= sma20 || distanceToSma20 <= 0.05, `收盘 ${round(latestClose)} / MA20 ${round(sma20)} / 距离 ${percent(distanceToSma20)}`);
  const eitherShortMaUp = sma5 >= sma5Prev || sma10 >= sma10Prev;
  addBonus(trendItems, '5 日、10 日线至少一条向上', 4, eitherShortMaUp, `MA5 ${round(sma5Prev)}→${round(sma5)}；MA10 ${round(sma10Prev)}→${round(sma10)}`);
  addPenalty(trendItems, '60 日均线明显向下', 6, sma60Change < -0.015, `5 个交易日前后变化 ${percent(sma60Change)}`);
  const below60Unrecovered = candles.slice(-3).every((item) => item.close < sma60);
  addPenalty(trendItems, '跌破 60 日线且 3 日未收回', 6, below60Unrecovered, `最近 3 日收盘均低于 MA60 ${round(sma60)}`);
  const trend = section('trend', '中长期均线趋势', 22, trendItems);

  const momentumItems: SelectionScoreItem[] = [];
  const beatsBenchmark = benchmarkReturn20 != null && return20 > benchmarkReturn20;
  addBonus(momentumItems, '近 20 日表现强于沪深 300', 6, beatsBenchmark, benchmarkReturn20 == null
    ? `个股 ${percent(return20)}；沪深 300 数据不足`
    : `个股 ${percent(return20)} / 沪深 300 ${percent(benchmarkReturn20)}`);
  addBonus(momentumItems, '近 10 日涨幅为正', 5, return10 > 0, `近 10 日 ${percent(return10)}`);
  let significantDownStreak = 0;
  let hasThreeSignificantDown = false;
  for (let index = dailyChanges.length - 5; index < dailyChanges.length; index++) {
    significantDownStreak = dailyChanges[index] <= -0.02 ? significantDownStreak + 1 : 0;
    if (significantDownStreak >= 3) hasThreeSignificantDown = true;
  }
  addBonus(momentumItems, '近 5 日无连续 3 天明显下跌', 4, !hasThreeSignificantDown, hasThreeSignificantDown ? '出现连续 3 日单日跌幅至少 2%' : '未出现连续 3 日明显下跌');
  const distanceTo20High = Math.max(0, previous20High - latestClose) / previous20High;
  addBonus(momentumItems, '距离 20 日阶段高点不超过 5%', 3, distanceTo20High <= 0.05, `距离 ${percent(distanceTo20High)}`);
  addPenalty(momentumItems, '近 20 日跌幅超过 18%', 6, return20 < -0.18, `近 20 日 ${percent(return20)}`);
  const lastThreeVolumeDown = candles.slice(-3).every((item, offset) => {
    const index = candles.length - 3 + offset;
    return dailyChanges[index] < 0 && item.volume >= averageVolume20;
  });
  addPenalty(momentumItems, '近 5 日出现连续放量下跌', 5, lastThreeVolumeDown, `最近 3 日连续下跌且成交量不低于 20 日均量：${lastThreeVolumeDown ? '是' : '否'}`);
  const momentum = section('momentum', '短期动量强弱', 18, momentumItems);

  const volumeItems: SelectionScoreItem[] = [];
  const risingOrBreakout = latestChange > 0 || latestClose >= previous20High * 0.98;
  addBonus(volumeItems, '上涨或突破日量能达到 1.2 倍', 6, risingOrBreakout && latestVolumeRatio >= 1.2, `当日涨跌 ${percent(latestChange)}；量比 ${round(latestVolumeRatio)}`);
  const upVolumes = recent10.filter((_, index) => index > 0 && recent10[index].close > recent10[index - 1].close).map((item) => item.volume);
  const downVolumes = recent10.filter((_, index) => index > 0 && recent10[index].close < recent10[index - 1].close).map((item) => item.volume);
  const upVolumeAverage = average(upVolumes);
  const downVolumeAverage = average(downVolumes);
  addBonus(volumeItems, '上涨日量能高于下跌日', 5, upVolumes.length >= 2 && downVolumes.length >= 1 && upVolumeAverage > downVolumeAverage, `上涨日/下跌日均量 ${downVolumeAverage > 0 ? round(upVolumeAverage / downVolumeAverage) : '—'} 倍`);
  addBonus(volumeItems, '回调时量能明显缩小', 4, downVolumes.length >= 1 && upVolumes.length >= 1 && downVolumeAverage < upVolumeAverage * 0.9, `下跌日均量为上涨日 ${upVolumeAverage > 0 ? percent(downVolumeAverage / upVolumeAverage) : '—'}`);
  addBonus(volumeItems, '近 3 日均量不低于 20 日均量 80%', 3, averageVolume3 >= averageVolume20 * 0.8, `3 日/20 日量比 ${round(averageVolume3 / averageVolume20)}`);
  const shrinkingDecline = return5 < 0 && averageVolume5 < averageVolume20 * 0.6;
  addPenalty(volumeItems, '持续缩量阴跌', 5, shrinkingDecline, `近 5 日 ${percent(return5)}；5 日/20 日量比 ${round(averageVolume5 / averageVolume20)}`);
  const heavySellWithoutSupport = latestChange <= -0.03
    && latestVolumeRatio >= 1.5
    && (latest.close - latest.low) / Math.max(latest.high - latest.low, 0.01) < 0.25;
  addPenalty(volumeItems, '放量下跌且无明显承接', 6, heavySellWithoutSupport, `涨跌 ${percent(latestChange)}；量比 ${round(latestVolumeRatio)}；收盘靠近最低`);
  const volume = section('volume', '成交量资金验证', 18, volumeItems);

  const supportItems: SelectionScoreItem[] = [];
  const nearSupport = distanceToSma20 <= 0.08;
  addBonus(supportItems, '距离 20 日线或支撑位不超过 8%', 5, nearSupport, `距 MA20 ${percent(distanceToSma20)}`);
  addBonus(supportItems, '距离上方压力仍有 5% 以上空间', 4, distanceToPreviousHigh >= 0.05, `距 60 日高点 ${percent(distanceToPreviousHigh)}`);
  const supportHeld = candles.slice(-5).every((item) => item.low >= sma20 * 0.95);
  addBonus(supportItems, '回踩支撑位未有效跌破', 3, supportHeld, `最近 5 日低点均未低于 MA20 的 95%：${supportHeld ? '是' : '否'}`);
  const latestRange = latest.high - latest.low;
  const isBullishOrDoji = latest.close >= latest.open || (latestRange > 0 && Math.abs(latest.close - latest.open) / latestRange <= 0.25);
  const stopFalling = nearSupport && (isBullishOrDoji || latest.volume < candles[candles.length - 2].volume);
  addBonus(supportItems, '小阳线、十字星或缩量止跌', 2, stopFalling, `K 线 ${latest.close >= latest.open ? '收阳' : isBullishOrDoji ? '近似十字星' : '收阴'}；量比 ${round(latestVolumeRatio)}`);
  addPenalty(supportItems, '距离上方压力不足 3%', 4, distanceToPreviousHigh < 0.03, `距 60 日高点 ${percent(distanceToPreviousHigh)}`);
  addPenalty(supportItems, '明显远离 20 日线超过 12%', 5, distanceToSma20 > 0.12, `距 MA20 ${percent(distanceToSma20)}`);
  const support = section('support', '支撑压力位置', 14, supportItems);

  const patternItems: SelectionScoreItem[] = [];
  const attemptBreakout = latestClose >= previous20High * 0.97;
  addBonus(patternItems, '箱体平台尝试突破', 4, attemptBreakout, `收盘 ${round(latestClose)} / 前 20 日高点 ${round(previous20High)}`);
  const olderPlatformHigh = Math.max(...candles.slice(-26, -6).map((item) => item.high));
  const brokeRecently = Math.max(...candles.slice(-5).map((item) => item.close)) >= olderPlatformHigh;
  const breakoutHeld = brokeRecently && latestClose >= olderPlatformHigh * 0.98;
  addBonus(patternItems, '突破平台后未明显跌回', 4, breakoutHeld, `平台 ${round(olderPlatformHigh)} / 当前 ${round(latestClose)}`);
  const lowA = Math.min(...candles.slice(-15, -10).map((item) => item.low));
  const lowB = Math.min(...candles.slice(-10, -5).map((item) => item.low));
  const lowC = Math.min(...candles.slice(-5).map((item) => item.low));
  const higherLows = lowC > lowB && lowB > lowA;
  addBonus(patternItems, '底部逐步抬高', 4, higherLows, `阶段低点 ${round(lowA)} → ${round(lowB)} → ${round(lowC)}`);
  const rangePct = (item: KlinePoint) => (item.high - item.low) / Math.max(item.close, 0.01);
  const contraction = average(candles.slice(-5).map(rangePct)) < average(candles.slice(-15, -5).map(rangePct)) * 0.8
    && latestClose >= sma20;
  addBonus(patternItems, '上升三角形、收敛或旗形整理', 4, contraction, `近 5 日振幅相对前期 ${percent(average(candles.slice(-5).map(rangePct)) / average(candles.slice(-15, -5).map(rangePct)))}`);
  const bullishDays = recent5.filter((item) => item.close > item.open).length;
  const gentleRise = return5 > 0 && bullishDays >= 3 && recent5.every((_, index) => index === 0 || Math.abs(dailyChanges[dailyChanges.length - 5 + index]) < 0.05);
  addBonus(patternItems, '连续小阳线或温和上行', 3, gentleRise, `近 5 日 ${percent(return5)}；阳线 ${bullishDays} 天`);
  const pattern = section('pattern', 'K 线形态结构', 10, patternItems);

  const oscillatorItems: SelectionScoreItem[] = [];
  const macdValues = macd(candles);
  const histogram = macdValues.histogram;
  const lastHist = histogram[histogram.length - 1];
  const previousHist = histogram[histogram.length - 2];
  const latestDif = macdValues.dif[macdValues.dif.length - 1];
  const previousDif = macdValues.dif[macdValues.dif.length - 2];
  const latestDea = macdValues.dea[macdValues.dea.length - 1];
  const previousDea = macdValues.dea[macdValues.dea.length - 2];
  const macdGap = latestDif - latestDea;
  const previousGap = previousDif - previousDea;
  const macdGoldenOrNear = macdGap >= 0 || (macdGap > previousGap && Math.abs(macdGap) <= Math.max(latestClose * 0.002, 0.01));
  addBonus(oscillatorItems, 'MACD 金叉或即将金叉', 3, macdGoldenOrNear, `DIF ${round(latestDif)} / DEA ${round(latestDea)} / 差值 ${round(macdGap)}`);
  addBonus(oscillatorItems, '红柱扩大或绿柱缩短', 2, lastHist > previousHist, `柱 ${round(previousHist)} → ${round(lastHist)}`);
  const currentRsi = rsi14(candles)!;
  addBonus(oscillatorItems, 'RSI14 位于 35–75', 3, currentRsi >= 35 && currentRsi <= 75, `RSI14 ${round(currentRsi, 1)}`);
  addPenalty(oscillatorItems, 'RSI14 高于 85', 3, currentRsi > 85, `RSI14 ${round(currentRsi, 1)}`);
  const macdBearish = macdGap < 0 && lastHist < 0 && lastHist < previousHist;
  addPenalty(oscillatorItems, 'MACD 死叉且绿柱持续扩大', 3, macdBearish, `柱 ${round(previousHist)} → ${round(lastHist)}`);
  const oscillator = section('oscillator', 'MACD / RSI 辅助指标', 8, oscillatorItems);

  const volatilityItems: SelectionScoreItem[] = [];
  const drawdownWindow = candles.slice(-21);
  let rollingPeak = drawdownWindow[0].close;
  let maxDrawdown20 = 0;
  for (const item of drawdownWindow) {
    rollingPeak = Math.max(rollingPeak, item.high);
    maxDrawdown20 = Math.max(maxDrawdown20, (rollingPeak - item.low) / rollingPeak);
  }
  addBonus(volatilityItems, '近 20 日最大回撤小于 12%', 4, maxDrawdown20 < 0.12, `最大回撤 ${percent(maxDrawdown20)}`);
  let largeBearishStreak = 0;
  let hasConsecutiveLargeBearish = false;
  for (const item of recent10) {
    largeBearishStreak = item.close < item.open && (item.open - item.close) / item.open >= 0.03 ? largeBearishStreak + 1 : 0;
    if (largeBearishStreak >= 2) hasConsecutiveLargeBearish = true;
  }
  addBonus(volatilityItems, '近 10 日无连续大阴线', 3, !hasConsecutiveLargeBearish, hasConsecutiveLargeBearish ? '出现连续 2 根实体跌幅至少 3% 的阴线' : '未出现连续大阴线');
  const upperRejectionCount = previous20.filter((item) => {
    const candleBody = Math.abs(item.close - item.open);
    const shadow = item.high - Math.max(item.open, item.close);
    return item.close < item.open && shadow > Math.max(candleBody * 2, (item.high - item.low) * 0.35);
  }).length;
  addBonus(volatilityItems, '波动平稳、冲高回落不频繁', 3, upperRejectionCount <= 2, `近 20 日明显冲高回落 ${upperRejectionCount} 次`);
  addPenalty(volatilityItems, '近 20 日最大回撤超过 20%', 5, maxDrawdown20 > 0.2, `最大回撤 ${percent(maxDrawdown20)}`);
  const recentUnstable = hasConsecutiveLargeBearish && recent5.every((item) => item.close <= item.open || item.close < sma5);
  addPenalty(volatilityItems, '连续大阴线后未企稳', 6, recentUnstable, `连续大阴线且最近 5 日未站稳 MA5：${recentUnstable ? '是' : '否'}`);
  const volatility = section('volatility', '波动与回撤控制', 10, volatilityItems);

  const riskItems: SelectionScoreItem[] = [];
  const candleRange = latest.high - latest.low;
  const upperShadow = latest.high - Math.max(latest.open, latest.close);
  const body = Math.abs(latest.close - latest.open);
  const highUpperShadow = distanceToPreviousHigh < 0.08
    && latest.close < latest.open
    && upperShadow > Math.max(body * 2, candleRange * 0.35)
    && latestVolumeRatio >= 1.3;
  addPenalty(riskItems, '高位长上影放量回落', 6, highUpperShadow, `上影/实体 ${body > 0 ? round(upperShadow / body) : '—'}；量比 ${round(latestVolumeRatio)}`);
  const consecutiveHeavyDrop = candles.slice(-2).every((item, offset) => {
    const index = candles.length - 2 + offset;
    return dailyChanges[index] <= -0.025 && item.volume >= averageVolume20;
  });
  addPenalty(riskItems, '连续放量大跌', 8, consecutiveHeavyDrop, `最近 2 日均跌超 2.5% 且放量：${consecutiveHeavyDrop ? '是' : '否'}`);
  const below20And60 = candles.slice(-3).every((item) => item.close < sma20 && item.close < sma60);
  addPenalty(riskItems, '跌破 20 日线和 60 日线且未收回', 8, below20And60, `最近 3 日均低于 MA20 ${round(sma20)} 和 MA60 ${round(sma60)}`);
  const bearishAlignment = sma5 < sma10 && sma10 < sma20 && sma20 < sma60
    && sma5 < sma5Prev && sma10 < sma10Prev && sma60 < sma60Prev;
  addPenalty(riskItems, '均线明显空头排列', 10, bearishAlignment, `MA5 ${round(sma5)} < MA10 ${round(sma10)} < MA20 ${round(sma20)} < MA60 ${round(sma60)}`);
  addPenalty(riskItems, '短期连续大阴线且无企稳', 6, recentUnstable, `最近 10 日连续大阴线且未企稳：${recentUnstable ? '是' : '否'}`);
  const estimatedAmounts = candles.slice(-20).map((item) => item.volume * ((item.high + item.low + item.close) / 3) * 100);
  const averageAmountYuan = average(estimatedAmounts);
  const forcedCooling = averageAmountYuan < 10_000_000;
  addPenalty(riskItems, '日均成交额低于 3000 万', 5, averageAmountYuan < 30_000_000, `估算 20 日均额 ${round(averageAmountYuan / 100_000_000)} 亿`);
  riskItems.push({
    label: '日均成交额低于 1000 万，直接进入冷却池',
    points: 0,
    matched: forcedCooling,
    detail: `估算 20 日均额 ${round(averageAmountYuan / 100_000_000)} 亿`,
    kind: 'penalty',
  });
  const riskScore = riskItems.reduce((sum, item) => sum + item.points, 0);
  const risk: SelectionScoreSection = { key: 'risk', title: '风控倒扣项', score: riskScore, maxScore: null, items: riskItems };

  const positiveSections = [trend, momentum, volume, support, pattern, oscillator, volatility];
  const rawPositiveScore = positiveSections.reduce((sum, item) => sum + item.score, 0);
  const normalizedBaseScore = Math.round(rawPositiveScore / POSITIVE_SCORE_MAX * 100);
  const riskDeduction = Math.abs(riskScore);
  const score = Math.min(100, Math.max(0, normalizedBaseScore - riskDeduction));
  const tier = forcedCooling ? 'blocked' : tierFor(score);

  return {
    status: 'ready',
    score,
    tier,
    tierLabel: TIER_META[tier].label,
    tierDescription: forcedCooling
      ? '日均成交额低于 1000 万，按规则直接进入冷却池，20–40 个交易日后重新评分。'
      : TIER_META[tier].description,
    rawPositiveScore,
    normalizedBaseScore,
    riskDeduction,
    forcedCooling,
    sections: [...positiveSections, risk],
    asOf: latest.date,
    sampleSize: candles.length,
    assumptions: [
      '宽松版正向规则满分恰好为 100 分，风控项在技术面得分后直接扣减，最低为 0 分。',
      '历史 K 线未提供成交额，流动性使用成交量 × 典型价 × 100 股/手估算。',
      '“即将上穿、重要支撑、形态偏强、明显下跌”等描述采用固定阈值量化，便于复现。',
      '本模型用于宽松初筛，不等同于买入信号；冷却池建议 20–40 个交易日后重新评分。',
      benchmarkReturn20 == null ? '沪深 300 日 K 不足，相对强弱项不加分。' : `沪深 300 近 20 日收益为 ${percent(benchmarkReturn20)}。`,
    ],
  };
}
