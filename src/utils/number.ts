/**
 * Parse a value to a finite number. Returns NaN on failure.
 * Handles strings with Chinese formatting, commas, percent signs, etc.
 */
export function parseNumber(raw: unknown): number {
  if (raw == null) return NaN;

  // If already a number, just check finiteness
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : NaN;
  }

  let s = String(raw).trim();

  // Remove commas, spaces, Chinese-style formatting
  s = s.replace(/[,，\s]/g, '');

  // Handle percent values
  const isPercent = s.endsWith('%');
  if (isPercent) {
    s = s.slice(0, -1);
  }

  // Handle leading/trailing currency markers or other non-numeric chars
  // (keep minus sign and decimal point)
  s = s.replace(/[^0-9.\-eE]/g, '');

  if (s === '' || s === '.' || s === '-') return NaN;

  const n = Number(s);
  if (!Number.isFinite(n)) return NaN;

  return isPercent ? n / 100 : n;
}

/**
 * Parse a percentage into percentage points, the unit used by Candle.changePercent.
 * Both "0.72" and "0.72%" therefore become 0.72.
 */
export function parsePercentPoints(raw: unknown): number {
  const value = parseNumber(raw);
  if (Number.isNaN(value)) return NaN;

  const hasPercentSign = typeof raw === 'string' && raw.trim().endsWith('%');
  return hasPercentSign ? value * 100 : value;
}

/**
 * Round a number to a given number of decimal places.
 */
export function roundTo(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}
