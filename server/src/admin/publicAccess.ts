import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptPath = resolve(process.cwd(), 'src/admin/publicAccess.ps1');

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

async function invoke(action: 'status' | 'enable' | 'disable'): Promise<PublicAccessStatus> {
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

export const publicAccessControl = {
  status: () => invoke('status'),
  setEnabled: (enabled: boolean) => invoke(enabled ? 'enable' : 'disable'),
};
