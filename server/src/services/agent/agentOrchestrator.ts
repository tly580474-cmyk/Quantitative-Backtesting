import { spawn, type ChildProcess } from 'child_process';
import { mkdir, readFile, stat, writeFile, unlink } from 'fs/promises';
import { resolve, join } from 'path';
import { tmpdir } from 'os';
import type { Pool } from 'mysql2/promise';
import { buildPrompt, type TemplateStyle } from './promptBuilder.js';
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
  templateStyle?: string;
}

interface ActiveRun {
  process: ChildProcess;
  seq: number;
}

export class AgentOrchestrator {
  private activeRuns = new Map<string, ActiveRun>();
  private eventListeners = new Map<string, Set<(event: ParsedEvent, seq: number) => void>>();

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
    const winReportDir = resolve(this.config.reportRoot, 'reports');
    const winReportPath = resolve(winReportDir, `${runId}.html`);
    // Convert Windows path to WSL path (e.g. D:\foo\bar -> /mnt/d/foo/bar)
    const wslReportPath = winReportPath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);
    const fullPrompt = buildPrompt(prompt, this.config.wslProjectPath, params.templateStyle as TemplateStyle, wslReportPath);

    // Ensure report directory exists
    await mkdir(winReportDir, { recursive: true });

    // Write prompt to a temp file to avoid bash quoting/escaping issues when
    // passing a long multi-line prompt through Windows spawn -> wsl.exe -> bash.
    // Previous approach (single-quoted prompt on the bash command line) broke
    // because Windows arg passing mangles embedded newlines/quotes, causing the
    // prompt body to be interpreted as bash commands.
    const tmpPromptWinPath = join(tmpdir(), `agent-prompt-${runId}.txt`);
    await writeFile(tmpPromptWinPath, fullPrompt, 'utf-8');
    const tmpPromptWslPath = tmpPromptWinPath
      .replace(/\\/g, '/')
      .replace(/^([A-Za-z]):/, (_, d) => `/mnt/${d.toLowerCase()}`);

    // Build claude args — prompt is piped via stdin to avoid all shell interpretation.
    const escapedPath = this.config.wslProjectPath
      ? `-d '${this.config.wslProjectPath.replace(/'/g, "'\\''")}'`
      : '';
    const escapedTmpPath = tmpPromptWslPath.replace(/'/g, "'\\''");
    const claudeArgs = [
      escapedPath,
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--max-turns', String(maxTurns),
    ].filter(Boolean).join(' ');

    // cat the prompt file into claude's stdin; --print enables non-interactive mode
    // and reads the prompt from stdin when no -p argument is provided.
    const bashCmd = `cat '${escapedTmpPath}' | ${this.config.claudePath} ${claudeArgs}`;

    // Start process via WSL bash
    const child = spawn('wsl', ['bash', '-c', bashCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
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
        event.timestamp = new Date().toISOString();

        run.seq++;
        await repo.addEvent(
          runId, run.seq, event.type, event.content,
          event.toolName, event.toolInput, event.toolResult,
        );
        this.notifyListeners(runId, event, run.seq);
      }
    });

    // Stream stderr
    child.stderr?.on('data', async (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (!text) return;
      run.seq++;
      const event: ParsedEvent = { type: 'error', content: text, timestamp: new Date().toISOString() };
      await repo.addEvent(runId, run.seq, 'error', text);
      this.notifyListeners(runId, event, run.seq);
    });

    // Process exit
    child.on('close', async (exitCode) => {
      clearTimeout(timer);
      this.activeRuns.delete(runId);

      // Clean up temp prompt file
      unlink(tmpPromptWinPath).catch(() => {});

      const status = exitCode === 0 ? 'completed' : 'failed';
      await repo.updateRunStatus(runId, status, { exitCode });

      // If completed, check for HTML report
      if (exitCode === 0) {
        await this.tryExtractReport(runId, repo);
      }

      // Notify done
      this.notifyListeners(runId, { type: 'done', content: `Process exited with code ${exitCode}`, timestamp: new Date().toISOString() }, run.seq);
    });

    // Handle errors
    child.on('error', async (err) => {
      clearTimeout(timer);
      this.activeRuns.delete(runId);
      // Clean up temp prompt file
      unlink(tmpPromptWinPath).catch(() => {});
      await repo.updateRunStatus(runId, 'failed', { errorMessage: err.message });
      this.notifyListeners(runId, { type: 'error', content: err.message, timestamp: new Date().toISOString() }, run.seq);
    });
  }

  private async tryExtractReport(runId: string, repo: AgentRepository): Promise<void> {
    try {
      const winReportPath = resolve(this.config.reportRoot, 'reports', `${runId}.html`);
      const stats = await stat(winReportPath);
      const html = await readFile(winReportPath, 'utf-8');
      const { title, summary } = extractReportInfo(html);
      await repo.saveReport(runId, title, winReportPath, stats.size, summary, 0);
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

  addEventListener(runId: string, listener: (event: ParsedEvent, seq: number) => void): () => void {
    if (!this.eventListeners.has(runId)) {
      this.eventListeners.set(runId, new Set());
    }
    this.eventListeners.get(runId)!.add(listener);
    return () => {
      this.eventListeners.get(runId)?.delete(listener);
    };
  }

  private notifyListeners(runId: string, event: ParsedEvent, seq: number): void {
    const listeners = this.eventListeners.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event, seq);
      }
    }
  }
}
