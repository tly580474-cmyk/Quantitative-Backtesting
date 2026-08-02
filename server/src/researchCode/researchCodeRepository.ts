import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '../db/index.js';
import { researchCodeRequestSchema, type ResearchCodeRequest } from './researchSandboxClient.js';

// 阶段 C：研究代码运行持久化。结果恒标记 authority=exploration_only / publishable=false。

const { researchCodeRuns } = schema;

export interface ResearchCodeRunRecord {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'rejected';
  request: ResearchCodeRequest;
  codeHash: string;
  result: unknown | null;
  resultHash: string | null;
  authority: string;
  publishable: boolean;
  capturedOutput: string | null;
  error: { type: string; message: string; traceback?: string } | null;
  maxSeconds: number | null;
  createdAt: string;
  completedAt: string | null;
}

function serialize(row: typeof researchCodeRuns.$inferSelect): ResearchCodeRunRecord {
  return {
    id: row.id,
    status: row.status as ResearchCodeRunRecord['status'],
    request: researchCodeRequestSchema.parse(row.request),
    codeHash: row.codeHash,
    result: row.result ?? null,
    resultHash: row.resultHash ?? null,
    authority: row.authority,
    publishable: row.publishable,
    capturedOutput: row.capturedOutput ?? null,
    error: (row.error ?? null) as ResearchCodeRunRecord['error'],
    maxSeconds: row.maxSeconds ?? null,
    createdAt: row.createdAt,
    completedAt: row.completedAt ?? null,
  };
}

export async function createResearchCodeRun(input: {
  request: ResearchCodeRequest;
  codeHash: string;
  maxSeconds: number | null;
}): Promise<ResearchCodeRunRecord> {
  const now = new Date().toISOString();
  const id = randomUUID();
  await getDb()
    .insert(researchCodeRuns)
    .values({
      id,
      status: 'queued',
      request: input.request,
      codeHash: input.codeHash,
      result: null,
      resultHash: null,
      authority: 'exploration_only',
      publishable: false,
      capturedOutput: null,
      error: null,
      maxSeconds: input.maxSeconds,
      createdAt: now,
      completedAt: null,
    });
  const row = await getDb().select().from(researchCodeRuns).where(eq(researchCodeRuns.id, id)).limit(1);
  return serialize(row[0]);
}

export async function updateResearchCodeRunResult(input: {
  id: string;
  status: 'completed' | 'failed' | 'rejected';
  result: unknown | null;
  resultHash: string | null;
  capturedOutput: string | null;
  error: { type: string; message: string; traceback?: string } | null;
}): Promise<void> {
  const now = new Date().toISOString();
  await getDb()
    .update(researchCodeRuns)
    .set({
      status: input.status,
      result: input.result,
      resultHash: input.resultHash,
      capturedOutput: input.capturedOutput,
      error: input.error,
      completedAt: now,
    })
    .where(eq(researchCodeRuns.id, input.id));
}

export async function getResearchCodeRun(id: string): Promise<ResearchCodeRunRecord | null> {
  const rows = await getDb().select().from(researchCodeRuns).where(eq(researchCodeRuns.id, id)).limit(1);
  return rows.length > 0 ? serialize(rows[0]) : null;
}

export async function listResearchCodeRuns(limit: number): Promise<ResearchCodeRunRecord[]> {
  const rows = await getDb()
    .select()
    .from(researchCodeRuns)
    .orderBy(desc(researchCodeRuns.createdAt))
    .limit(limit);
  return rows.map(serialize);
}
