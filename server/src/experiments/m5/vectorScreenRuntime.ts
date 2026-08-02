import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { screeningCandidateSchema, type ScreeningCandidate } from './schema.js';

const vectorScreenRequestSchema = z.object({
  runtime: z.enum(['vectorbt', 'numpy_reference']),
  specHash: z.string().regex(/^[a-f0-9]{64}$/),
  datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
  close: z.array(z.number().positive().finite()).min(3).max(2_000_000),
  parameterGrid: z.array(z.object({
    fast: z.number().int().min(2).max(500),
    slow: z.number().int().min(3).max(1000),
  }).refine((value) => value.fast < value.slow, 'fast must be less than slow')).min(1).max(10_000),
});

const vectorScreenResponseSchema = z.object({
  protocolVersion: z.literal('1.0'),
  runtime: z.enum(['vectorbt', 'numpy_reference']),
  candidates: z.array(screeningCandidateSchema).max(10_000),
});

export type VectorScreenRequest = z.infer<typeof vectorScreenRequestSchema>;

export async function runVectorScreen(input: {
  request: VectorScreenRequest;
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
  timeoutMs?: number;
}): Promise<ScreeningCandidate[]> {
  if (!input.enabled) throw new Error('VECTOR_SCREEN_RUNTIME_DISABLED');
  const request = vectorScreenRequestSchema.parse(input.request);
  const workerPath = resolve(input.workerPath ?? '../tools/vector-screen/worker.py');
  const output = await invokePython(input.pythonExecutable, workerPath, JSON.stringify(request), input.timeoutMs ?? 60_000);
  const parsed = vectorScreenResponseSchema.parse(JSON.parse(output));
  if (parsed.runtime !== request.runtime) throw new Error('VECTOR_SCREEN_RUNTIME_MISMATCH');
  for (const candidate of parsed.candidates) {
    if (candidate.specHash !== request.specHash || candidate.datasetHash !== request.datasetHash) {
      throw new Error('VECTOR_SCREEN_BINDING_MISMATCH');
    }
    if (candidate.authority !== 'screening_only') throw new Error('VECTOR_SCREEN_AUTHORITY_ESCALATION');
  }
  return parsed.candidates;
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
  if (code !== 0) throw new Error(`VECTOR_SCREEN_WORKER_FAILED:${code}:${Buffer.concat(stderr).toString('utf8').trim()}`);
  return Buffer.concat(stdout).toString('utf8');
}
