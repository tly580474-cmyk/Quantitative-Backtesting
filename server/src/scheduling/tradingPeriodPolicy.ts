export const SKIP_NON_TRADING_PERIODS_KEY = 'SCHEDULE_SKIP_NON_TRADING_PERIODS';

/**
 * Automatic jobs skip non-trading periods by default. Setting the environment
 * value to "false" is the only way to opt out, so older installations gain the
 * safer behaviour without requiring an immediate .env migration.
 */
export function shouldSkipNonTradingPeriods(
  values: NodeJS.ProcessEnv = process.env,
): boolean {
  return values[SKIP_NON_TRADING_PERIODS_KEY]?.trim().toLowerCase() !== 'false';
}

export function isWeekendInTimeZone(
  now: Date,
  timeZone: string,
): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(now);
  return weekday === 'Sat' || weekday === 'Sun';
}
