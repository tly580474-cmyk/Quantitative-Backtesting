import type { StrategyDefinition } from '../types';
import {
  calculateLatestReversalScore,
  calculateLatestVolatilityScore,
} from '../multiFactor';

interface CompositeFactorStrategyParams {
  zScoreWindow: number;
  stopLossEnabled: boolean;
  stopLossPercent: number;
}

export const compositeFactorStrategy: StrategyDefinition<CompositeFactorStrategyParams> = {
  id: 'compositeFactor',
  name: '综合多因子策略',
  version: '1.0.0',
  description: '波动率综合 Z-score 与反转综合 Z-score 等权相加；默认启用持仓峰值回撤 15% 止损',
  paramsSchema: [
    {
      name: 'zScoreWindow',
      label: 'Z-score 滚动窗口',
      type: 'number',
      defaultValue: 60,
      min: 20,
      max: 250,
      step: 1,
    },
    {
      name: 'stopLossEnabled',
      label: '启用回撤止损',
      type: 'boolean',
      defaultValue: true,
      description: '以持仓以来的最高收盘价为基准',
    },
    {
      name: 'stopLossPercent',
      label: '止损回撤阈值（%）',
      type: 'number',
      defaultValue: 15,
      min: 1,
      max: 50,
      step: 1,
    },
  ],
  defaultParams: {
    zScoreWindow: 60,
    stopLossEnabled: true,
    stopLossPercent: 15,
  },

  warmupBars(params) {
    return 60 + params.zScoreWindow;
  },

  evaluate({ candles, position }, params) {
    const time = candles[candles.length - 1].time;

    if (params.stopLossEnabled && position.quantity > 0 && position.entryTime) {
      const entryIndex = candles.findIndex((candle) => candle.time >= position.entryTime!);
      if (entryIndex >= 0) {
        const peak = candles
          .slice(entryIndex)
          .reduce((highest, candle) => Math.max(highest, candle.close), 0);
        const drawdown = peak > 0 ? 1 - candles[candles.length - 1].close / peak : 0;
        if (drawdown >= params.stopLossPercent / 100) {
          return {
            time,
            action: 'sell',
            reason: `持仓回撤 ${(drawdown * 100).toFixed(2)}%，触发 ${params.stopLossPercent}% 止损`,
            strength: drawdown,
          };
        }
      }
    }

    const volatilityScore = calculateLatestVolatilityScore([...candles], params.zScoreWindow);
    const reversalScore = calculateLatestReversalScore([...candles], params.zScoreWindow);
    if (volatilityScore == null || reversalScore == null) {
      return { time, action: 'hold', reason: '因子预热期' };
    }

    const score = volatilityScore + reversalScore;
    const detail = `综合信号 ${score.toFixed(3)}（波动率 ${volatilityScore.toFixed(3)} + 反转 ${reversalScore.toFixed(3)}）`;
    if (score > 0 && position.quantity === 0) {
      return { time, action: 'buy', reason: `${detail}，转为持仓`, strength: score };
    }
    if (score <= 0 && position.quantity > 0) {
      return { time, action: 'sell', reason: `${detail}，转为空仓`, strength: Math.abs(score) };
    }
    return {
      time,
      action: 'hold',
      reason: `${detail}，维持${position.quantity > 0 ? '持仓' : '空仓'}`,
      strength: Math.abs(score),
    };
  },
};
