import { spawn, type ChildProcess } from 'child_process';
import { mkdir, readFile, stat } from 'fs/promises';
import { resolve } from 'path';
import type { Pool } from 'mysql2/promise';
import { buildPrompt } from './promptBuilder.js';
import { parseStreamLine, extractReportInfo, type ParsedEvent } from './outputParser.js';
import { AgentRepository } from './agentRepository.js';

export interface OrchestratorConfig {
  wslProjectPath: string;
  claudePath: string;
  reportRoot: string;
  maxConcurrent: number;
}

export interface StartParams {
  runId: string;
  prompt: string;
  maxTurns: number;
  timeoutMs: number;
}

interface ActiveRun {
  process: ChildProcess;
  seq: number;
}

export class AgentOrchestrator {
  private activeRuns = new Map<string, ActiveRun>();
  private eventListeners = new Map<string, Set<(event: ParsedEvent) => void>>();

  constructor(
    private pool: Pool,
    private config: OrchestratorConfig,
  ) {}

  async start(params: StartParams): Promise<void> {
    // Check concurrency
    if (this.activeRuns.size >= this.config.maxConcurrent) {
      throw new Error('已达到最大并发数，请等待当前任务完成');
    }

    const repo = new AgentRepository(this.pool);
    const { runId, prompt, maxTurns, timeoutMs } = params;

    // Build full prompt
    const fullPrompt = buildPrompt(prompt, this.config.wslProjectPath);

    // Ensure report directory exists
    const reportDir = resolve(this.config.reportRoot, 'reports');
    await mkdir(reportDir, { recursive: true });

    // Build command args
    const args = [
      this.config.wslProjectPath ? `-d ${this.config.wslProjectPath}` : '',
      '--dangerously-skip-permissions',
      '-p', fullPrompt,
      '--output-format', 'stream-json',
      '--max-turns', String(maxTurns),
    ].filter(Boolean);

    // Start process
    const child = spawn(this.config.claudePath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.wslProjectPath || undefined,
    });

    const run: ActiveRun = { process: child, seq: 0 };
    this.activeRuns.set(runId, run);

    await repo.updateRunStatus(runId, 'running', { pid: child.pid ?? null });

    // Set timeout
    const timer = setTimeout(() => {
      this.cancel(runId);
    }, timeoutMs);

    // Stream stdout
    let buffer = '';
    child.stdout?.on('data', async (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const event = parseStreamLine(line);
        if (!event) continue;

        run.seq++;
        await repo.addEvent(
          runId, run.seq, event.type, event.content,
          event.toolName, event.toolInput, event.toolResult,
        );
        this.notifyListeners(runId, event);
      }
    });

    // Stream stderr
    child.stderr?.on('data', async (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      run.seq++;
      const event: ParsedEvent = { type: 'error', content: text };
      await repo.addEvent(runId, run.seq, 'error', text);
      this.notifyListeners(runId, event);
    });

    // Process exit
    child.on('close', async (exitCode) => {
      clearTimeout(timer);
      this.activeRuns.delete(runId);

      const status = exitCode === 0 ? 'completed' : 'failed';
      await repo.updateRunStatus(runId, status, { exitCode });

      // If completed, check for HTML report
      if (exitCode === 0) {
        await this.tryExtractReport(runId, repo);
      }

      // Notify done
      this.notifyListeners(runId, { type: 'done', content: `Process exited with code ${exitCode}` });
    });

    // Handle errors
    child.on('error', async (err) => {
      clearTimeout(timer);
      this.activeRuns.delete(runId);
      await repo.updateRunStatus(runId, 'failed', { errorMessage: err.message });
      this.notifyListeners(runId, { type: 'error', content: err.message });
    });
  }

  private async tryExtractReport(runId: string, repo: AgentRepository): Promise<void> {
    try {
      const reportPath = resolve(this.config.reportRoot, 'reports', `${runId}.html`);
      const stats = await stat(reportPath);
      const html = await readFile(reportPath, 'utf-8');
      const { title, summary } = extractReportInfo(html);
      await repo.saveReport(runId, title, reportPath, stats.size, summary, 0);
    } catch {
      // Report file not found or error reading — skip
    }
  }

  cancel(runId: string): void {
    const run = this.activeRuns.get(runId);
    if (run) {
      run.process.kill('SIGTERM');
      this.activeRuns.delete(runId);
    }
  }

  isRunning(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  addEventListener(runId: string, listener: (event: ParsedEvent) => void): () => void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Set());
    }
    this.eventListeners.get(runId)!.add(listener);
    return () => {
      this.eventListeners.get(runId)?.delete(listener);
    };
  }

  private notifyListeners(runId: string, event: ParsedEvent): void {
    const listeners = this.eventListeners.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  }
}
