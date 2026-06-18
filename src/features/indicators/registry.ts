import type { IndicatorDefinition } from '@/models';
import { calculateSMA } from './sma';
import { calculateEMA } from './ema';
import { calculateBOLL } from './boll';
import { calculateMACD } from './macd';
import { calculateRSI } from './rsi';
import { calculateKDJ } from './kdj';
import { calculateATR } from './atr';
import { calculateCCI } from './cci';
import { calculateWR } from './wr';
import { calculateOBV } from './obv';
import { calculateVolumeMA } from './volumeMa';

export const INDICATOR_REGISTRY: IndicatorDefinition[] = [
  {
    id: 'sma',
    name: 'SMA 简单移动平均',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#FF9800', key: 'sma', label: 'SMA' },
      ],
    },
  },
  {
    id: 'ema',
    name: 'EMA 指数移动平均',
    params: [
      { name: 'period', label: '周期', defaultValue: 20, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'overlay',
      series: [
        { type: 'line', color: '#2196F3', key: 'ema', label: 'EMA' },
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
      { name: 'period', label: '周期', defaultValue: 14, min: 2, max: 500, step: 1 },
    ],
    display: {
      pane: 'separate',
      series: [
        { type: 'line', color: '#9C27B0', key: 'rsi', label: 'RSI' },
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
        { type: 'line', color: '#FFC107', key: 'volumeMa', label: '量均线' },
      ],
    },
  },
];

export function getIndicatorById(id: string): IndicatorDefinition | undefined {
  return INDICATOR_REGISTRY.find(ind => ind.id === id);
}
