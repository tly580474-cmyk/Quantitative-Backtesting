import type { Order, Trade, BacktestConfig } from '@/models';
import { roundTo } from '@/utils/number';

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

  const slippageFactor = config.slippageBps / 10000;

  if (order.side === 'buy') {
    return fillBuy(order, candleOpen, cash, slippageFactor, config);
  } else {
    return fillSell(order, candleOpen, positionQuantity, slippageFactor, config);
  }
}

function fillBuy(
  order: Order,
  open: number,
  cash: number,
  slippageFactor: number,
  config: BacktestConfig,
): FillResult {
  const fillPrice = open * (1 + slippageFactor);
  const maxSpend = cash * config.positionSizing.value;

  // Maximum quantity we can buy (rounded down to lot size)
  const maxQty = Math.floor(maxSpend / fillPrice / config.lotSize) * config.lotSize;

  if (maxQty < config.lotSize) {
    return {
      trade: createRejectedTrade(order, fillPrice, '现金不足，无法买入最小手数'),
      error: '现金不足',
    };
  }

  const quantity = Math.min(order.quantity, maxQty);
  const amount = quantity * fillPrice;
  const commission = Math.max(amount * config.commissionRate, config.minimumCommission);

  // Check if we can afford it
  if (amount + commission > cash) {
    // Reduce quantity
    const affordableQty = Math.floor((cash - commission) / fillPrice / config.lotSize) * config.lotSize;
    if (affordableQty < config.lotSize) {
      return {
        trade: createRejectedTrade(order, fillPrice, '扣除手续费后现金不足'),
        error: '现金不足',
      };
    }
    // Recalculate with affordable quantity
    const adjQty = Math.min(order.quantity, affordableQty);
    const adjAmount = adjQty * fillPrice;
    const adjCommission = Math.max(adjAmount * config.commissionRate, config.minimumCommission);

    return {
      trade: {
        id: crypto.randomUUID(),
        orderId: order.id,
        time: order.executeTime,
        side: 'buy',
        quantity: adjQty,
        rawPrice: open,
        fillPrice,
        commission: roundTo(adjCommission, 4),
        tax: 0,
        slippageCost: roundTo(adjQty * (fillPrice - open), 4),
        amount: roundTo(adjAmount, 4),
      },
    };
  }

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
  slippageFactor: number,
  config: BacktestConfig,
): FillResult {
  if (positionQuantity <= 0) {
    return {
      trade: createRejectedTrade(order, open, '无持仓'),
      error: '无持仓',
    };
  }

  const fillPrice = open * (1 - slippageFactor);
  const quantity = Math.min(order.quantity, positionQuantity);
  const amount = quantity * fillPrice;
  const commission = Math.max(amount * config.commissionRate, config.minimumCommission);
  const tax = amount * config.sellTaxRate;

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
