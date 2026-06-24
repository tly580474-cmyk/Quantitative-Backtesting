import type { Candle, BacktestConfig } from '@/models';

export interface ValidationError {
  field: string;
  message: string;
}

export function validateBacktestInput(
  candles: Candle[],
  config: BacktestConfig,
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!candles || candles.length < 2) {
    errors.push({ field: 'candles', message: '至少需要 2 根 K 线' });
  }

  // Verify candles are sorted by time ascending
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].time < candles[i - 1].time) {
      errors.push({ field: 'candles', message: `K 线时间乱序：第 ${i + 1} 行` });
      break;
    }
    if (candles[i].time === candles[i - 1].time) {
      errors.push({ field: 'candles', message: `K 线时间重复：${candles[i].time}` });
      break;
    }
  }

  // Validate K-line data
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!Number.isFinite(c.open) || c.open <= 0) {
      errors.push({ field: 'candles', message: `第 ${i + 1} 行开盘价无效` });
      break;
    }
    if (!Number.isFinite(c.close) || c.close <= 0) {
      errors.push({ field: 'candles', message: `第 ${i + 1} 行收盘价无效` });
      break;
    }
    if (!Number.isFinite(c.high) || c.high <= 0) {
      errors.push({ field: 'candles', message: `第 ${i + 1} 行最高价无效` });
      break;
    }
    if (!Number.isFinite(c.low) || c.low <= 0) {
      errors.push({ field: 'candles', message: `第 ${i + 1} 行最低价无效` });
      break;
    }
  }

  if (!Number.isFinite(config.initialCapital) || config.initialCapital <= 0) {
    errors.push({ field: 'initialCapital', message: '初始资金必须大于 0' });
  }

  if (!['strategy', 'dca'].includes(config.backtestMode)) {
    errors.push({ field: 'backtestMode', message: '回测模式无效' });
  }

  if (!Number.isInteger(config.tradingDays) || config.tradingDays < 0) {
    errors.push({ field: 'tradingDays', message: '交易天数必须为非负整数' });
  }

  if (!['stock', 'index'].includes(config.tradingUnitMode)) {
    errors.push({ field: 'tradingUnitMode', message: '交易单位模式无效' });
  }

  if (config.backtestMode === 'dca') {
    if (!Number.isFinite(config.dca.amount) || config.dca.amount <= 0) {
      errors.push({ field: 'dca.amount', message: '定投金额必须大于 0' });
    }
    if (!['daily', 'weekly', 'monthly'].includes(config.dca.frequency)) {
      errors.push({ field: 'dca.frequency', message: '定投频率无效' });
    }
  }

  if (config.positionSizing.type !== 'percent') {
    errors.push({ field: 'positionSizing', message: '仅支持按比例仓位' });
  } else if (config.positionSizing.value <= 0 || config.positionSizing.value > 1) {
    errors.push({ field: 'positionSizing', message: '单次调仓比例应在 (0, 1] 范围内' });
  }

  if (!Number.isFinite(config.commissionRate) || config.commissionRate < 0) {
    errors.push({ field: 'commissionRate', message: '手续费率不能为负' });
  }

  if (!Number.isFinite(config.minimumCommission) || config.minimumCommission < 0) {
    errors.push({ field: 'minimumCommission', message: '最低手续费不能为负' });
  }

  if (!Number.isFinite(config.sellTaxRate) || config.sellTaxRate < 0) {
    errors.push({ field: 'sellTaxRate', message: '印花税率不能为负' });
  }

  if (!Number.isFinite(config.slippageBps) || config.slippageBps < 0) {
    errors.push({ field: 'slippageBps', message: '滑点不能为负' });
  }

  if (!Number.isFinite(config.minimumTradeAmount) || config.minimumTradeAmount <= 0) {
    errors.push({ field: 'minimumTradeAmount', message: '最小交易金额必须大于 0' });
  }

  return errors;
}
