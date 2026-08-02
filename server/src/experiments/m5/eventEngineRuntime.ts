import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { eventStrategySchema } from './eventEngineStrategies.js';

// N1.2：Backtrader 事件驱动订单生命周期适配层（TS 客户端）。
// 事件引擎只产出 `screening_only` 成交记录，不产出可发布业绩；
// 候选必须经权威 TS 引擎复算后才能进入治理（ADR-05）。

const candleSchema = z.object({
  time: z.string().min(1),
  open: z.number().positive().finite(),
  high: z.number().positive().finite(),
  low: z.number().positive().finite(),
  close: z.number().positive().finite(),
  volume: z.number().nonnegative().finite().optional(),
});

const eventEngineConfigSchema = z.object({
  initialCapital: z.number().positive().finite(),
  positionSizing: z.number().gt(0).lte(1).finite(),
  commissionRate: z.number().nonnegative().finite(),
  minimumCommission: z.number().nonnegative().finite(),
  sellTaxRate: z.number().nonnegative().finite(),
  slippageBps: z.number().nonnegative().finite(),
  tradingUnitMode: z.enum(['stock', 'index']),
  forceCloseAtEnd: z.boolean(),
});

export const eventEngineRequestSchema = z.object({
  protocolVersion: z.literal('1.0'),
  strategy: eventStrategySchema,
  candles: z.array(candleSchema).min(2).max(2_000_000),
  config: eventEngineConfigSchema,
});

export const eventEngineTradeSchema = z.object({
  time: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  quantity: z.number().int().nonnegative(),
  rawPrice: z.number().finite(),
  fillPrice: z.number().finite(),
  commission: z.number().nonnegative().finite(),
  tax: z.number().nonnegative().finite(),
  amount: z.number().finite(),
  forceClose: z.boolean().optional(),
});

const eventEngineResponseSchema = z.object({
  protocolVersion: z.literal('1.0'),
  runtime: z.literal('backtrader'),
  authority: z.literal('screening_only'),
  publishable: z.literal(false),
  trades: z.array(eventEngineTradeSchema).max(100_000),
  orders: z.array(z.unknown()).max(100_000),
  equityCurve: z.array(z.object({
    time: z.string().min(1),
    equity: z.number().finite(),
  })).max(2_000_000),
  finalEquity: z.number().finite(),
});

export type EventEngineRequest = z.infer<typeof eventEngineRequestSchema>;
export type EventEngineTrade = z.infer<typeof eventEngineTradeSchema>;

export interface EventEngineResult {
  protocolVersion: '1.0';
  runtime: 'backtrader';
  authority: 'screening_only';
  publishable: false;
  trades: EventEngineTrade[];
  orders: unknown[];
  equityCurve: Array<{ time: string; equity: number }>;
  finalEquity: number;
}

export async function runEventEngine(input: {
  request: EventEngineRequest;
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
  timeoutMs?: number;
}): Promise<EventEngineResult> {
  if (!input.enabled) throw new Error('EVENT_ENGINE_RUNTIME_DISABLED');
  const request = eventEngineRequestSchema.parse(input.request);
  const workerPath = resolve(input.workerPath ?? '../tools/backtrader/event_engine_worker.py');
  const output = await invokePython(input.pythonExecutable, workerPath, JSON.stringify(request), input.timeoutMs ?? 60_000);
  const parsed = eventEngineResponseSchema.parse(JSON.parse(output));
  if (parsed.authority !== 'screening_only') throw new Error('EVENT_ENGINE_AUTHORITY_ESCALATION');
  return parsed;
}

async function invokePython(executable: string, workerPath: string, stdin: string, timeoutMs: number): Promise<string> {
  const child = spawn(executable, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(stdin);
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  }).finally(() => clearTimeout(timeout));
  if (code !== 0) {
    throw new Error(`EVENT_ENGINE_WORKER_FAILED:${code}:${Buffer.concat(stderr).toString('utf8').trim().slice(-2000)}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}
