import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { TradingCalendarEntry } from '../../marketData/types.js';

const { tradingCalendar } = schema;
const CHUNK_SIZE = 500;

export async function getCalendar(
  market: string,
  startDate: string,
  endDate: string,
): Promise<TradingCalendarEntry[]> {
  const rows = await getDb()
    .select()
    .from(tradingCalendar)
    .where(
      and(
        eq(tradingCalendar.market, market),
        gte(tradingCalendar.tradeDate, startDate),
        lte(tradingCalendar.tradeDate, endDate),
      ),
    )
    .orderBy(tradingCalendar.tradeDate);

  return rows.map(toDomain);
}

export async function upsertCalendarEntries(
  entries: TradingCalendarEntry[],
  _providerId?: string,
): Promise<void> {
  const dbEntries = entries.map(toRow);

  await getDb().transaction(async (tx) => {
    for (let i = 0; i < dbEntries.length; i += CHUNK_SIZE) {
      await tx
        .insert(tradingCalendar)
        .values(dbEntries.slice(i, i + CHUNK_SIZE))
        .onDuplicateKeyUpdate({
          set: {
            isOpen: sql`VALUES(${tradingCalendar.isOpen})`,
            sessionMetadata: sql`VALUES(${tradingCalendar.sessionMetadata})`,
          },
        });
    }
  });
}

export async function getOpenTradingDays(
  market: string,
  startDate: string,
  endDate: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ tradeDate: tradingCalendar.tradeDate })
    .from(tradingCalendar)
    .where(
      and(
        eq(tradingCalendar.market, market),
        gte(tradingCalendar.tradeDate, startDate),
        lte(tradingCalendar.tradeDate, endDate),
        eq(tradingCalendar.isOpen, 1),
      ),
    )
    .orderBy(tradingCalendar.tradeDate);

  return rows.map((r) => r.tradeDate);
}

export async function getLatestTradeDate(
  market: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ tradeDate: tradingCalendar.tradeDate })
    .from(tradingCalendar)
    .where(
      and(
        eq(tradingCalendar.market, market),
        eq(tradingCalendar.isOpen, 1),
      ),
    )
    .orderBy(desc(tradingCalendar.tradeDate))
    .limit(1);

  return rows[0]?.tradeDate ?? null;
}

export async function isTradeDate(
  market: string,
  date: string,
): Promise<boolean> {
  return (await getTradeDateStatus(market, date)) ?? false;
}

export async function getTradeDateStatus(
  market: string,
  date: string,
): Promise<boolean | null> {
  const rows = await getDb()
    .select({ isOpen: tradingCalendar.isOpen })
    .from(tradingCalendar)
    .where(
      and(
        eq(tradingCalendar.market, market),
        eq(tradingCalendar.tradeDate, date),
      ),
    )
    .limit(1);

  const row = rows[0];
  return row ? row.isOpen === 1 : null;
}

// ─── Internal helpers ───────────────────────────────────────────────

/** Convert Drizzle row (isOpen as number) to domain type (isOpen as boolean). */
function toDomain(
  row: typeof tradingCalendar.$inferSelect,
): TradingCalendarEntry {
  return {
    id: row.id,
    market: row.market as TradingCalendarEntry['market'],
    tradeDate: row.tradeDate,
    isOpen: row.isOpen === 1,
    sessionMetadata: row.sessionMetadata as
      | Record<string, unknown>
      | undefined,
  };
}

/** Convert domain type (isOpen as boolean) to Drizzle insert row (isOpen as number). */
function toRow(
  entry: TradingCalendarEntry,
): typeof tradingCalendar.$inferInsert {
  return {
    ...entry,
    isOpen: entry.isOpen ? 1 : 0,
    sessionMetadata: entry.sessionMetadata ?? null,
  };
}
