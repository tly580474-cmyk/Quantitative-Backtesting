import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const RESEARCH_KEYS = new Set([
  'RESEARCH_SNAPSHOT_MORNING_RETRY_TIME',
  'RESEARCH_SNAPSHOT_UPDATE_TIME',
  'RESEARCH_SNAPSHOT_RETRY_TIME',
]);

const MINUTE_KEYS = new Set([
  'MINUTE_DATA_UPDATE_TIME',
  'MINUTE_DATA_RETRY_TIME',
]);

export interface ScheduleSyncResult {
  updatedTasks: string[];
  warnings: string[];
}

export async function synchronizeScheduleConfig(
  updatedKeys: string[],
  values: NodeJS.ProcessEnv = process.env,
): Promise<ScheduleSyncResult> {
  const needsResearch = updatedKeys.some((key) => RESEARCH_KEYS.has(key));
  const needsMinute = updatedKeys.some((key) => MINUTE_KEYS.has(key));
  if (!needsResearch && !needsMinute) return { updatedTasks: [], warnings: [] };
  if (process.platform !== 'win32') {
    return {
      updatedTasks: [],
      warnings: ['计划任务时间已保存，但当前系统不是 Windows，请在部署主机重新注册计划任务。'],
    };
  }

  const invocations: Array<{ taskName: string; script: URL; args: string[] }> = [];
  if (needsResearch) {
    invocations.push({
      taskName: 'QuantBacktest-ResearchSnapshot',
      script: new URL('../research/register-research-task.ps1', import.meta.url),
      args: [
        '-MorningRetryAt', values.RESEARCH_SNAPSHOT_MORNING_RETRY_TIME || '08:30',
        '-At', values.RESEARCH_SNAPSHOT_UPDATE_TIME || '18:00',
        '-RetryAt', values.RESEARCH_SNAPSHOT_RETRY_TIME || '18:30',
      ],
    });
  }
  if (needsMinute) {
    invocations.push({
      taskName: 'QuantBacktest-MinuteUpdate',
      script: new URL('../minuteData/register-task.ps1', import.meta.url),
      args: [
        '-At', values.MINUTE_DATA_UPDATE_TIME || '16:30',
        '-RetryAt', values.MINUTE_DATA_RETRY_TIME || '17:30',
      ],
    });
  }

  const updatedTasks: string[] = [];
  const warnings: string[] = [];
  for (const invocation of invocations) {
    try {
      await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', fileURLToPath(invocation.script),
        ...invocation.args,
      ]);
      updatedTasks.push(invocation.taskName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${invocation.taskName} 重新注册失败：${message}`);
    }
  }
  return { updatedTasks, warnings };
}
