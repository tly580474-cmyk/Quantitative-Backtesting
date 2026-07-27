import {
  eq,
  and,
  like,
  ne,
  notLike,
  or,
  isNull,
  sql,
  type SQL,
} from 'drizzle-orm';
import { getDb, schema } from '../../db/index.js';
import type { Instrument } from '../../marketData/types.js';

const { instruments } = schema;
const CHUNK_SIZE = 500;

interface ListFilters {
  market?: string;
  symbol?: string;
  search?: string;
  type?: string;
  status?: string;
  industry?: string;
  excludeDelisted?: boolean;
  excludeSt?: boolean;
  offset?: number;
  limit?: number;
}

export async function listInstruments(
  filters?: ListFilters,
): Promise<{ data: Instrument[]; total: number }> {
  const conditions = buildConditions(filters, true);

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
    base.orderBy(instruments.symbol, instruments.market).limit(limit).offset(offset),
    countQuery,
  ]);

  return { data: data as Instrument[], total: Number(countRow?.count ?? 0) };
}

export async function listInstrumentIndustryCounts(
  filters?: Omit<ListFilters, 'industry' | 'offset' | 'limit'>,
): Promise<Array<{ industry: string; count: number }>> {
  const conditions = buildConditions(filters, false);
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const industryName = sql<string>`COALESCE(NULLIF(TRIM(${instruments.industry}), ''), '未分类')`;
  const query = getDb()
    .select({
      industry: industryName,
      count: sql<number>`count(*)`,
    })
    .from(instruments)
    .$dynamic();
  if (where) query.where(where);
  const rows = await query
    .groupBy(industryName)
    .orderBy(sql`count(*) DESC`, industryName);
  return rows.map((row) => ({
    industry: row.industry,
    count: Number(row.count),
  }));
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

export async function listInstrumentIdentityKeys(type = 'stock'): Promise<Set<string>> {
  const rows = await getDb()
    .select({
      market: instruments.market,
      symbol: instruments.symbol,
      type: instruments.type,
    })
    .from(instruments)
    .where(eq(instruments.type, type));
  return new Set(rows.map((row) => `${row.market}:${row.symbol}:${row.type}`));
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
      'name' | 'industry' | 'type' | 'listDate' | 'delistDate' | 'status' | 'updatedAt'
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
        industry: sql`COALESCE(VALUES(${instruments.industry}), ${instruments.industry})`,
        listDate: sql`COALESCE(VALUES(${instruments.listDate}), ${instruments.listDate})`,
        delistDate: sql`COALESCE(VALUES(${instruments.delistDate}), ${instruments.delistDate})`,
        status: sql`VALUES(${instruments.status})`,
        updatedAt: sql`VALUES(${instruments.updatedAt})`,
      },
    });
}

export async function upsertInstruments(instrumentList: Instrument[]): Promise<void> {
  if (instrumentList.length === 0) return;
  await getDb().transaction(async (tx) => {
    for (let index = 0; index < instrumentList.length; index += CHUNK_SIZE) {
      await tx
        .insert(instruments)
        .values(instrumentList.slice(index, index + CHUNK_SIZE))
        .onDuplicateKeyUpdate({
          set: {
            name: sql`VALUES(${instruments.name})`,
            industry: sql`COALESCE(VALUES(${instruments.industry}), ${instruments.industry})`,
            listDate: sql`COALESCE(VALUES(${instruments.listDate}), ${instruments.listDate})`,
            delistDate: sql`COALESCE(VALUES(${instruments.delistDate}), ${instruments.delistDate})`,
            status: sql`VALUES(${instruments.status})`,
            updatedAt: sql`VALUES(${instruments.updatedAt})`,
          },
        });
    }
  });
}

function buildConditions(
  filters: ListFilters | undefined,
  includeIndustry: boolean,
): SQL[] {
  const conditions: SQL[] = [];
  if (filters?.market) conditions.push(eq(instruments.market, filters.market));
  if (filters?.symbol) conditions.push(eq(instruments.symbol, filters.symbol));
  if (filters?.search) {
    const keyword = `%${filters.search.trim()}%`;
    conditions.push(or(
      like(instruments.symbol, keyword),
      like(instruments.name, keyword),
    )!);
  }
  if (filters?.type) conditions.push(eq(instruments.type, filters.type));
  if (filters?.status) conditions.push(eq(instruments.status, filters.status));
  if (includeIndustry && filters?.industry) {
    if (filters.industry === '未分类') {
      conditions.push(or(
        isNull(instruments.industry),
        eq(instruments.industry, ''),
      )!);
    } else {
      conditions.push(eq(instruments.industry, filters.industry));
    }
  }
  if (filters?.excludeDelisted) conditions.push(ne(instruments.status, 'delisted'));
  if (filters?.excludeSt) {
    conditions.push(and(
      notLike(instruments.name, 'ST%'),
      notLike(instruments.name, '*ST%'),
    )!);
  }
  return conditions;
}
