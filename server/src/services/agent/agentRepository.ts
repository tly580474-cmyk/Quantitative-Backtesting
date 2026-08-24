import type { Pool, ResultSetHeader } from 'mysql2/promise';
import type { PublicAgentEvent, TerminalPayload, TerminalStatus } from './eventProtocol.js';
import type { AgentProviderId } from './providers/types.js';

export type RunStatus = 'pending' | 'starting' | 'running' | TerminalStatus;

export interface AgentRunRecord {
  id: string;
  prompt: string;
  status: RunStatus;
  maxTurns: number;
  templateStyle: string;
  timeoutMs: number;
  pid: number | null;
  provider: AgentProviderId;
  sessionId: string | null;
  parentRunId: string | null;
  conversationId: string;
  turnIndex: number;
  protocolVersion: number;
  rootPrompt?: string;
  exitCode: number | null;
  errorMessage: string | null;
  errorCode: string | null;
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
  toolUseId: string | null;
  durationMs: number | null;
  terminal: TerminalPayload | null;
  approval: PublicAgentEvent['approval'] | null;
  protocolVersion: number;
  toolInput: string | null;
  toolResult: string | null;
  createdAt: string;
}

export interface AgentReportRecord {
  id: number; runId: string; title: string; htmlPath: string; fileSize: number | null;
  summary: string | null; tags: unknown; chartsCount: number; createdAt: string;
}

export type AgentApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'canceled';
export interface AgentApprovalRecord {
  id: string; runId: string; provider: AgentProviderId; threadId: string; turnId: string; itemId: string;
  requestType: 'command' | 'file_change' | 'network' | 'permissions'; summary: string;
  status: AgentApprovalStatus; expiresAt: string; decisionAt: string | null; createdAt: string; updatedAt: string;
}

function toCamelRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key === 'terminal_json' ? 'terminal' : key === 'approval_json' ? 'approval'
      : key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    out[camel] = (key === 'terminal_json' || key === 'approval_json') && typeof value === 'string' ? JSON.parse(value) : value;
  }
  return out as T;
}

export class AgentRepository {
  constructor(private pool: Pool) {}

  async createRun(
    runId: string, prompt: string, maxTurns: number, timeoutMs: number,
    templateStyle = 'classic-blue', parentRunId?: string,
    conversationId = runId, turnIndex = 0, provider: AgentProviderId = 'claude',
  ): Promise<void> {
    await this.pool.execute(
      `INSERT INTO agent_runs
       (id, prompt, status, max_turns, timeout_ms, template_style, parent_run_id,
        conversation_id, turn_index, provider, protocol_version, created_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
      [runId, prompt, maxTurns, timeoutMs, templateStyle, parentRunId ?? null,
        conversationId, turnIndex, provider, new Date().toISOString()],
    );
  }

  async transitionRun(
    runId: string, from: RunStatus[], status: RunStatus,
    extra: { pid?: number | null; exitCode?: number | null; errorMessage?: string | null; errorCode?: string | null } = {},
  ): Promise<boolean> {
    const fields = ['status = ?'];
    const values: Array<string | number | null> = [status];
    if ('pid' in extra) { fields.push('pid = ?'); values.push(extra.pid ?? null); }
    if ('exitCode' in extra) { fields.push('exit_code = ?'); values.push(extra.exitCode ?? null); }
    if ('errorMessage' in extra) { fields.push('error_message = ?'); values.push(extra.errorMessage ?? null); }
    if ('errorCode' in extra) { fields.push('error_code = ?'); values.push(extra.errorCode ?? null); }
    if (status === 'running') { fields.push('started_at = COALESCE(started_at, ?)'); values.push(new Date().toISOString()); }
    if (status === 'completed' || status === 'failed' || status === 'canceled') {
      fields.push('finished_at = COALESCE(finished_at, ?)'); values.push(new Date().toISOString());
    }
    const placeholders = from.map(() => '?').join(', ');
    values.push(runId, ...from);
    const [result] = await this.pool.execute(
      `UPDATE agent_runs SET ${fields.join(', ')} WHERE id = ? AND status IN (${placeholders})`, values,
    );
    return (result as ResultSetHeader).affectedRows === 1;
  }

  /** Legacy call retained for old routes; terminal states are still immutable. */
  async updateRunStatus(runId: string, status: RunStatus, extra: Partial<AgentRunRecord> = {}): Promise<void> {
    const from: RunStatus[] = status === 'starting' ? ['pending']
      : status === 'running' ? ['pending', 'starting']
      : ['pending', 'starting', 'running'];
    await this.transitionRun(runId, from, status, extra);
  }

  async updateSessionId(runId: string, sessionId: string): Promise<void> {
    await this.pool.execute('UPDATE agent_runs SET session_id = ? WHERE id = ?', [sessionId, runId]);
  }

  async reconcileOrphanedRuns(): Promise<number> {
    await this.pool.execute(
      "UPDATE agent_approvals SET status = 'canceled', decision_at = ?, updated_at = ? WHERE status = 'pending'",
      [new Date().toISOString(), new Date().toISOString()],
    );
    const [rows] = await this.pool.execute("SELECT id FROM agent_runs WHERE status IN ('starting', 'running')");
    const orphaned = rows as Array<{ id: string }>;
    for (const { id } of orphaned) {
      const changed = await this.transitionRun(id, ['starting', 'running'], 'failed', {
        errorCode: 'SERVER_RESTART', errorMessage: '服务重启，运行已中断', exitCode: null,
      });
      if (!changed) continue;
      const seq = (await this.getLastSeq(id)) + 1;
      await this.addPublicEvent(id, seq, {
        type: 'terminal', publicContent: '服务重启，运行已中断', timestamp: new Date().toISOString(),
        terminal: { status: 'failed', exitCode: null, errorCode: 'SERVER_RESTART' },
      });
    }
    return orphaned.length;
  }

  async createApproval(input: Omit<AgentApprovalRecord, 'status' | 'decisionAt' | 'createdAt' | 'updatedAt'>): Promise<AgentApprovalRecord> {
    const now = new Date().toISOString();
    await this.pool.execute(
      `INSERT INTO agent_approvals
       (id, run_id, provider, thread_id, turn_id, item_id, request_type, summary, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [input.id, input.runId, input.provider, input.threadId, input.turnId, input.itemId,
        input.requestType, input.summary, input.expiresAt, now, now],
    );
    return { ...input, status: 'pending', decisionAt: null, createdAt: now, updatedAt: now };
  }

  async getApproval(id: string): Promise<AgentApprovalRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_approvals WHERE id = ?', [id]);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? toCamelRow<AgentApprovalRecord>(row) : null;
  }

