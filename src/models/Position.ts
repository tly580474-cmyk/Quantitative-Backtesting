export interface PositionSnapshot {
  quantity: number;
  avgCost: number;
  /** ISO datetime of the most recent buy entry. Used for holding days calculation. */
  entryTime?: string;
  /** Number of consecutive completed position cycles whose net P&L was negative. */
  consecutiveLosingTrades?: number;
  /** ISO datetime of the most recently completed position cycle. */
  lastCompletedTradeTime?: string;
  /** Current invested market value divided by total portfolio equity. */
  positionRatio?: number;
  /** Positive drawdown magnitude from the strategy equity peak, e.g. 0.15 means 15%. */
  strategyDrawdown?: number;
}
