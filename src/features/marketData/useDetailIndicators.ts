import { useEffect, useState } from 'react';
import type { MarketIndicatorVisibility } from './MarketKlineChart';

const KEY = 'quant-mobile-detail-indicators-v1';
const MOBILE_DEFAULT = { ma: true, rsi: false, macd: false };
function readMobileIndicators(): MarketIndicatorVisibility {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (saved && ['ma', 'rsi', 'macd'].every(key => typeof saved[key] === 'boolean')) {
      return { ma: saved.ma, rsi: saved.rsi, macd: saved.macd };
    }
  } catch { /* Storage can be unavailable; indicators still work in memory. */ }
  return { ...MOBILE_DEFAULT };
}

export function useDetailIndicators(mobile: boolean) {
  const [desktop, setDesktop] = useState<MarketIndicatorVisibility>({ ma: true, rsi: true, macd: true });
  const [compact, setCompact] = useState<MarketIndicatorVisibility>(readMobileIndicators);
  useEffect(() => {
    if (!mobile) return;
    try { localStorage.setItem(KEY, JSON.stringify(compact)); } catch { /* Optional preference. */ }
  }, [mobile, compact]);
  return mobile ? [compact, setCompact] as const : [desktop, setDesktop] as const;
}
