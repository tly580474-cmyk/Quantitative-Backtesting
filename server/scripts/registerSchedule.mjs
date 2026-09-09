import { spawnSync } from 'node:child_process';
const job = process.argv[2];
const scripts = { research: 'src/research/register-research-task.ps1', minute: 'src/minuteData/register-task.ps1',
  'fund-flow': 'src/fundFlow/register-task.ps1', 'tdx-shadow': 'src/minuteData/register-tdx-shadow-task.ps1' };
if (!scripts[job]) throw new Error('Unknown schedule');
const result = process.platform === 'win32'
  ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scripts[job], ...process.argv.slice(3)], { stdio: 'inherit' })
  : spawnSync('systemctl', ['is-active', `quant-job@${job}.timer`], { stdio: 'inherit' });
if (process.platform !== 'win32') console.log('Linux timer reads server/.env every minute. Install/enable using deploy/linux/install.sh as root.');
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
