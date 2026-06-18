/**
 * Parse a date string in various formats to a standard date string.
 * Handles YYYYMMDD numbers/strings and ISO-like date strings.
 */
export function parseDate(raw: unknown): string | null {
  if (raw == null) return null;

  let s = String(raw).trim();

  // Handle Excel serial date numbers
  const num = Number(s);
  if (!Number.isNaN(num) && num > 30000 && num < 100000) {
    // Excel date serial number (days since 1900-01-01)
    const excelEpoch = new Date(1899, 11, 30);
    const d = new Date(excelEpoch.getTime() + num * 86400000);
    return formatDateStr(d);
  }

  // Remove separators: hyphens, slashes, dots
  const cleaned = s.replace(/[-/.]/g, '');

  // YYYYMMDD (8 digits)
  if (/^\d{8}$/.test(cleaned)) {
    const y = parseInt(cleaned.slice(0, 4), 10);
    const m = parseInt(cleaned.slice(4, 6), 10);
    const d = parseInt(cleaned.slice(6, 8), 10);
    if (y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return formatDateStr(new Date(y, m - 1, d));
    }
  }

  // Try standard Date parsing as fallback
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) {
    return formatDateStr(parsed);
  }

  return null;
}

export function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isWeekend(dateStr: string): boolean {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getDay();
  return day === 0 || day === 6;
}
