export interface PositionSnapshot {
  quantity: number;
  avgCost: number;
  /** ISO datetime of the most recent buy entry. Used for holding days calculation. */
  entryTime?: string;
}
