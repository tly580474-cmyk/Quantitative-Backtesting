export interface MultiAssetDispatcherStats {
  active: number;
  queued: number;
  concurrency: number;
}

export class MultiAssetRunDispatcher {
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly activeIds = new Set<string>();
  private accepting = true;
  private readonly drainWaiters = new Set<() => void>();

  constructor(
    private readonly processRun: (runId: string) => Promise<unknown>,
    private readonly onError: (runId: string, error: unknown) => void = () => undefined,
    private readonly concurrency = 2,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('MULTI_ASSET_DISPATCHER_CONCURRENCY_INVALID');
    }
  }

  enqueue(runId: string): boolean {
    if (!this.accepting) return false;
    if (this.queuedIds.has(runId) || this.activeIds.has(runId)) return false;
    this.queue.push(runId);
    this.queuedIds.add(runId);
    queueMicrotask(() => this.pump());
    return true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.activeIds.size === 0 && this.queue.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(onDrained);
        resolve(value);
      };
      const onDrained = () => finish(true);
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.drainWaiters.add(onDrained);
    });
  }

  stats(): MultiAssetDispatcherStats {
    return { active: this.activeIds.size, queued: this.queue.length, concurrency: this.concurrency };
  }

  private pump(): void {
    while (this.activeIds.size < this.concurrency && this.queue.length > 0) {
      const runId = this.queue.shift()!;
      this.queuedIds.delete(runId);
      this.activeIds.add(runId);
      void this.processRun(runId)
        .catch((error) => this.onError(runId, error))
        .finally(() => {
          this.activeIds.delete(runId);
          this.pump();
          if (this.activeIds.size === 0 && this.queue.length === 0) {
            for (const waiter of [...this.drainWaiters]) waiter();
          }
        });
    }
  }
}
