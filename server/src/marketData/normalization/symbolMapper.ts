/**
 * Symbol code normalization utilities.
 *
 * Handles market detection, symbol normalization (whitespace stripping,
 * zero-padding, case folding), and format conversion between internal
 * representations and provider-specific symbol formats.
 *
 * Chinese A-share symbol conventions:
 *   SH (Shanghai): 60xxxx
 *   SZ (Shenzhen): 00xxxx (main board), 30xxxx (ChiNext/创业板)
 *   BJ (Beijing):  83xxxx, 43xxxx
 */

// ─── Regular expressions for market detection ────────────────────────

const SUFFIX_RE = /\.(SH|SZ|BJ)$/i;
const PREFIX_RE = /^(SH|SZ|BJ)/i;
const EASTMONEY_PREFIX_RE = /^[012]\./;
const NUMERIC_RE = /^\d+$/;

const SH_CODE_RE = /^60\d{4}$/;
const SZ_CODE_RE = /^(00|30)\d{4}$/;
const BJ_CODE_RE = /^(83|43)\d{4}$/;

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Normalize a raw symbol string into the internal canonical form.
 *
 * - Strips leading/trailing whitespace.
 * - Strips known market suffixes (`.SH`, `.SZ`, `.BJ`).
 * - Strips known provider prefixes (`SH`, `SZ`, `BJ`).
 * - Zero-pads purely numeric codes to 6 digits for SH/SZ markets.
 * - Uppercases the result.
 */
export function normalizeSymbol(raw: string, market: string): string {
  let symbol = raw.trim().toUpperCase();

  // Remove known suffixes
  symbol = symbol.replace(SUFFIX_RE, '');

  // Remove known prefixes (e.g. "sh600519" → "600519")
  symbol = symbol.replace(PREFIX_RE, '');

  // Remove East Money prefix (e.g. "1.600519" → "600519")
  symbol = symbol.replace(EASTMONEY_PREFIX_RE, '');

  // For SH and SZ markets, zero-pad numeric codes to 6 digits.
  // BJ market codes may vary in length, so we skip padding.
  if ((market === 'SH' || market === 'SZ') && NUMERIC_RE.test(symbol)) {
    symbol = symbol.padStart(6, '0');
  }

  return symbol;
}

/**
 * Detect the market (SH / SZ / BJ) from a raw symbol string.
 *
 * Returns `null` if the market cannot be reliably determined.
 *
 * Detection order:
 *   1. Explicit suffix — `.SH` / `.SZ` / `.BJ`  (highest priority)
 *   2. Numeric code prefix after stripping alphabetic prefixes:
 *      - 60xxxx → SH
 *      - 00xxxx or 30xxxx → SZ
 *      - 83xxxx or 43xxxx → BJ
 */
export function detectMarket(symbol: string): string | null {
  const s = symbol.trim().toUpperCase();

  // Explicit suffix takes priority
  if (s.endsWith('.SH')) return 'SH';
  if (s.endsWith('.SZ')) return 'SZ';
  if (s.endsWith('.BJ')) return 'BJ';

  // Strip known alphabetic prefix and East Money prefix
  const stripped = s.replace(PREFIX_RE, '').replace(EASTMONEY_PREFIX_RE, '');

  if (SH_CODE_RE.test(stripped)) return 'SH';
  if (SZ_CODE_RE.test(stripped)) return 'SZ';
  if (BJ_CODE_RE.test(stripped)) return 'BJ';

  return null;
}

/**
 * Convert an internal symbol to the format expected by a specific provider.
 *
 * Known provider conventions:
 *   - `tushare`:  "600519.SH", "000001.SZ"
 *   - `akshare`:  "sh600519", "sz000001"
 *   - `eastmoney`: "1.600519" (SH), "0.000001" (SZ)
 *   - default:    "600519.SH" (suffix format)
 */
export function toProviderSymbol(
  symbol: string,
  market: string,
  providerId: string,
): string {
  const normalized = normalizeSymbol(symbol, market);

  switch (providerId) {
    case 'tushare':
      return `${normalized}.${market}`;
    case 'akshare':
      return `${market.toLowerCase()}${normalized}`;
    case 'eastmoney': {
      const prefix = market === 'SH' ? '1' : market === 'SZ' ? '0' : '2';
      return `${prefix}.${normalized}`;
    }
    default:
      // Default to suffix format
      return `${normalized}.${market}`;
  }
}

/**
 * Convert a provider-specific symbol back to the internal canonical form.
 *
 * Strips known provider prefixes, suffixes, and other decorators, then
 * normalizes the result.
 */
export function toInternalSymbol(
  providerSymbol: string,
  market: string,
): string {
  return normalizeSymbol(providerSymbol, market);
}
