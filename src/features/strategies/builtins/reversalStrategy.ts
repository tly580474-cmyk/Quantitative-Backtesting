import type { StrategyDefinition } from '../types';
import { calculateLatestReversalScore } from '../multiFactor';

interface ReversalStrategyParams {
  zScoreWindow: number;
}

export const reversalStrategy: StrategyDefinition<ReversalStrategyParams> = {
  id: 'reversalFactor',
  name: '反转策略',
  version: '1.0.0',
  description: '均线偏离、动量、RSI、BOLL、MACD 共九个因子取反并滚动标准化后加权合成',
  paramsSchema: [
    {
      name: 'zScoreWindow',
      label: 'Z-score 滚动窗口',
      type: 'number',
      defaultValue: 60,
      min: 20,
      max: 250,
      step: 1,
      description: '多个因子同时提示超跌时，合成信号更强',
    },
  ],
  defaultParams: { zScoreWindow: 60 },

  warmupBars(params) {
    return 60 + params.zScoreWindow;
  },

  evaluate({ candles, position }, params) {
    const time = candles[candles.length - 1].time;
    const score = calculateLatestReversalScore([...candles], params.zScoreWindow);
    if (score == null) return { time, action: 'hold', reason: '因子预热期' };

    if (score > 0 && position.quantity === 0) {
      return { time, action: 'buy', reason: `反转综合 Z-score 为 ${score.toFixed(3)}，转为持仓`, strength: score };
    }
    if (score <= 0 && position.quantity > 0) {
      return { time, action: 'sell', reason: `反转综合 Z-score 为 ${score.toFixed(3)}，转为空仓`, strength: Math.abs(score) };
    }
    return {
      time,
      action: 'hold',
      reason: `反转综合 Z-score 为 ${score.toFixed(3)}，维持${position.quantity > 0 ? '持仓' : '空仓'}`,
      strength: Math.abs(score),
    };
  },
};
