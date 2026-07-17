/**
 * 进程内环形缓冲，记录最近 1 小时、每 15s 一次的运维指标采样。
 *
 * 见 ADMIN_CONSOLE_OPTIMIZATION_PLAN §4.1.1。
 * 固定容量 240 点（240 × 15s = 3600s = 1h），超出后覆盖最旧样本。
 * 进程重启会清零，对本机单进程运维台可接受。
 */

export interface MetricSample {
  timestamp: string; // ISO 8601
  rssBytes: number;
  heapUsedBytes: number;
  databaseLatencyMs: number | null;
  duckdbActive: number;
  duckdbQueued: number;
  diskUsedPercent: number | null;
  taskFailures: number;
}

const CAPACITY = 240;

export class MetricsHistory {
  private buffer: MetricSample[] = [];
  private head = 0;
  private filled = false;

  get length(): number {
    return this.filled ? CAPACITY : this.head;
  }

  push(sample: MetricSample): void {
    this.buffer[this.head] = sample;
    this.head = (this.head + 1) % CAPACITY;
    if (this.head === 0) this.filled = true;
  }

  /**
   * 返回按时间升序排列的样本。
   * 可通过 since 参数过滤起始时间。
   */
  list(since?: string): MetricSample[] {
    const count = this.length;
    if (count === 0) return [];
    const start = this.filled ? this.head : 0;
    const ordered: MetricSample[] = [];
    for (let i = 0; i < count; i++) {
      ordered.push(this.buffer[(start + i) % CAPACITY]);
    }
    if (since) {
      const sinceMs = Date.parse(since);
      if (Number.isFinite(sinceMs)) {
        return ordered.filter((s) => Date.parse(s.timestamp) >= sinceMs);
      }
    }
    return ordered;
  }

  latest(): MetricSample | null {
    if (this.length === 0) return null;
    const lastIndex = (this.head - 1 + CAPACITY) % CAPACITY;
    return this.buffer[lastIndex] ?? null;
  }
}

/** 进程级单例，供路由层和 overview 采集共享。 */
export const metricsHistory = new MetricsHistory();
