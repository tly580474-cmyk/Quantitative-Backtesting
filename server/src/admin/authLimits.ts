/** Fixed windows; bounded memory and socket IPs (never raw forwarded headers). */
export function createAuthLimits() {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return (ip: string, recordFailure = false): number => {
    const now = Date.now();
    for (const [key, value] of windows) if (value.resetAt <= now) windows.delete(key);
    let window = windows.get(ip);
    if (!window && !recordFailure) return 0;
    if (!window) {
      // Do not evict blocked addresses under a flood of new addresses.
      if (windows.size >= 10_000) return 60;
      window = { count: 0, resetAt: now + 60_000 };
      windows.set(ip, window);
    }
    if (recordFailure) window.count += 1;
    return window.count >= 10 ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
  };
}
