import { spawn, type ChildProcess } from 'node:child_process';

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).unref();
  } else {
    // Providers create a separate POSIX process group so tools are canceled too.
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { child.kill('SIGTERM'); }
    const pid = child.pid;
    const timer = setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch { /* Group already exited. */ }
    }, 5_000);
    timer.unref();
  }
}
