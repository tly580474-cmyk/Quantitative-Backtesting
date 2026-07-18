export class SerialRateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastStartedAt = 0;

  constructor(
    private readonly minimumIntervalMs: number,
    private readonly jitterMs = 0,
  ) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.queue.then(async () => {
      const waitMs = Math.max(0, this.minimumIntervalMs - (Date.now() - this.lastStartedAt));
      if (waitMs > 0) {
        const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
        await new Promise((resolve) => setTimeout(resolve, waitMs + jitter));
      }
      this.lastStartedAt = Date.now();
      return operation();
    });
    this.queue = current.then(() => undefined, () => undefined);
    return current;
  }
}

const hostLimiters = new Map<string, SerialRateLimiter>();

export function limiterForHost(host: string): SerialRateLimiter {
  let limiter = hostLimiters.get(host);
  if (!limiter) {
    limiter = new SerialRateLimiter(1_100, 220);
    hostLimiters.set(host, limiter);
  }
  return limiter;
}
