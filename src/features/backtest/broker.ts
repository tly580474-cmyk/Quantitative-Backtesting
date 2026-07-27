import type { Order, Trade, BacktestConfig } from '@/models';
import { roundTo } from '@/utils/number';
import {
  applySlippage,
  calculateCommission,
  calculateSellTax,
  normalizeStockBuyQuantity,
  normalizeStockSellQuantity,
} from '../../../shared/trading-rules/index.js';

export interface FillResult {
  trade: Trade;
  error?: string;
}

/**
 * Attempt to fill an order at the given candle's open price.
 * Returns the trade and any error message.
 */
export function fillOrder(
  order: Order,
  candleOpen: number,
  cash: number,
  positionQuantity: number,
  config: BacktestConfig,
): FillResult {
  if (!Number.isFinite(candleOpen) || candleOpen <= 0) {
    return {
      trade: createRejectedTrade(order, candleOpen, '开盘价无效'),
      error: '开盘价无效',
    };
  }

  if (order.side === 'buy') {
    return fillBuy(order, candleOpen, cash, config);
  } else {
    return fillSell(order, candleOpen, positionQuantity, config);
  }
}

function fillBuy(
  order: Order,
  open: number,
  cash: number,
  config: BacktestConfig,
): FillResult {
  const fillPrice = applySlippage(open, 'buy', config.slippageBps);
  const requestedSpend = order.quantity * fillPrice;
  const maxSpend = Math.min(
    cash * config.positionSizing.value,
    config.backtestMode === 'dca' ? config.dca.amount : Number.POSITIVE_INFINITY,
  );
  const unitMode = config.tradingUnitMode ?? 'index';

  if (unitMode === 'stock') {
    const lotSize = 100;
    const affordableQuantity = normalizeStockBuyQuantity(
      Math.min(order.quantity, maxSpend / fillPrice),
      lotSize,
    );

    if (affordableQuantity < lotSize) {
      return {
        trade: createRejectedTrade(order, fillPrice, '现金不足，无法购买一手（100 股）'),
        error: '现金不足',
      };
    }

    let quantity = affordableQuantity;
    let amount = quantity * fillPrice;
    let commission = calculateCommission(
      amount,
      config.commissionRate,
      config.minimumCommission,
    );
    while (quantity >= lotSize && amount + commission > cash) {
      quantity -= lotSize;
      amount = quantity * fillPrice;
      commission = calculateCommission(
        amount,
        config.commissionRate,
        config.minimumCommission,
      );
    }

    if (quantity < lotSize) {
      return {
        trade: createRejectedTrade(order, fillPrice, '扣除手续费后现金不足'),
        error: '现金不足',
      };
    }

    return createBuyFill(order, open, fillPrice, quantity, amount, commission);
  }

  const minimumTradeAmount = config.minimumTradeAmount ?? 1;

  // DCA uses the raw investment amount; skip the minimum trade constraint so
  // small scheduled contributions are not blocked.
  if (config.backtestMode === 'dca') {
    let amount = Math.min(requestedSpend, maxSpend);
    if (amount <= 0) {
      return {
        trade: createRejectedTrade(order, fillPrice, '定投金额不足'),
        error: '现金不足',
      };
    }
    let commission = calculateCommission(
      amount,
      config.commissionRate,
      config.minimumCommission,
    );
    if (amount + commission > cash) {
      amount = cash - commission;
      if (amount <= 0) {
        return {
          trade: createRejectedTrade(order, fillPrice, '扣除手续费后现金不足'),
          error: '现金不足',
        };
      }
      commission = calculateCommission(
        amount,
        config.commissionRate,
        config.minimumCommission,
      );
      if (amount + commission > cash) {
        amount = cash - commission;
      }
    }
    if (amount <= 0 || amount + commission > cash) {
      return {
        trade: createRejectedTrade(order, fillPrice, '扣除手续费后现金不足'),
        error: '现金不足',
      };
    }
    return createBuyFill(order, open, fillPrice, amount / fillPrice, amount, commission);
  }

  // Index ETF orders use a monetary trading unit. Convert the rounded
  // order amount back to a fractional index/ETF quantity for valuation.
  const maxAmount = Math.floor(maxSpend / minimumTradeAmount) * minimumTradeAmount;

  if (maxAmount < minimumTradeAmount) {
    return {
      trade: createRejectedTrade(order, fillPrice, '现金不足，无法达到最小交易金额'),
      error: '现金不足',
    };
  }

  let amount = Math.floor(
    Math.min(requestedSpend, maxAmount) / minimumTradeAmount,
  ) * minimumTradeAmount;
  let commission = calculateCommission(
    amount,
    config.commissionRate,
    config.minimumCommission,
  );

  // Check if we can afford it
  if (amount + commission > cash) {
    const affordableAmount = Math.floor(
      Math.min(
        cash - config.minimumCommission,
        cash / (1 + config.commissionRate),
      ) / minimumTradeAmount,
    ) * minimumTradeAmount;

    if (affordableAmount < minimumTradeAmount) {
      return {
        trade: createRejectedTrade(order, fillPrice, '扣除手续费后现金不足'),
        error: '现金不足',
      };
    }

    amount = Math.min(amount, affordableAmount);
    commission = calculateCommission(
      amount,
      config.commissionRate,
      config.minimumCommission,
    );
  }

  return createBuyFill(order, open, fillPrice, amount / fillPrice, amount, commission);
}

