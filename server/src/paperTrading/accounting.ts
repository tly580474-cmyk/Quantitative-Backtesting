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
