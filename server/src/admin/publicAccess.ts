import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = resolve(process.cwd(), 'src/admin/publicAccess.ps1');
const defaultStateFilePath = resolve(process.cwd(), 'data/admin/public-access.json');

export interface PublicAccessTaskStatus {
  name: string;
  found: boolean;
  enabled: boolean;
  running: boolean;
  state: string;
}

export interface PublicAccessStatus {
  available: boolean;
  enabled: boolean;
  running: boolean;
  domain: string;
  tasks: PublicAccessTaskStatus[];
  message: string | null;
}

type PublicAccessAction = 'status' | 'enable' | 'disable';

interface PersistedPublicAccessState {
  enabled: boolean;
  updatedAt: string;
}

interface PublicAccessControlOptions {
  invoke?: (action: PublicAccessAction) => Promise<PublicAccessStatus>;
  stateFilePath?: string;
}

async function invokePowerShell(action: PublicAccessAction): Promise<PublicAccessStatus> {
  if (process.platform !== 'win32') {
    return {
      available: false,
      enabled: false,
      running: false,
      domain: 'https://stock.clical.xin',
      tasks: [],
      message: '公网访问任务控制仅支持 Windows 主机',
    };
  }
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Action', action,
  ], { windowsHide: true, timeout: 20_000, encoding: 'utf8' });
  const json = stdout.trim().split(/\r?\n/).at(-1);
  if (!json) throw new Error('公网访问任务未返回状态');
  return JSON.parse(json) as PublicAccessStatus;
}

async function readPersistedState(stateFilePath: string): Promise<PersistedPublicAccessState | null> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath, 'utf8')) as Partial<PersistedPublicAccessState>;
    if (typeof parsed.enabled !== 'boolean') {
      return { enabled: false, updatedAt: '' };
    }
    return {
      enabled: parsed.enabled,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (error instanceof SyntaxError) return { enabled: false, updatedAt: '' };
    throw error;
  }
}

async function persistState(stateFilePath: string, enabled: boolean): Promise<void> {
  await mkdir(dirname(stateFilePath), { recursive: true });
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({
    enabled,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, stateFilePath);
}

export function createPublicAccessControl(options: PublicAccessControlOptions = {}) {
  const invoke = options.invoke ?? invokePowerShell;
  const stateFilePath = options.stateFilePath ?? defaultStateFilePath;

  const status = async (): Promise<PublicAccessStatus> => {
    const [current, desired] = await Promise.all([
      invoke('status'),
      readPersistedState(stateFilePath),
    ]);

    if (!desired) {
      await persistState(stateFilePath, current.enabled);
      return current;
    }

    // “关闭”是安全侧状态：如果计划任务被系统或外部流程重新启用，立即纠正。
    if (!desired.enabled && (current.enabled || current.running)) {
      return invoke('disable');
    }
    return current;
  };

  return {
    status,
    reconcile: status,
    setEnabled: async (enabled: boolean): Promise<PublicAccessStatus> => {
      if (!enabled) {
        // 先落盘再停任务，确保即使停任务过程失败，下一次启动仍会继续执行关闭意图。
        await persistState(stateFilePath, false);
        return invoke('disable');
      }
      const result = await invoke('enable');
      await persistState(stateFilePath, true);
      return result;
    },
  };
}

export const publicAccessControl = createPublicAccessControl();
