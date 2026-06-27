export interface Order {
  id: string;
  signalTime: string;
  executeTime: string;
  side: 'buy' | 'sell';
  orderType: 'market';
  quantity: number;
  status: 'pending' | 'filled' | 'rejected' | 'cancelled';
  rejectReason?: string;
  /** Marks an order sized from an explicit strategy target rather than global step sizing. */
  targetPosition?: number;
}
