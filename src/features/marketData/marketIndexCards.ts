import type { KlinePoint, StockQuote, StockSearchItem } from './types';

export interface MarketIndexOption {
  key: string;
  code: string;
  name: string;
  market: StockSearchItem['market'];
  prefixed: string;
}

export interface MarketIndexCardView {
  key: string;
  option: MarketIndexOption;
  quote: StockQuote | null;
}

export interface MarketIndexSnapshot {
  price: number | null;
  changeAmount: number | null;
  changePct: number | null;
  amountWan: number | null;
  source: 'quote' | 'kline' | 'unavailable';
}

/**
 * Keep the configured card slots stable even when an upstream quote response is
 * partial. A missing quote is data state, not a reason to remove the card.
 */
export function buildMarketIndexCards(
  selectedKeys: string[],
  options: MarketIndexOption[],
  quotes: StockQuote[],
): MarketIndexCardView[] {
  const optionByKey = new Map(options.map((option) => [option.key, option]));
  const quoteByKey = new Map(quotes.map((quote) => [`${quote.market}:${quote.code}`, quote]));

  return selectedKeys.flatMap((key) => {
    const option = optionByKey.get(key);
    return option ? [{ key, option, quote: quoteByKey.get(key) ?? null }] : [];
  });
}

/** Use the already-loaded daily preview as a graceful fallback for partial quotes. */
export function resolveMarketIndexSnapshot(
  quote: StockQuote | null,
  points: KlinePoint[] | undefined,
): MarketIndexSnapshot {
  if (quote) {
    return {
      price: quote.price,
      changeAmount: quote.changeAmount,
      changePct: quote.changePct,
      amountWan: quote.amountWan,
      source: 'quote',
    };
  }

  const latest = points?.[points.length - 1];
  const previous = points?.[points.length - 2];
  if (!latest) {
    return { price: null, changeAmount: null, changePct: null, amountWan: null, source: 'unavailable' };
  }
  const changeAmount = previous ? latest.close - previous.close : null;
  return {
    price: latest.close,
    changeAmount,
    changePct: changeAmount != null && previous && previous.close !== 0
      ? changeAmount / previous.close * 100
      : null,
    amountWan: null,
    source: 'kline',
  };
}