function createBuyFill(
  order: Order,
  open: number,
  fillPrice: number,
  quantity: number,
  amount: number,
  commission: number,
): FillResult {
  return {
    trade: {
      id: crypto.randomUUID(),
      orderId: order.id,
      time: order.executeTime,
      side: 'buy',
      quantity,
      rawPrice: open,
      fillPrice,
      commission: roundTo(commission, 4),
      tax: 0,
      slippageCost: roundTo(quantity * (fillPrice - open), 4),
      amount: roundTo(amount, 4),
    },
  };
}

function fillSell(
  order: Order,
  open: number,
  positionQuantity: number,
  config: BacktestConfig,
): FillResult {
  if (positionQuantity <= 0) {
    return {
      trade: createRejectedTrade(order, open, '无持仓'),
      error: '无持仓',
    };
  }

  const fillPrice = applySlippage(open, 'sell', config.slippageBps);
  const requestedQuantity = Math.min(order.quantity, positionQuantity);
  const quantity = config.tradingUnitMode === 'stock'
    ? normalizeStockSellQuantity(requestedQuantity, positionQuantity)
    : requestedQuantity;
  if (quantity <= 0) {
    return {
      trade: createRejectedTrade(order, fillPrice, '卖出数量不足一手（100 股）'),
      error: '卖出数量不足一手',
    };
  }
  const amount = quantity * fillPrice;
  const commission = calculateCommission(
    amount,
    config.commissionRate,
    config.minimumCommission,
  );
  const tax = calculateSellTax(amount, config.sellTaxRate);

  return {
    trade: {
      id: crypto.randomUUID(),
      orderId: order.id,
      time: order.executeTime,
      side: 'sell',
      quantity,
      rawPrice: open,
      fillPrice,
      commission: roundTo(commission, 4),
      tax: roundTo(tax, 4),
      slippageCost: roundTo(quantity * (open - fillPrice), 4),
      amount: roundTo(amount, 4),
    },
  };
}

function createRejectedTrade(order: Order, fillPrice: number, reason: string): Trade {
  return {
    id: crypto.randomUUID(),
    orderId: order.id,
    time: order.executeTime,
    side: order.side,
    quantity: 0,
    rawPrice: fillPrice,
    fillPrice,
    commission: 0,
    tax: 0,
    slippageCost: 0,
    amount: 0,
  };
}

/**
 * Update order status based on fill result.
 */
export function resolveOrder(order: Order, trade: Trade): Order {
  if (trade.quantity > 0) {
    return { ...order, status: 'filled', quantity: trade.quantity };
  }
  return {
    ...order,
    status: 'rejected',
    rejectReason: trade.quantity === 0 ? '无法成交' : '未知原因',
  };
}
