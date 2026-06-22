import { eq, and, sql } from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { Instrument } from '../../marketData/types.js';

const { instruments } = schema;
const CHUNK_SIZE = 500;

interface ListFilters {
  market?: string;
  symbol?: string;
  type?: string;
  status?: string;
  offset?: number;
  limit?: number;
}

export async function listInstruments(
  filters?: ListFilters,
): Promise<{ data: Instrument[]; total: number }> {
  const conditions: ReturnType<typeof eq>[] = [];

  if (filters?.market) conditions.push(eq(instruments.market, filters.market));
  if (filters?.symbol) conditions.push(eq(instruments.symbol, filters.symbol));
  if (filters?.type) conditions.push(eq(instruments.type, filters.type));
  if (filters?.status) conditions.push(eq(instruments.status, filters.status));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const base = getDb()
    .select()
    .from(instruments)
    .$dynamic();

  const countQuery = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(instruments)
    .$dynamic();

  if (where) {
    base.where(where);
    countQuery.where(where);
  }

  const offset = filters?.offset ?? 0;
  const limit = filters?.limit ?? 100;

  const [data, [countRow]] = await Promise.all([
    base.orderBy(instruments.market, instruments.symbol).limit(limit).offset(offset),
    countQuery,
  ]);

  return { data: data as Instrument[], total: Number(countRow?.count ?? 0) };
}

export async function getInstrument(id: string): Promise<Instrument | null> {
  const rows = await getDb()
    .select()
    .from(instruments)
    .where(eq(instruments.id, id))
    .limit(1);
  return (rows[0] as Instrument) ?? null;
}

export async function getInstrumentByMarketSymbol(
  market: string,
  symbol: string,
  type: string,
): Promise<Instrument | null> {
  const rows = await getDb()
    .select()
    .from(instruments)
    .where(
      and(
        eq(instruments.market, market),
        eq(instruments.symbol, symbol),
        eq(instruments.type, type),
      ),
    )
    .limit(1);
  return (rows[0] as Instrument) ?? null;
}

export async function createInstrument(instrument: Instrument): Promise<void> {
  await getDb().insert(instruments).values(instrument);
}

export async function createInstruments(
  instrumentList: Instrument[],
): Promise<void> {
  await getDb().transaction(async (tx) => {
    for (let i = 0; i < instrumentList.length; i += CHUNK_SIZE) {
      await tx
        .insert(instruments)
        .values(instrumentList.slice(i, i + CHUNK_SIZE));
    }
  });
}

export async function updateInstrument(
  id: string,
  updates: Partial<
    Pick<
      Instrument,
      'name' | 'type' | 'listDate' | 'delistDate' | 'status' | 'updatedAt'
    >
  >,
): Promise<void> {
  await getDb().update(instruments).set(updates).where(eq(instruments.id, id));
}

export async function upsertInstrument(instrument: Instrument): Promise<void> {
  await getDb()
    .insert(instruments)
    .values(instrument)
    .onDuplicateKeyUpdate({
      set: {
        name: sql`VALUES(${instruments.name})`,
        listDate: sql`VALUES(${instruments.listDate})`,
        delistDate: sql`VALUES(${instruments.delistDate})`,
        status: sql`VALUES(${instruments.status})`,
        updatedAt: sql`VALUES(${instruments.updatedAt})`,
      },
    });
}
