export interface MultiAssetDispatcherStats {
  active: number;
  queued: number;
  concurrency: number;
}

export class MultiAssetRunDispatcher {
  private readonly queue: string[] = [];
  private readonly queuedIds = new Set<string>();
  private readonly activeIds = new Set<string>();

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
    if (this.queuedIds.has(runId) || this.activeIds.has(runId)) return false;
    this.queue.push(runId);
    this.queuedIds.add(runId);
    queueMicrotask(() => this.pump());
    return true;
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
        });
    }
  }
}
