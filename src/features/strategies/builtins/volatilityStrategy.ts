import type { StrategyDefinition } from '../types';
import { calculateLatestVolatilityScore } from '../multiFactor';

interface VolatilityStrategyParams {
  zScoreWindow: number;
}

export const volatilityStrategy: StrategyDefinition<VolatilityStrategyParams> = {
  id: 'volatilityFactor',
  name: '波动率策略',
  version: '1.0.0',
  description: 'vol_5/10/20 经滚动 Z-score 标准化后按 50%/15%/35% 合成；正值持仓，非正值空仓',
  paramsSchema: [
    {
      name: 'zScoreWindow',
      label: 'Z-score 滚动窗口',
      type: 'number',
      defaultValue: 60,
      min: 20,
      max: 250,
      step: 1,
      description: '仅使用截至信号日的历史数据标准化',
    },
  ],
  defaultParams: { zScoreWindow: 60 },

  warmupBars(params) {
    return 20 + params.zScoreWindow;
  },

  evaluate({ candles, position }, params) {
    const time = candles[candles.length - 1].time;
    const score = calculateLatestVolatilityScore([...candles], params.zScoreWindow);
    if (score == null) return { time, action: 'hold', reason: '因子预热期' };

    if (score > 0 && position.quantity === 0) {
      return { time, action: 'buy', reason: `波动率综合 Z-score 为 ${score.toFixed(3)}，转为持仓`, strength: score };
    }
    if (score <= 0 && position.quantity > 0) {
      return { time, action: 'sell', reason: `波动率综合 Z-score 为 ${score.toFixed(3)}，转为空仓`, strength: Math.abs(score) };
    }
    return {
      time,
      action: 'hold',
      reason: `波动率综合 Z-score 为 ${score.toFixed(3)}，维持${position.quantity > 0 ? '持仓' : '空仓'}`,
      strength: Math.abs(score),
    };
  },
};
