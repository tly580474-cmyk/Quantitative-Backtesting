import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import {
  modelWorkerRequestSchema,
  modelWorkerResponseSchema,
  type MlModelPlan,
  type ModelTrainingRow,
  type ModelWorkerResponse,
} from './mlModelSchema.js';

// N2.3：sklearn 白名单模型执行 Worker（TS 客户端）。
// 只允许白名单模型类型；训练只用 decisionDate <= trainedThrough 的带标签行；
// 分数固定进入因子协议（screening_only 语义由调用方保证）。

export async function runModelWorker(input: {
  spec: MlModelPlan;
  rows: ModelTrainingRow[];
  enabled: boolean;
  pythonExecutable: string;
  workerPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<ModelWorkerResponse> {
  if (!input.enabled) throw new Error('ML_MODEL_WORKER_DISABLED');
  const request = modelWorkerRequestSchema.parse({
    protocolVersion: '1.0',
    spec: input.spec,
    rows: input.rows,
  });
  const workerPath = resolve(input.workerPath ?? '../tools/model-worker/model_worker.py');
  const output = await invokePython(
    input.pythonExecutable,
    workerPath,
    JSON.stringify(request),
    input.timeoutMs ?? 120_000,
    input.maxOutputBytes ?? 64 * 1024 * 1024,
  );
  const parsed = modelWorkerResponseSchema.parse(JSON.parse(output));
  if (parsed.modelType !== input.spec.modelType) throw new Error('ML_MODEL_TYPE_MISMATCH');
  if (parsed.scores.length !== input.rows.length) throw new Error('ML_MODEL_SCORE_COUNT_MISMATCH');
  return parsed;
}

async function invokePython(
  executable: string,
  workerPath: string,
  stdin: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<string> {
  const child = spawn(executable, [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONHASHSEED: '0', PYTHONUNBUFFERED: '1' },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxOutputBytes) {
      child.kill('SIGKILL');
      throw new Error('ML_MODEL_OUTPUT_TOO_LARGE');
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(stdin);
  const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const code = await new Promise<number | null>((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  }).finally(() => clearTimeout(timeout));
  if (code !== 0) {
    throw new Error(`ML_MODEL_WORKER_FAILED:${code}:${Buffer.concat(stderr).toString('utf8').trim().slice(-2000)}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}
