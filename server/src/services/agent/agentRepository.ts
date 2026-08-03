import type { Pool } from 'mysql2/promise';

export interface AgentRunRecord {
  id: string;
  prompt: string;
  status: string;
  maxTurns: number;
  timeoutMs: number;
  pid: number | null;
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

export class AgentRepository {
  constructor(private pool: Pool) {}

  async createRun(runId: string, prompt: string, maxTurns: number, timeoutMs: number): Promise<void> {
    await this.pool.execute(
      'INSERT INTO agent_runs (id, prompt, status, max_turns, timeout_ms, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [runId, prompt, 'pending', maxTurns, timeoutMs, new Date().toISOString()],
    );
  }

  async updateRunStatus(runId: string, status: string, extra?: Partial<AgentRunRecord>): Promise<void> {
    const fields: string[] = ['status = ?'];
    const values: (string | number | null)[] = [status];
    if (extra?.pid !== undefined) { fields.push('pid = ?'); values.push(extra.pid); }
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

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    const result = rows as AgentRunRecord[];
    return result[0] ?? null;
  }

  async listRuns(limit: number = 50, offset: number = 0, status?: string): Promise<AgentRunRecord[]> {
    if (status) {
      const [rows] = await this.pool.execute(
        'SELECT * FROM agent_runs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
        [status, limit, offset],
      );
      return rows as AgentRunRecord[];
    }
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows as AgentRunRecord[];
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
    return rows as AgentEventRecord[];
  }

  async saveReport(runId: string, title: string, htmlPath: string, fileSize: number, summary: string, chartsCount: number): Promise<void> {
    await this.pool.execute(
      'INSERT INTO agent_reports (run_id, title, html_path, file_size, summary, charts_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = ?, html_path = ?, file_size = ?, summary = ?, charts_count = ?',
      [runId, title, htmlPath, fileSize, summary, chartsCount, new Date().toISOString(), title, htmlPath, fileSize, summary, chartsCount],
    );
  }

  async getReport(runId: string): Promise<AgentReportRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_reports WHERE run_id = ?', [runId]);
    const result = rows as AgentReportRecord[];
    return result[0] ?? null;
  }

  async listReports(limit: number = 50, offset: number = 0): Promise<AgentReportRecord[]> {
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_reports ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [limit, offset],
    );
    return rows as AgentReportRecord[];
  }
}
