import type { ChanAnalysis, ChanCenterLevel, ChanPen, ChanSegment } from './types';

type ChanComponent = ChanPen | ChanSegment;

export interface ChanThirdBuySignal {
  source: 'chan-v1-third-buy';
  centerId: string;
  centerLevel: ChanCenterLevel;
  signalAtIndex: number;
  time: string;
  zg: number;
  zd: number;
  departureComponentId: string;
  retestComponentId: string;
  departureHigh: number;
  retestLow: number;
  retestBufferPct: number;
  breakoutPct: number;
}

function confirmed(component: ChanComponent | undefined): component is ChanComponent {
  return component?.status === 'confirmed'
    && component.confirmedAtIndex != null
    && component.confirmedAt != null;
}

function componentHigh(component: ChanComponent): number {
  return Math.max(component.startPrice, component.endPrice);
}

function componentLow(component: ChanComponent): number {
  return Math.min(component.startPrice, component.endPrice);
}

/**
 * 严格第三类买点（工程口径）：
 * 1. 已确认中枢被已确认同级结构向上完全脱离；
 * 2. 紧随其后的第一段已确认反向结构作为首次回试；
 * 3. 回试最低点严格高于中枢 ZG；
 * 4. 信号只在回试结构确认时可见。
 */
export function generateChanThirdBuySignals(
  analysis: ChanAnalysis,
  level: ChanCenterLevel = 'pen',
): ChanThirdBuySignal[] {
  const centers = level === 'pen' ? analysis.penCenters : analysis.segmentCenters;
  const components: readonly ChanComponent[] = level === 'pen'
    ? analysis.pens
    : analysis.segments;
  const signals: ChanThirdBuySignal[] = [];

  for (const center of centers) {
    if (
      center.status !== 'confirmed'
      || center.lifecycle !== 'completed'
      || center.breakoutDirection !== 'up'
      || center.completedAtIndex == null
    ) continue;

    const completionIndex = center.endComponentIndex + 1;
    const completion = components[completionIndex];
    if (!confirmed(completion) || completion.confirmedAtIndex !== center.completedAtIndex) continue;

    // 正常连续笔中，向上离开笔从中枢内部起步，仍与核心区有重叠；
    // 下一根完全位于 ZG 上方的向下笔才是首次回试，也是完成中枢的结构。
    // 若极端跳空使向上结构本身直接完成中枢，则再等待其后一根向下回试。
    const departureIndex = completion.direction === 'down'
      ? completionIndex - 1
      : completionIndex;
    const retestIndex = completion.direction === 'down'
      ? completionIndex
      : completionIndex + 1;
    const departure = components[departureIndex];
    const retest = components[retestIndex];
    if (
      !confirmed(departure)
      || !confirmed(retest)
      || departure.direction !== 'up'
      || retest.direction !== 'down'
      || componentHigh(departure) <= center.zg
    ) continue;

    const retestLow = componentLow(retest);
    const retestConfirmedAt = retest.confirmedAtIndex;
    if (
      retestConfirmedAt == null
      || retestLow <= center.zg
      || retestConfirmedAt >= analysis.sourceBars.length
    ) continue;

    signals.push({
      source: 'chan-v1-third-buy',
      centerId: center.id,
      centerLevel: level,
      signalAtIndex: retestConfirmedAt,
      time: analysis.sourceBars[retestConfirmedAt].time,
      zg: center.zg,
      zd: center.zd,
      departureComponentId: departure.id,
      retestComponentId: retest.id,
      departureHigh: componentHigh(departure),
      retestLow,
      retestBufferPct: (retestLow / center.zg - 1) * 100,
      breakoutPct: (componentHigh(departure) / center.zg - 1) * 100,
    });
  }

  return signals.sort((left, right) =>
    left.signalAtIndex - right.signalAtIndex
    || left.retestBufferPct - right.retestBufferPct
    || right.breakoutPct - left.breakoutPct);
}
