import { calculateBOLL } from '@/features/indicators/boll';
import type { StrategyDefinition } from '../types';

interface BollStrategyParams {
  period: number;
  stdDev: number;
}

export const bollStrategy: StrategyDefinition<BollStrategyParams> = {
  id: 'boll',
  name: 'BOLL 布林带回归',
  version: '1.0.0',
  description: '收盘价突破下轨后向上回归买入，触及中轨或上轨卖出',
  paramsSchema: [
    {
      name: 'period',
      label: 'BOLL 周期',
      type: 'number',
      defaultValue: 20,
      min: 2,
      max: 500,
      step: 1,
    },
    {
      name: 'stdDev',
      label: '标准差倍数',
      type: 'number',
      defaultValue: 2,
      min: 0.5,
      max: 5,
      step: 0.1,
    },
  ],
  defaultParams: {
    period: 20,
    stdDev: 2,
  },

  warmupBars(params) {
    return params.period;
  },

  evaluate(context, params) {
    const { index, candles, position } = context;
    const { period, stdDev } = params;

    if (index < period - 1) {
      return { time: candles[index].time, action: 'hold', reason: '预热期' };
    }

    if (index < 1) {
      return { time: candles[index].time, action: 'hold', reason: '数据不足' };
    }

    const { upper, middle, lower } = calculateBOLL(candles.slice(0, index + 1), { period, stdDev });

    const currClose = candles[index].close;
    const prevClose = candles[index - 1].close;
    const currLower = lower[index];
    const prevLower = lower[index - 1];
    const currMiddle = middle[index];
    const currUpper = upper[index];

    if (currLower == null || prevLower == null || currMiddle == null || currUpper == null) {
      return { time: candles[index].time, action: 'hold', reason: '指标计算中' };
    }

    // Buy: close was below lower band and now crosses back above it
    if (prevClose <= prevLower && currClose > currLower) {
      if (position.quantity > 0) {
        return { time: candles[index].time, action: 'hold', reason: '已持仓，忽略买入信号' };
      }
      return { time: candles[index].time, action: 'buy', reason: `收盘价回归下轨上方 (${currClose.toFixed(2)} > ${currLower.toFixed(2)})`, strength: currClose - currLower };
    }

    // Sell: close reaches middle or upper band
    if (position.quantity > 0) {
      if (currClose >= currUpper) {
        return { time: candles[index].time, action: 'sell', reason: `收盘价触及上轨 (${currClose.toFixed(2)} >= ${currUpper.toFixed(2)})`, strength: currClose - currUpper };
      }
      if (currClose >= currMiddle && prevClose < currMiddle) {
        return { time: candles[index].time, action: 'sell', reason: `收盘价触及中轨 (${currClose.toFixed(2)} >= ${currMiddle.toFixed(2)})`, strength: 0 };
      }
    }

    return { time: candles[index].time, action: 'hold', reason: '' };
  },
};
