import { calculateRSI } from '@/features/indicators/rsi';
import type { StrategyDefinition } from '../types';

interface RsiStrategyParams {
  period: number;
  oversold: number;
  overbought: number;
}

export const rsiStrategy: StrategyDefinition<RsiStrategyParams> = {
  id: 'rsi',
  name: 'RSI 超买超卖',
  version: '1.0.0',
  description: 'RSI 进入超卖区后向上穿越阈值买入，进入超买区后向下穿越阈值卖出',
  paramsSchema: [
    {
      name: 'period',
      label: 'RSI 周期',
      type: 'number',
      defaultValue: 14,
      min: 2,
      max: 500,
      step: 1,
    },
    {
      name: 'oversold',
      label: '超卖阈值',
      type: 'number',
      defaultValue: 30,
      min: 1,
      max: 50,
      step: 1,
    },
    {
      name: 'overbought',
      label: '超买阈值',
      type: 'number',
      defaultValue: 70,
      min: 50,
      max: 99,
      step: 1,
    },
  ],
  defaultParams: {
    period: 14,
    oversold: 30,
    overbought: 70,
  },

  warmupBars(params) {
    return params.period + 1;
  },

  evaluate(context, params) {
    const { index, candles, position } = context;
    const { period, oversold, overbought } = params;

    if (index < period + 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    if (index < 1) {
      return { time: candles[index].time, action: 'hold', reason: '数据不足' };
    }

    const rsi = calculateRSI(candles.slice(0, index + 1), { period });

    const currRsi = rsi[index];
    const prevRsi = rsi[index - 1];

    if (currRsi == null || prevRsi == null) {
      return { time: candles[index].time, action: 'hold', reason: '指标计算中' };
    }

    // Buy: RSI was <= oversold and now crosses above it
    if (prevRsi <= oversold && currRsi > oversold) {
      if (position.quantity > 0) {
        return { time: candles[index].time, action: 'hold', reason: '已持仓，忽略买入信号' };
      }
      return { time: candles[index].time, action: 'buy', reason: `RSI 上穿超卖线 (${currRsi.toFixed(1)} > ${oversold})`, strength: currRsi - oversold };
    }

    // Sell: RSI was >= overbought and now crosses below it
    if (prevRsi >= overbought && currRsi < overbought) {
      if (position.quantity === 0) {
        return { time: candles[index].time, action: 'hold', reason: '无持仓，忽略卖出信号' };
      }
      return { time: candles[index].time, action: 'sell', reason: `RSI 下穿超买线 (${currRsi.toFixed(1)} < ${overbought})`, strength: overbought - currRsi };
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  },
};
