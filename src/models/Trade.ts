export interface Trade {
  id: string;
  orderId: string;
  time: string;
  side: 'buy' | 'sell';
  quantity: number;
  rawPrice: number;
  fillPrice: number;
  commission: number;
  tax: number;
  slippageCost: number;
  amount: number;
  forceClose?: boolean;
}
