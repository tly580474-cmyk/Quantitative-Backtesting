import type { StoredMacroObservation } from '../macroRepository.js';
import type { MarketHealthSnapshotInput } from '../types.js';
import { robustGoodScore } from './scoring.js';

const MIN_HISTORY_MONTHS = 36;
const MAX_HISTORY_MONTHS = 60;

export function calculateLatestNominalEarningsCycle(
  observations: StoredMacroObservation[],
  calculatedAt = new Date(),
): MarketHealthSnapshotInput | null {
  const ordered = [...observations]
    .filter((item) => item.seriesKey === 'ppi_yoy' && Number.isFinite(item.value))
    .sort((left, right) => left.observationPeriod.localeCompare(right.observationPeriod));
  if (ordered.length < MIN_HISTORY_MONTHS + 3 + 1) return null;
  const currentIndex = ordered.length - 1;
  const current = ordered[currentIndex];
  const currentChange = current.value - ordered[currentIndex - 3].value;
  const historyStart = Math.max(3, currentIndex - MAX_HISTORY_MONTHS);
  const levelHistory = ordered.slice(historyStart, currentIndex).map((item) => item.value);
  const changeHistory = ordered.slice(historyStart, currentIndex).map((item, relativeIndex) => {
    const absoluteIndex = historyStart + relativeIndex;
    return item.value - ordered[absoluteIndex - 3].value;
  });
  if (levelHistory.length < MIN_HISTORY_MONTHS) return null;
  const levelScore = robustGoodScore(current.value, levelHistory);
  const changeScore = robustGoodScore(currentChange, changeHistory);
  if (levelScore == null || changeScore == null) return null;
  const score = 0.6 * levelScore + 0.4 * changeScore;
  const status = nominalCycleStatus(score);
  const staleAfter = new Date(current.availableAt);
  staleAfter.setUTCDate(staleAfter.getUTCDate() + 50);
  return {
    indicatorKey: 'nec',
    asOfDate: current.observationPeriod,
    periodKey: current.observationPeriod.slice(0, 7),
    score,
    statusLabel: status.label,
    interpretation: status.interpretation,
    direction: 'cycle_strength',
    frequency: 'monthly',
    modelVersion: 'nec-v1',
    components: [
      {
        key: 'ppi_level', label: 'PPI同比', value: current.value, score: levelScore, weight: 0.6,
        source: 'macro', description: '工业生产者出厂价格同比，反映名义需求和价格环境。',
      },
      {
        key: 'ppi_change_3m', label: 'PPI三个月变化', value: currentChange, score: changeScore, weight: 0.4,
        source: 'macro', description: '当前PPI同比相对三个月前的变化。',
      },
    ],
    sourcePeriods: {
      ppiObservationMonth: current.observationPeriod,
      ppiRevision: current.revisionNo,
      ppiAvailableAt: current.availableAt,
      sourceChecksum: current.sourceChecksum,
    },
    coveragePct: 100,
    sourceSnapshotId: null,
    calculatedAt: calculatedAt.toISOString(),
    publicationStatus: 'published',
    staleAfter: staleAfter.toISOString(),
  };
}

function nominalCycleStatus(score: number): { label: string; interpretation: string } {
  if (score >= 80) return { label: '名义周期偏强', interpretation: '价格与名义需求处于历史高位，盈利环境可能改善，但也需警惕周期后段和估值透支。' };
  if (score >= 60) return { label: '名义周期回升', interpretation: 'PPI水平或变化正在改善，可作为后续盈利方向的宏观确认。' };
  if (score >= 40) return { label: '名义周期中性', interpretation: '价格环境接近自身历史中枢，暂未形成明显扩张或收缩信号。' };
  if (score >= 20) return { label: '名义周期偏弱', interpretation: '价格和名义需求偏弱，企业盈利修复可能缺少宏观支持。' };
  return { label: '名义周期收缩', interpretation: 'PPI处于显著弱势区间，需关注通缩压力和盈利下修风险。' };
}
