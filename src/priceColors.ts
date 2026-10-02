export type PriceColorMode = 'red-up' | 'green-up';
export interface PriceColors { readonly up: string; readonly down: string }

const PALETTES: Record<PriceColorMode, PriceColors> = {
  'red-up': { up: '#ef4444', down: '#16a34a' },
  'green-up': { up: '#16a34a', down: '#ef4444' },
};

export function getPriceColors(mode: PriceColorMode): PriceColors { return PALETTES[mode]; }
export function priceColorLabel(mode: PriceColorMode): string {
  return mode === 'green-up' ? '绿涨红跌' : '红涨绿跌';
}

export function candleColorOptions(colors: PriceColors) {
  return {
    upColor: colors.up, downColor: colors.down,
    wickUpColor: colors.up, wickDownColor: colors.down,
    borderUpColor: colors.up, borderDownColor: colors.down,
  };
}
