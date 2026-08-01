import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash } from '../experiments/schema.js';
import {
  finalizeRebalancePlan,
  hashMultiAssetPlan,
  multiAssetPlanSchema,
  pointInTimeFeatureRowSchema,
  rebalancePlanSchema,
  validateRebalancePlan,
  type RebalancePlan,
} from './schema.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;

export async function generateRebalancePlanWithPython(options: {
  plan: unknown;
  rows: unknown[];
  pythonExecutable?: string;
  workerPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}): Promise<RebalancePlan> {
  const plan = multiAssetPlanSchema.parse(options.plan);
  const rows = options.rows.map((row) => pointInTimeFeatureRowSchema.parse(row));
  const input = JSON.stringify({ plan, rows });
  if (Buffer.byteLength(input) > MAX_INPUT_BYTES) throw new Error('PYTHON_PLAN_INPUT_TOO_LARGE');
  const workerPath = options.workerPath ? resolve(options.workerPath) : resolveDefaultWorkerPath();
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const sandboxDir = await mkdtemp(resolve(tmpdir(), 'multi-asset-python-'));
  const inputPath = resolve(sandboxDir, 'input.json');
  const outputPath = resolve(sandboxDir, 'output.json');
  await writeFile(inputPath, input, { flag: 'wx' });

  try {
    return await new Promise<RebalancePlan>((resolvePromise, rejectPromise) => {
    const child = spawn(options.pythonExecutable ?? 'python', ['-I', workerPath, inputPath, outputPath], {
      windowsHide: true,
      shell: false,
      cwd: sandboxDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanPythonEnvironment(),
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, result?: RebalancePlan) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('PYTHON_PLAN_WORKER_TIMEOUT'));
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > maxOutputBytes) {
        child.kill();
        finish(new Error('PYTHON_PLAN_OUTPUT_TOO_LARGE'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      stderr = Buffer.concat([stderr, chunk]).subarray(-64 * 1024);
    });
    child.on('error', (error) => finish(new Error(`PYTHON_PLAN_WORKER_START_FAILED:${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error(`PYTHON_PLAN_WORKER_FAILED:${code}:${stderr.toString('utf8').trim().slice(-1000)}`));
        return;
      }
      void (async () => {
        try {
          const metadata = await stat(outputPath);
          if (metadata.size > maxOutputBytes) throw new Error('PYTHON_PLAN_OUTPUT_TOO_LARGE');
          const parsed = rebalancePlanSchema.parse(JSON.parse(await readFile(outputPath, 'utf8')));
          // Python and ECMAScript serialize numerically equivalent values such as 1.0/1
          // differently. The TS execution plane is authoritative, so it normalizes the
          // transport hashes after strict parsing. All memberships, evidence, targets and
          // semantic constraints remain enforced below and by cross-runtime parity.
          const normalizedDecisions = parsed.decisions.map((decision) => {
            const eligibleUniverse = [...decision.eligibleUniverse].sort();
            const featureEvidence = [...decision.featureEvidence]
              .sort((left, right) => left.instrumentKey.localeCompare(right.instrumentKey))
              .map((item) => {
                if (!item.evidenceHash) return item;
                const { evidenceHash: _transportHash, ...hashableEvidence } = item;
                return { ...hashableEvidence, evidenceHash: canonicalHash(hashableEvidence) };
              });
            return {
              ...decision,
              eligibleUniverse,
              universeHash: canonicalHash({ decisionDate: decision.decisionDate, members: eligibleUniverse }),
              featureEvidence,
              featureHash: canonicalHash(featureEvidence),
            };
          });
          const normalized = finalizeRebalancePlan({
            protocolVersion: parsed.protocolVersion,
            snapshotId: parsed.snapshotId,
            featureEngineVersion: parsed.featureEngineVersion,
            sourcePlanHash: hashMultiAssetPlan(plan),
            decisions: normalizedDecisions,
          });
          finish(undefined, validateRebalancePlan(normalized, plan));
        } catch (error) {
          finish(new Error(`PYTHON_PLAN_OUTPUT_INVALID:${error instanceof Error ? error.message : String(error)}`));
        }
      })();
    });
    child.stdin.on('error', (error) => finish(new Error(`PYTHON_PLAN_INPUT_FAILED:${error.message}`)));
    child.stdin.end();
  });
  } finally {
    await rm(sandboxDir, { recursive: true, force: true });
  }
}

function resolveDefaultWorkerPath(): string {
  const moduleUrl = new URL('./rebalance_worker.py', import.meta.url);
  if (moduleUrl.protocol === 'file:') return fileURLToPath(moduleUrl);
  const candidates = [
    resolve(process.cwd(), 'server/src/multiAsset/rebalance_worker.py'),
    resolve(process.cwd(), 'src/multiAsset/rebalance_worker.py'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function cleanPythonEnvironment(): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'];
  const env: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1',
    PYTHONHASHSEED: '0', MULTI_ASSET_PYTHON_MAX_MEMORY_MB: '1024',
    MULTI_ASSET_PYTHON_MAX_CPU_SECONDS: '120',
  };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
