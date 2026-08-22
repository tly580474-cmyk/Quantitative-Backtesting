import { spawn, type ChildProcess } from 'node:child_process';

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
  } else {
    child.kill('SIGTERM');
  }
}
