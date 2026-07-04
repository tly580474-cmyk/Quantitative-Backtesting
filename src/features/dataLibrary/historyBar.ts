const YUAN_PER_YI = 100_000_000;

/**
 * MySQL history-v2 stores amount in yuan, while Candle.turnover uses 亿元.
 */
export function amountYuanToYi(amount: number | undefined): number | undefined {
  return amount == null ? undefined : amount / YUAN_PER_YI;
}
