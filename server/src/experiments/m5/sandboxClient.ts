import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { z } from 'zod';

// Docker Desktop 的 CLI 安装路径
const DOCKER_CLI_PATHS = [
  'C:\\Users\\qjmzc\\AppData\\Local\\Programs\\DockerDesktop\\resources\\bin\\docker.exe',
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
];

const SANDBOX_IMAGE = 'quant-sandbox:dev';

const sandboxRequestSchema = z.object({
  protocolVersion: z.literal('1.0'),
  code: z.string().min(1),
  humanApprovalId: z.string().min(1),
  input: z.unknown().optional(),
});

const sandboxResponseSchema = z.object({
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

export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;
export type SandboxResponse = z.infer<typeof sandboxResponseSchema>;

/**
 * 在 Docker 沙箱容器中执行任意 Python 代码。
 *
 * 直接调用 docker CLI，不经过 PowerShell 中间层，避免弹出命令行窗口。
 * 沙箱提供网络隔离、只读文件系统、seccomp 限制、非 root 用户、
 * 进程数上限和内存上限。结果固定标记为 `exploration_only` 和
 * `publishable=false`，不能绕过权威复算和人工审批。
 */
export async function runInSandbox(input: {
  request: SandboxRequest;
  enabled: boolean;
  imageTag?: string;
  timeoutMs?: number;
}): Promise<SandboxResponse> {
  if (!input.enabled) throw new Error('ARBITRARY_PYTHON_DISABLED');
  const request = sandboxRequestSchema.parse(input.request);
  const output = await invokeDocker(JSON.stringify(request), input.timeoutMs ?? 60_000);
  const parsed = sandboxResponseSchema.parse(JSON.parse(output));
  if (parsed.humanApprovalId !== request.humanApprovalId) {
    throw new Error('SANDBOX_APPROVAL_MISMATCH');
  }
  return parsed;
}

function dockerExecutable(): string {
  for (const p of DOCKER_CLI_PATHS) {
    if (existsSync(p)) return p;
  }
  // 回退到 PATH 中的 docker
  return 'docker';
}

async function invokeDocker(stdin: string, timeoutMs: number): Promise<string> {
  const docker = dockerExecutable();
  const image = SANDBOX_IMAGE;
  const args = [
    'run', '--rm', '-i',
    '--network=none',
    '--read-only',
    '--user=65532:65532',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--pids-limit=16',
    '--memory=256m',
    '--cpus=1',
    '--stop-timeout=1',
    '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m',
    image,
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
    throw new Error(`SANDBOX_CLIENT_FAILED:${code}:${stderrText || stdoutText}`);
  }
  // 沙箱协议可能输出多行 JSON（fork bomb 等场景），取最后一行作为结果
  const lines = stdoutText.split('\n').filter((l) => l.trim().startsWith('{'));
  return lines[lines.length - 1] ?? stdoutText;
}