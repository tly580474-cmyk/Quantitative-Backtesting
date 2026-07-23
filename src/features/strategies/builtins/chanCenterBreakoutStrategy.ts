import { analyzeChanlun, generateChanCenterSignals, type ChanCenterLevel } from '@/features/chanlun';
import type { StrategyDefinition } from '../types';

interface ChanCenterBreakoutParams {
  level: ChanCenterLevel;
}

export const chanCenterBreakoutStrategy: StrategyDefinition<ChanCenterBreakoutParams> = {
  id: 'chanCenterBreakout',
  name: '缠论中枢脱离',
  version: '1.0.0',
  description: '仅在已确认的笔/线段中枢被已确认结构完全脱离时发出信号，按下一根 K 线执行',
  paramsSchema: [
    {
      name: 'level',
      label: '中枢级别',
      type: 'select',
      defaultValue: 'pen',
      options: [
        { label: '笔中枢', value: 'pen' },
        { label: '线段中枢', value: 'segment' },
      ],
    },
  ],
  defaultParams: { level: 'pen' },

  warmupBars() {
    return 7;
  },

  evaluate({ candles }, params) {
    const time = candles[candles.length - 1].time;
    const analysis = analyzeChanlun(candles);
    const currentIndex = candles.length - 1;
    const signal = generateChanCenterSignals(analysis, params.level)
      .find((candidate) => candidate.signalAtIndex === currentIndex);
    return signal ?? {
      time,
      action: 'hold',
      reason: `等待已确认${params.level === 'pen' ? '笔' : '线段'}中枢脱离`,
    };
  },
};
