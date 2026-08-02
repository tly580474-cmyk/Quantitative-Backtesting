import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';

// 阶段 C：研究代码沙箱客户端（与 M5 纯标准库沙箱同协议，但镜像内置
// duckdb/pandas/pymysql，并授予只读数据访问：MySQL 只读账号 + 快照/分钟数据只读挂载）。
// 结果恒标记 authority=exploration_only / publishable=false（ADR-05），不可直接入册。

// Docker Desktop 的 CLI 安装路径
const DOCKER_CLI_PATHS = [
  'C:\\Users\\qjmzc\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe',
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
];

export const researchCodeRequestSchema = z.object({
  protocolVersion: z.literal('1.0'),
  code: z.string().min(1),
  humanApprovalId: z.string().min(1),
  input: z.unknown().optional(),
});

export const researchCodeResponseSchema = z.object({
  protocolVersion: z.literal('1.0'),
  status: z.enum(['completed', 'failed', 'rejected']),
  authority: z.literal('exploration_only'),
  publishable: z.literal(false),
  humanApprovalId: z.string().min(1),
  codeHash: z.string().regex(/^[a-f0-9]{64}$/),
  resultHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.unknown().nullable(),
  capturedOutput: z.string(),
  error: z.object({
    type: z.string(),
    message: z.string(),
    traceback: z.string().optional(),
  }).nullable(),
});

export type ResearchCodeRequest = z.infer<typeof researchCodeRequestSchema>;
export type ResearchCodeResponse = z.infer<typeof researchCodeResponseSchema>;

export interface ResearchCodeRuntimeOptions {
  enabled: boolean;
  imageTag: string;
  /** 只读 MySQL 账号密码（账号固定 quant_research_ro，仅 SELECT） */
  readonlyDbPassword: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  /** 宿主绝对路径：DuckDB 日频研究快照（只读挂载到 /data/research） */
  researchSnapshotRoot: string;
  /** 宿主绝对路径：分钟数据 parquet 湖（只读挂载到 /data/minute） */
  minuteDataRoot: string;
  maxSeconds: number;
  maxMemoryMb: number;
  maxOutputBytes: number;
}

/**
 * 在只读数据沙箱中执行研究代码。
 *
 * 安全姿态：
 * - 只读 MySQL 账号（SELECT only）+ 快照/分钟数据只读挂载；
 * - 容器无宿主写路径、无其他凭据；cap-drop ALL + no-new-privileges + 资源上限；
 * - 网络仅用于连接宿主 MySQL（host.docker.internal）；注意 bridge 下容器理论上可出网，
 *   但只读账号与无密钥约束使其无实际破坏面（见对齐评估文档阶段 C）。
 * - 结果固定标记 exploration_only / publishable=false。
 */
export async function runResearchCode(
  input: {
    request: ResearchCodeRequest;
    options: ResearchCodeRuntimeOptions;
    timeoutMs?: number;
  },
): Promise<ResearchCodeResponse> {
  const { options } = input;
  if (!options.enabled) throw new Error('RESEARCH_CODE_DISABLED');
  const request = researchCodeRequestSchema.parse(input.request);
  const output = await invokeDocker(JSON.stringify(request), options, input.timeoutMs ?? options.maxSeconds * 1000);
  const parsed = researchCodeResponseSchema.parse(JSON.parse(output));
  if (parsed.humanApprovalId !== request.humanApprovalId) {
    throw new Error('RESEARCH_CODE_APPROVAL_MISMATCH');
  }
  return parsed;
}

function dockerExecutable(): string {
  for (const p of DOCKER_CLI_PATHS) {
    if (existsSync(p)) return p;
  }
  return 'docker';
}

function toDockerMountPath(hostPath: string): string {
  return hostPath.replace(/\\/g, '/');
}

async function invokeDocker(stdin: string, options: ResearchCodeRuntimeOptions, timeoutMs: number): Promise<string> {
  const docker = dockerExecutable();
  const researchMount = `${toDockerMountPath(options.researchSnapshotRoot)}:/data/research:ro`;
  const minuteMount = `${toDockerMountPath(options.minuteDataRoot)}:/data/minute:ro`;
  const args = [
    'run', '--rm', '-i',
    '--network=bridge',
    '--add-host=host.docker.internal:host-gateway',
    '--read-only',
    '--user=65532:65532',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=16',
    `--memory=${options.maxMemoryMb}m`,
    '--cpus=1',
    '--stop-timeout=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m',
    '-v', researchMount,
    '-v', minuteMount,
    '-e', `DB_HOST=host.docker.internal`,
    '-e', `DB_PORT=${options.dbPort}`,
    '-e', 'DB_USER=quant_research_ro',
    '-e', `DB_PASSWORD=${options.readonlyDbPassword}`,
    '-e', `DB_NAME=${options.dbName}`,
    '-e', 'RESEARCH_PARQUET=/data/research',
    '-e', 'MINUTE_PARQUET=/data/minute',
    '-e', `SANDBOX_MAX_OUTPUT_BYTES=${options.maxOutputBytes}`,
    options.imageTag,
  ];
  const child = spawn(docker, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
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
  const stderrText = Buffer.concat(stderr).toString('utf8').trim();
  const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
  if (code !== 0 && code !== 78) {
    throw new Error(`RESEARCH_CODE_CLIENT_FAILED:${code}:${stderrText || stdoutText}`);
  }
  const lines = stdoutText.split('\n').filter((l) => l.trim().startsWith('{'));
  return lines[lines.length - 1] ?? stdoutText;
}
