import { calculateSMA } from '@/features/indicators/sma';
import type { StrategyDefinition } from '../types';

interface SmaCrossParams {
  period: number;
}

export const smaCrossStrategy: StrategyDefinition<SmaCrossParams> = {
  id: 'smaCross',
  name: 'SMA 价格穿越',
  version: '1.0.0',
  description: '收盘价上穿 SMA 买入，下穿 SMA 卖出',
  paramsSchema: [
    {
      name: 'period',
      label: 'SMA 周期',
      type: 'number',
      defaultValue: 30,
      min: 2,
      max: 500,
      step: 1,
      description: '均线的计算周期',
    },
  ],
  defaultParams: {
    period: 30,
  },

  warmupBars(params) {
    return params.period;
  },

  evaluate(context, params) {
    const { index, candles, position } = context;
    const { period } = params;

    if (index < period - 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    if (index < 1) {
      return { time: candles[index].time, action: 'hold', reason: '数据不足' };
    }

    const sma = calculateSMA(candles.slice(0, index + 1), { period });

    const currClose = candles[index].close;
    const prevClose = candles[index - 1].close;
    const currSma = sma[index];
    const prevSma = sma[index - 1];

    if (currSma == null || prevSma == null) {
      return { time: candles[index].time, action: 'hold', reason: '指标计算中' };
    }

    // Buy: close crosses above SMA
    if (prevClose <= prevSma && currClose > currSma) {
      if (position.quantity > 0) {
        return { time: candles[index].time, action: 'hold', reason: '已持仓，忽略买入信号' };
      }
      return { time: candles[index].time, action: 'buy', reason: `收盘价上穿 SMA${period} (${currClose.toFixed(2)} > ${currSma.toFixed(2)})`, strength: currClose - currSma };
    }

    // Sell: close crosses below SMA
    if (prevClose >= prevSma && currClose < currSma) {
      if (position.quantity === 0) {
        return { time: candles[index].time, action: 'hold', reason: '无持仓，忽略卖出信号' };
      }
      return { time: candles[index].time, action: 'sell', reason: `收盘价下穿 SMA${period} (${currClose.toFixed(2)} < ${currSma.toFixed(2)})`, strength: currSma - currClose };
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  },
};