  async listPendingApprovals(runId?: string): Promise<AgentApprovalRecord[]> {
    const [rows] = await this.pool.execute(
      `SELECT * FROM agent_approvals WHERE status = 'pending' ${runId ? 'AND run_id = ?' : ''} ORDER BY created_at ASC`,
      runId ? [runId] : [],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentApprovalRecord>(row));
  }

  async decideApproval(id: string, status: Exclude<AgentApprovalStatus, 'pending'>): Promise<AgentApprovalRecord | null> {
    const now = new Date().toISOString();
    await this.pool.execute(
      `UPDATE agent_approvals SET status = ?, decision_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
      [status, now, now, id],
    );
    return this.getApproval(id);
  }

  async cancelPendingApprovals(runId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.execute(
      "UPDATE agent_approvals SET status = 'canceled', decision_at = ?, updated_at = ? WHERE run_id = ? AND status = 'pending'",
      [now, now, runId],
    );
  }

  async deleteRun(runId: string): Promise<void> {
    await this.pool.execute('DELETE FROM agent_approvals WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_events WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_reports WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_attachments WHERE run_id = ?', [runId]);
    await this.pool.execute('DELETE FROM agent_runs WHERE id = ?', [runId]);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Do not compare child.run_id directly with agent_runs.id here. Existing
      // installations may have inherited different utf8mb4 collations for
      // those columns, which makes a subquery comparison fail in MySQL.
      const [rows] = await connection.execute(
        'SELECT id FROM agent_runs WHERE conversation_id = ? FOR UPDATE', [conversationId],
      );
      const runIds = (rows as Array<{ id: string }>).map(row => row.id);
      if (runIds.length) {
        const placeholders = runIds.map(() => '?').join(', ');
        await connection.execute(`DELETE FROM agent_approvals WHERE run_id IN (${placeholders})`, runIds);
        await connection.execute(`DELETE FROM agent_events WHERE run_id IN (${placeholders})`, runIds);
        await connection.execute(`DELETE FROM agent_reports WHERE run_id IN (${placeholders})`, runIds);
        await connection.execute(`DELETE FROM agent_attachments WHERE run_id IN (${placeholders})`, runIds);
      }
      await connection.execute('DELETE FROM agent_runs WHERE conversation_id = ?', [conversationId]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_runs WHERE id = ?', [runId]);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? toCamelRow<AgentRunRecord>(row) : null;
  }

  async getConversationRuns(conversationId: string): Promise<AgentRunRecord[]> {
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY turn_index ASC', [conversationId],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentRunRecord>(row));
  }

  async getRunChain(runId: string): Promise<AgentRunRecord[]> {
    const selected = await this.getRun(runId);
    if (!selected) return [];
    const [rows] = await this.pool.execute(
      'SELECT * FROM agent_runs WHERE conversation_id = ? AND turn_index <= ? ORDER BY turn_index ASC LIMIT 200',
      [selected.conversationId, selected.turnIndex],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentRunRecord>(row));
  }

  async listRuns(limit = 50, offset = 0, status?: string): Promise<AgentRunRecord[]> {
    const safeLimit = Math.max(1, Math.min(200, limit));
    const safeOffset = Math.max(0, offset);
    const sql = status
      ? 'SELECT * FROM agent_runs WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
      : 'SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ? OFFSET ?';
    const params = status ? [status, safeLimit, safeOffset] : [safeLimit, safeOffset];
    const [rows] = await this.pool.query(sql, params);
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentRunRecord>(row));
  }

  async listConversations(limit = 30, cursor?: string): Promise<AgentRunRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const params: Array<string | number> = [];
    const cursorWhere = cursor ? 'AND latest.created_at < ?' : '';
    if (cursor) params.push(cursor);
    params.push(safeLimit);
    const [rows] = await this.pool.query(
      `SELECT latest.*, root.prompt AS root_prompt FROM agent_runs latest
       JOIN (SELECT conversation_id, MAX(turn_index) AS max_turn FROM agent_runs GROUP BY conversation_id) leaf
         ON leaf.conversation_id = latest.conversation_id AND leaf.max_turn = latest.turn_index
       JOIN agent_runs root ON root.conversation_id = latest.conversation_id AND root.turn_index = 0
       WHERE 1=1 ${cursorWhere} ORDER BY latest.created_at DESC LIMIT ?`, params,
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentRunRecord>(row));
  }

  async listConversationTurns(conversationId: string, limit = 20, beforeTurn?: number): Promise<AgentRunRecord[]> {
    const safeLimit = Math.max(1, Math.min(100, limit));
    const [rows] = await this.pool.query(
      `SELECT * FROM agent_runs WHERE conversation_id = ? ${beforeTurn == null ? '' : 'AND turn_index < ?'}
       ORDER BY turn_index DESC LIMIT ?`,
      beforeTurn == null ? [conversationId, safeLimit] : [conversationId, beforeTurn, safeLimit],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentRunRecord>(row)).reverse();
  }

  async addPublicEvent(runId: string, seq: number, event: PublicAgentEvent): Promise<void> {
    await this.pool.execute(
      `INSERT INTO agent_events
       (run_id, seq, event_type, content, tool_name, tool_use_id, duration_ms, terminal_json, approval_json,
        protocol_version, tool_input, tool_result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, NULL, NULL, ?)`,
      [runId, seq, event.type, event.publicContent, event.toolName ?? null, event.toolUseId ?? null,
        event.durationMs ?? null, event.terminal ? JSON.stringify(event.terminal) : null,
        event.approval ? JSON.stringify(event.approval) : null, event.timestamp],
    );
  }

  async getEvents(runId: string, afterSeq = -1, limit = 10_000): Promise<AgentEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(limit)));
    const [rows] = await this.pool.execute(
      `SELECT * FROM agent_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ${safeLimit}`,
      [runId, Math.max(-1, afterSeq)],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentEventRecord>(row));
  }

  async getLastSeq(runId: string): Promise<number> {
    const [rows] = await this.pool.execute('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_events WHERE run_id = ?', [runId]);
    return Number((rows as Array<{ seq: number }>)[0]?.seq ?? 0);
  }

  async saveReport(runId: string, title: string, htmlPath: string, fileSize: number, summary: string, chartsCount: number): Promise<void> {
    await this.pool.execute(
      `INSERT INTO agent_reports (run_id, title, html_path, file_size, summary, charts_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       title = ?, html_path = ?, file_size = ?, summary = ?, charts_count = ?`,
      [runId, title, htmlPath, fileSize, summary, chartsCount, new Date().toISOString(),
        title, htmlPath, fileSize, summary, chartsCount],
    );
  }

  async getReport(runId: string): Promise<AgentReportRecord | null> {
    const [rows] = await this.pool.execute('SELECT * FROM agent_reports WHERE run_id = ?', [runId]);
    const row = (rows as Record<string, unknown>[])[0];
    return row ? toCamelRow<AgentReportRecord>(row) : null;
  }

  async listReports(limit = 50, offset = 0): Promise<AgentReportRecord[]> {
    const [rows] = await this.pool.query(
      'SELECT * FROM agent_reports ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [Math.max(1, Math.min(200, limit)), Math.max(0, offset)],
    );
    return (rows as Record<string, unknown>[]).map(row => toCamelRow<AgentReportRecord>(row));
  }

  async getMetrics(): Promise<{ statuses: Record<string, number>; events: number; eventBytes: number; conversations: number }> {
    const [[statusRows], [eventRows], [conversationRows]] = await Promise.all([
      this.pool.query('SELECT status, COUNT(*) AS count FROM agent_runs GROUP BY status'),
      this.pool.query('SELECT COUNT(*) AS count, COALESCE(SUM(CHAR_LENGTH(content)), 0) AS bytes FROM agent_events'),
      this.pool.query('SELECT COUNT(DISTINCT conversation_id) AS count FROM agent_runs'),
    ]);
    const statuses = Object.fromEntries((statusRows as Array<{ status: string; count: number }>).map(row => [row.status, Number(row.count)]));
    const event = (eventRows as Array<{ count: number; bytes: number }>)[0];
    const conversation = (conversationRows as Array<{ count: number }>)[0];
    return { statuses, events: Number(event?.count ?? 0), eventBytes: Number(event?.bytes ?? 0), conversations: Number(conversation?.count ?? 0) };
  }
}
