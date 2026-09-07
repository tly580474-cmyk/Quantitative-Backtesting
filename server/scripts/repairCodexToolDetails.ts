import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool, closePool } from '../src/db/connection.js';
import { AgentRepository } from '../src/services/agent/agentRepository.js';
import { recoverCodexToolDetails } from '../src/services/agent/codexHistoryDetails.js';

async function main() {
  const [runId, option] = process.argv.slice(2);
  if (!/^[a-f0-9-]{36}$/i.test(runId ?? '') || (option && option !== '--apply')) throw new Error('用法：tsx scripts/repairCodexToolDetails.ts <runId> [--apply]');
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const repo = new AgentRepository(pool);
    const run = await repo.getRun(runId);
    if (!run || run.provider !== 'codex' || !run.sessionId || !['completed', 'failed', 'canceled'].includes(run.status)) throw new Error('目标必须是已结束的 Codex 回合');
    if (!config.AGENT_CODEX_HOME) throw new Error('项目独立 CODEX_HOME 未配置');
    const paths: string[] = [];
    async function visit(dir: string) {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        if (item.isDirectory()) await visit(join(dir, item.name));
        else if (item.isFile() && item.name.endsWith(`-${run!.sessionId}.jsonl`)) paths.push(join(dir, item.name));
      }
    }
    await visit(join(config.AGENT_CODEX_HOME, 'sessions'));
    if (paths.length !== 1) throw new Error('未找到唯一匹配的项目会话日志');
    const details = recoverCodexToolDetails((await readFile(paths[0], 'utf8')).split('\n'), run.sessionId);
    const events = await repo.getEvents(runId);
    const repairs = events.flatMap(event => {
      const detail = event.toolUseId ? details.get(event.toolUseId) : undefined;
      if (!detail || !['tool_started', 'tool_finished', 'error'].includes(event.eventType)) return [];
      const input = !event.toolInput ? detail.toolInput : undefined;
      const output = event.eventType !== 'tool_started' && !event.toolResult ? detail.toolResult : undefined;
      return input || output ? [{ id: event.id, input, output, callId: event.toolUseId }] : [];
    });
    if (option === '--apply') {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const repair of repairs) await connection.execute(
          `UPDATE agent_events SET tool_input = COALESCE(NULLIF(tool_input, ''), ?),
           tool_result = COALESCE(NULLIF(tool_result, ''), ?) WHERE id = ? AND run_id = ?`,
          [repair.input ?? null, repair.output ?? null, repair.id, runId],
        );
        await connection.commit();
      } catch (error) { await connection.rollback(); throw error; }
      finally { connection.release(); }
    }
    console.log(JSON.stringify({ runId, mode: option === '--apply' ? 'applied' : 'dry-run',
      events: repairs.length, calls: new Set(repairs.map(item => item.callId)).size }));
  } finally { await closePool(pool); }
}
main().catch(() => { console.error('恢复失败；请检查目标回合、项目日志和数据库连接。未输出敏感日志。'); process.exitCode = 1; });
