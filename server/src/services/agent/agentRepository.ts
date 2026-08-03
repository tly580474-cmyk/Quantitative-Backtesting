import type { Pool } from 'mysql2/promise';

export interface AgentRunRecord {
  id: string;
  prompt: string;
  status: string;
  maxTurns: number;
  templateStyle: string;
  timeoutMs: number;
  pid: number | null;
  sessionId: string | null;
  parentRunId: string | null;
  exitCode: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AgentEventRecord {
  id: number;
  runId: string;
  seq: number;
  eventType: string;
  content: string;
  toolName: string | null;
  toolInput: string | null;
  toolResult: string | null;
  createdAt: string;
}

export interface AgentReportRecord {
  id: number;
  runId: string;
  title: string;
  htmlPath: string;
  fileSize: number | null;
  summary: string | null;
  tags: unknown;
  chartsCount: number;
  createdAt: string;
}

// 将 snake_case 字段名转换为驼峰式，供 SELECT * 返回的行使用
function toCamelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    out[camel] = v;
  }
  return out as T;
}

export class AgentRepository {
  constructor(private pool: Pool) {}

  async createRun(runId: string, prompt: string, maxTurns: number, timeoutMs: number, templateStyle: string = 'classic-blue', parentRunId?: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO agent_runs (id, prompt, status, max_turns, timeout_ms, template_style, parent_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [runId, prompt, 'pending', maxTurns, timeoutMs, templateStyle, parentRunId ?? null, new Date().toISOString()],
    );
  }

  async updateRunStatus(runId: string, status: string, extra?: Partial<AgentRunRecord>): Promise<void> {
    const fields: string[] = ['status = ?'];
    const values: (string | number | null)[] = [status];
    if (extra?.pid !== undefined) { fields.push('pid = ?'); values.push(extra.pid); }
    if (extra?.sessionId !== undefined) { fields.push('session_id = ?'); values.push(extra.sessionId); }
    if (extra?.exitCode !== undefined) { fields.push('exit_code = ?'); values.push(extra.exitCode); }
    if (extra?.errorMessage !== undefined) { fields.push('error_message = ?'); values.push(extra.errorMessage); }
    if (status === 'running' && !extra?.startedAt) { fields.push('started_at = ?'); values.push(new Date().toISOString()); }
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      fields.push('finished_at = ?'); values.push(new Date().toISOString());
    }
    values.push(runId);
    await this.pool.execute(
      `UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ?`,
      values,
    );
  }

  async updateSessionId(runId: string, sessionId: string): Promise<void> {
    await this.pool.execute(
      'UPDATE agent_runs SET session_id = ? WHERE id = ?',
      [sessionId, runId],
    );
  }

  async deleteRun(runId: string): Promise<void> {
    // Delete in order: events, reports, then the run itself
    await this.pool.execute('DELETE FROM agent_events WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_reports WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    const result = rows as Record<string, unknown>[];
    return result[0] ? toCamelRow<AgentRunRecord>(result[0]) : null;
  }

  async listRuns(limit: number = 50, offset: number = 0, status?: string): Promise<AgentRunRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const safeOffset = Math.max(0, offset);
    if (status) {
      const [rows] = await this.pool.query(
        'SELECT * FROM agent_runs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [status, safeLimit, safeOffset],
      );
      return (rows as Record<string, unknown>[]).map(r => toCamelRow<AgentRunRecord>(r));
    }
    const [rows] = await this.pool.query(
      'SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [safeLimit, safeOffset],
    );
    return (rows as Record<string, unknown>[]).map(r => toCamelRow<AgentRunRecord>(r));
  }

  async addEvent(runId: string, seq: number, eventType: string, content: string, toolName?: string, toolInput?: string, toolResult?: string): Promise<void> {
    await this.pool.execute(
      'INSERT INTO agent_events (run_id, seq, event_type, content, tool_name, tool_input, tool_result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [runId, seq, eventType, content, toolName ?? null, toolInput ?? null, toolResult ?? null, new Date().toISOString()],
    );
  }

  async getEvents(runId: string): Promise<AgentEventRecord[]> {
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_events WHERE run_id = ? ORDER BY seq ASC',
      [runId],
    );
    return (rows as Record<string, unknown>[]).map(r => toCamelRow<AgentEventRecord>(r));
  }

  async saveReport(runId: string, title: string, htmlPath: string, fileSize: number, summary: string, chartsCount: number): Promise<void> {
    await this.pool.execute(
      'INSERT INTO agent_reports (run_id, title, html_path, file_size, summary, charts_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = ?, html_path = ?, file_size = ?, summary = ?, charts_count = ?',
      [runId, title, htmlPath, fileSize, summary, chartsCount, new Date().toISOString(), title, htmlPath, fileSize, summary, chartsCount],
    );
  }

  async getReport(runId: string): Promise<AgentReportRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_reports WHERE run_id = ?', [runId]);
    const result = rows as Record<string, unknown>[];
    return result[0] ? toCamelRow<AgentReportRecord>(result[0]) : null;
  }

  async listReports(limit: number = 50, offset: number = 0): Promise<AgentReportRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const safeOffset = Math.max(0, offset);
    const [rows] = await this.pool.query(
      'SELECT * FROM agent_reports ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [safeLimit, safeOffset],
    );
    return (rows as Record<string, unknown>[]).map(r => toCamelRow<AgentReportRecord>(r));
  }
}
