import type { StrategySignal } from '@/models';
import type { ChanAnalysis, ChanCenter, ChanCenterLevel } from './types';

export interface ChanTradingSignal extends StrategySignal {
  source: 'chan-v1';
  signalAtIndex: number;
  centerId: string;
  centerLevel: ChanCenterLevel;
}

function centerSignal(center: ChanCenter, analysis: ChanAnalysis): ChanTradingSignal | null {
  const signalAtIndex = center.completedAtIndex;
  if (
    center.status !== 'confirmed'
    || center.lifecycle !== 'completed'
    || center.breakoutDirection == null
    || signalAtIndex == null
    || center.completedAt == null
    || signalAtIndex >= analysis.sourceBars.length
  ) return null;

  const upward = center.breakoutDirection === 'up';
  return {
    time: analysis.sourceBars[signalAtIndex].time,
    action: upward ? 'buy' : 'sell',
    reason: `${center.level === 'pen' ? '笔' : '线段'}中枢确认${upward ? '向上' : '向下'}脱离 [${center.zd}, ${center.zg}]`,
    strength: 1,
    targetPosition: upward ? 1 : 0,
    source: 'chan-v1',
    signalAtIndex,
    centerId: center.id,
    centerLevel: center.level,
  };
}

/** 生成截至当前分析时点已经可知的中枢脱离信号。 */
export function generateChanCenterSignals(
  analysis: ChanAnalysis,
  level: ChanCenterLevel = 'pen',
): ChanTradingSignal[] {
  const centers = level === 'pen' ? analysis.penCenters : analysis.segmentCenters;
  return centers
    .map((center) => centerSignal(center, analysis))
    .filter((signal): signal is ChanTradingSignal => signal != null)
    .sort((left, right) => left.signalAtIndex - right.signalAtIndex);
}
