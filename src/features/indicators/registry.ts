import type { IndicatorDefinition } from '@/models';

export const INDICATOR_REGISTRY: IndicatorDefinition[] = [
  {
    id: 'sma',
    name: 'SMA 简单移动平均',
    params: [
      { name: 'period1', label: '周期 1', defaultValue: 5, min: 0, max: 500, step: 1 },
      { name: 'period2', label: '周期 2', defaultValue: 10, min: 0, max: 500, step: 1 },
      { name: 'period3', label: '周期 3', defaultValue: 20, min: 0, max: 500, step: 1 },
      { name: 'period4', label: '周期 4', defaultValue: 60, min: 0, max: 500, step: 1 },
      { name: 'period5', label: '周期 5', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period6', label: '周期 6', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period7', label: '周期 7', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period8', label: '周期 8', defaultValue: 0, min: 0, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#FF9800', key: 'sma1', label: 'SMA' },
        { type: 'line', color: '#9C27B0', key: 'sma2', label: 'SMA' },
        { type: 'line', color: '#00BCD4', key: 'sma3', label: 'SMA' },
        { type: 'line', color: '#E91E63', key: 'sma4', label: 'SMA' },
        { type: 'line', color: '#3F51B5', key: 'sma5', label: 'SMA' },
        { type: 'line', color: '#009688', key: 'sma6', label: 'SMA' },
        { type: 'line', color: '#FF5722', key: 'sma7', label: 'SMA' },
        { type: 'line', color: '#8BC34A', key: 'sma8', label: 'SMA' },
      ],
    },
  },
  {
    id: 'ema',
    name: 'EMA 指数移动平均',
    params: [
      { name: 'period1', label: '周期 1', defaultValue: 5, min: 0, max: 500, step: 1 },
      { name: 'period2', label: '周期 2', defaultValue: 10, min: 0, max: 500, step: 1 },
      { name: 'period3', label: '周期 3', defaultValue: 20, min: 0, max: 500, step: 1 },
      { name: 'period4', label: '周期 4', defaultValue: 60, min: 0, max: 500, step: 1 },
      { name: 'period5', label: '周期 5', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period6', label: '周期 6', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period7', label: '周期 7', defaultValue: 0, min: 0, max: 500, step: 1 },
      { name: 'period8', label: '周期 8', defaultValue: 0, min: 0, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#2196F3', key: 'ema1', label: 'EMA' },
        { type: 'line', color: '#4CAF50', key: 'ema2', label: 'EMA' },
        { type: 'line', color: '#795548', key: 'ema3', label: 'EMA' },
        { type: 'line', color: '#607D8B', key: 'ema4', label: 'EMA' },
        { type: 'line', color: '#673AB7', key: 'ema5', label: 'EMA' },
        { type: 'line', color: '#009688', key: 'ema6', label: 'EMA' },
        { type: 'line', color: '#CDDC39', key: 'ema7', label: 'EMA' },
        { type: 'line', color: '#FF5722', key: 'ema8', label: 'EMA' },
      ],
    },
  },
  {
    id: 'boll',
    name: 'BOLL 布林带',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
      { name: 'stdDev', label: '标准差倍数', defaultValue: 2, min: 0.5, max: 5, step: 0.1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#FF5722', key: 'upper', label: '上轨' },
        { type: 'line', color: '#4CAF50', key: 'middle', label: '中轨' },
        { type: 'line', color: '#FF5722', key: 'lower', label: '下轨' },
      ],
    },
  },
  {
    id: 'macd',
    name: 'MACD 指数平滑异同',
    params: [
      { name: 'fast', label: '快线周期', defaultValue: 12, min: 2, max: 500, step: 1 },
      { name: 'slow', label: '慢线周期', defaultValue: 26, min: 2, max: 500, step: 1 },
      { name: 'signal', label: '信号线周期', defaultValue: 9, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#2196F3', key: 'dif', label: 'DIF' },
        { type: 'line', color: '#FF9800', key: 'dea', label: 'DEA' },
        { type: 'histogram', color: '#FF5722', key: 'histogram', label: '柱' },
      ],
    },
  },
  {
    id: 'rsi',
    name: 'RSI 相对强弱',
    params: [
      { name: 'period1', label: 'RSI1 周期', defaultValue: 6, min: 2, max: 500, step: 1 },
      { name: 'period2', label: 'RSI2 周期', defaultValue: 12, min: 2, max: 500, step: 1 },
      { name: 'period3', label: 'RSI3 周期', defaultValue: 24, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#7C3AED', key: 'rsi1', label: 'RSI1' },
        { type: 'line', color: '#2563EB', key: 'rsi2', label: 'RSI2' },
        { type: 'line', color: '#D97706', key: 'rsi3', label: 'RSI3' },
      ],
    },
  },
  {
    id: 'kdj',
    name: 'KDJ 随机指标',
    params: [
      { name: 'n', label: 'RSV 周期', defaultValue: 9, min: 2, max: 500, step: 1 },
      { name: 'm1', label: 'K 平滑', defaultValue: 3, min: 2, max: 100, step: 1 },
      { name: 'm2', label: 'D 平滑', defaultValue: 3, min: 2, max: 100, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#2196F3', key: 'k', label: 'K' },
        { type: 'line', color: '#FF9800', key: 'd', label: 'D' },
        { type: 'line', color: '#9C27B0', key: 'j', label: 'J' },
      ],
    },
  },
  {
    id: 'atr',
    name: 'ATR 平均真实波幅',
    params: [
      { name: 'period', label: '周期', defaultValue: 14, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#E91E63', key: 'atr', label: 'ATR' },
      ],
    },
  },
  {
    id: 'cci',
    name: 'CCI 商品通道',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#00BCD4', key: 'cci', label: 'CCI' },
      ],
    },
  },
  {
    id: 'wr',
    name: 'WR 威廉指标',
    params: [
      { name: 'period', label: '周期', defaultValue: 10, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#795548', key: 'wr', label: 'WR' },
      ],
    },
  },
  {
    id: 'obv',
    name: 'OBV 能量潮',
    params: [],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#607D8B', key: 'obv', label: 'OBV' },
      ],
    },
  },
  {
    id: 'volumeMa',
    name: '成交量均线',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        {
          type: 'line',
          color: '#FFC107',
          key: 'volumeMa',
          label: '量均线',
          priceScale: 'volume',
        },
      ],
    },
  },
  {
    id: 'volume',
    name: '成交量',
    params: [
      { name: 'period', label: '均量周期', defaultValue: 20, min: 1, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'histogram', color: '#64748B', key: 'volume', label: '成交量' },
        { type: 'line', color: '#F59E0B', key: 'volumeAverage', label: '平均成交量' },
        { type: 'line', color: '#2563EB', key: 'volumeRatio', label: '量比' },
      ],
    },
  },
  {
    id: 'highLowBreakout',
    name: '高低点突破',
    params: [
      { name: 'period', label: '回看周期', defaultValue: 20, min: 1, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#DC2626', key: 'previousHigh', label: '前期高点' },
        { type: 'line', color: '#16A34A', key: 'previousLow', label: '前期低点' },
      ],
    },
  },
  {
    id: 'drawdown',
    name: '回撤',
    params: [
      { name: 'period', label: '峰值周期', defaultValue: 60, min: 1, max: 1000, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#94A3B8', key: 'peak', label: '区间峰值' },
        { type: 'line', color: '#DC2626', key: 'drawdown', label: '回撤率' },
      ],
    },
  },
  {
    id: 'bias',
    name: 'BIAS 均线乖离率',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#F97316', key: 'bias', label: 'BIAS' },
      ],
    },
  },
  {
    id: 'volatility',
    name: '波动率',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#2563EB', key: 'volatility', label: '波动率' },
        { type: 'line', color: '#DC2626', key: 'annualVolatility', label: '年化波动率' },
      ],
    },
  },
  {
    id: 'volCluster',
    name: '波动聚集',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#7C3AED', key: 'volCluster', label: '波动聚集' },
      ],
    },
  },
  {
    id: 'hold',
    name: 'HOLD 买入持有收益',
    params: [],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#059669', key: 'holdReturn', label: 'HOLD收益' },
        { type: 'line', color: '#0F766E', key: 'holdNav', label: 'HOLD净值' },
      ],
    },
  },
  {
    id: 'reversal',
    name: '反转因子',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 1, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#DB2777', key: 'reversal', label: '反转' },
      ],
    },
  },
];

export function getIndicatorById(id: string): IndicatorDefinition | undefined {
  return INDICATOR_REGISTRY.find(ind => ind.id === id);
}
