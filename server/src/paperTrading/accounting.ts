import {
  calculateCommission,
  calculateSellTax,
  roundMoney,
} from '../../../shared/trading-rules/index.js';

export interface PaperFeeConfig {
  commissionRate: number;
  minimumCommission: number;
  sellTaxRate: number;
}

export function calculateBuyReservation(
  quantity: number,
  estimatedPrice: number,
  fees: PaperFeeConfig,
) {
  const amount = roundMoney(quantity * estimatedPrice);
  const commission = calculateCommission(
    amount,
    fees.commissionRate,
    fees.minimumCommission,
  );
  return {
    amount,
    commission,
    frozenCash: roundMoney(amount + commission),
  };
}

export function calculateBuySettlement(
  quantity: number,
  fillPrice: number,
  fees: PaperFeeConfig,
) {
  const amount = roundMoney(quantity * fillPrice);
  const commission = calculateCommission(
    amount,
    fees.commissionRate,
    fees.minimumCommission,
  );
  return {
    amount,
    commission,
    tax: 0,
    cashChange: -roundMoney(amount + commission),
  };
}

export function calculateSellSettlement(
  quantity: number,
  fillPrice: number,
  averageCost: number,
  fees: PaperFeeConfig,
) {
  const amount = roundMoney(quantity * fillPrice);
  const commission = calculateCommission(
    amount,
    fees.commissionRate,
    fees.minimumCommission,
  );
  const tax = calculateSellTax(amount, fees.sellTaxRate);
  return {
    amount,
    commission,
    tax,
    cashChange: roundMoney(amount - commission - tax),
    realizedPnl: roundMoney(
      (fillPrice - averageCost) * quantity - commission - tax,
    ),
  };
}

export function calculateMaxAffordableBuyQuantity(
  availableCash: number,
  estimatedPrice: number,
  fees: PaperFeeConfig,
  lotSize = 100,
) {
  if (
    !Number.isFinite(availableCash)
    || !Number.isFinite(estimatedPrice)
    || !Number.isFinite(lotSize)
    || availableCash <= 0
    || estimatedPrice <= 0
    || lotSize <= 0
  ) return 0;
  let quantity = Math.floor(availableCash / estimatedPrice / lotSize) * lotSize;
  while (
    quantity > 0
    && calculateBuyReservation(quantity, estimatedPrice, fees).frozenCash > availableCash
  ) {
    quantity -= lotSize;
  }
  return Math.max(0, quantity);
}

export function calculateQuickOrderQuantities(input: {
  side: 'buy' | 'sell';
  availableCash: number;
  availableQuantity: number;
  estimatedPrice: number;
  fees: PaperFeeConfig;
  lotSize?: number;
}) {
  const lotSize = input.lotSize ?? 100;
  const full = input.side === 'buy'
    ? calculateMaxAffordableBuyQuantity(
      input.availableCash,
      input.estimatedPrice,
      input.fees,
      lotSize,
    )
    : Math.max(0, Math.floor(input.availableQuantity));
  const fractionalQuantity = (ratio: number) => input.side === 'buy'
    ? calculateMaxAffordableBuyQuantity(
      input.availableCash * ratio,
      input.estimatedPrice,
      input.fees,
      lotSize,
    )
    : Math.floor(input.availableQuantity * ratio / lotSize) * lotSize;
  const fixedHundredLots = lotSize * 100;
  return {
    full,
    half: fractionalQuantity(0.5),
    third: fractionalQuantity(1 / 3),
    fixedHundredLots,
    fixedHundredLotsAvailable: full >= fixedHundredLots,
  };
}

export function calculatePositionMark(input: {
  totalQuantity: number;
  averageCost: number;
  lastPrice: number;
}) {
  const { totalQuantity, averageCost, lastPrice } = input;
  if (
    ![totalQuantity, averageCost, lastPrice].every(Number.isFinite)
    || totalQuantity < 0
    || averageCost < 0
    || lastPrice <= 0
  ) {
    throw new Error('持仓估值参数无效');
  }
  return {
    marketValue: roundMoney(totalQuantity * lastPrice),
    unrealizedPnl: roundMoney((lastPrice - averageCost) * totalQuantity),
  };
}

export function assertAccountBalances(input: {
  cashBalance: number;
  frozenCash: number;
}) {
  if (
    !Number.isFinite(input.cashBalance)
    || !Number.isFinite(input.frozenCash)
    || input.cashBalance < 0
    || input.frozenCash < 0
    || input.frozenCash > input.cashBalance
  ) {
    throw new Error('模拟账户现金或冻结资金不满足守恒约束');
  }
}

export function assertPositionBalances(input: {
  totalQuantity: number;
  availableQuantity: number;
  frozenQuantity: number;
}) {
  const { totalQuantity, availableQuantity, frozenQuantity } = input;
  if (
    ![totalQuantity, availableQuantity, frozenQuantity].every(Number.isFinite)
    || totalQuantity < 0
    || availableQuantity < 0
    || frozenQuantity < 0
    || availableQuantity + frozenQuantity > totalQuantity
  ) {
    throw new Error('模拟持仓数量不满足守恒约束');
  }
}
