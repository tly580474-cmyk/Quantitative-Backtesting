/**
 * 极简内存 TTL 缓存，用于 Admin Overview 采集结果。
 *
 * 设计要点（见 ADMIN_CONSOLE_OPTIMIZATION_PLAN §1）：
 * - 按 dbOnline 分桶（online / offline），因为 DB 在线/离线时诊断内容完全不同。
 * - TTL 过期后允许返回上一帧成功结果（stale-while-revalidate），避免重算抖动。
 * - 只缓存成功结果；collect 抛错时不写缓存。
 * - peek() 仅读取不刷新 TTL，供错误降级使用。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverviewPayload = Record<string, any>;

interface CacheEntry {
  value: OverviewPayload;
  expiresAt: number;
}

const ONLINE_KEY = true;
const OFFLINE_KEY = false;

export interface OverviewCache {
  /** 命中且未过期时返回缓存值；否则返回 null。不改变过期时间。 */
  get(dbOnline: boolean): OverviewPayload | null;
  /** 仅读取缓存（即使已过期），不刷新 TTL。供 collect 失败时降级返回陈旧帧。 */
  peek(dbOnline: boolean): OverviewPayload | null;
  /** 写入成功结果，刷新 TTL。 */
  set(dbOnline: boolean, value: OverviewPayload): void;
  /** 主动失效（配置变更、快照发布等场景调用）。 */
  invalidate(): void;
}

export function createOverviewCache(ttlMs: number): OverviewCache {
  const buckets = new Map<boolean, CacheEntry>();
  const resolvedTtl = ttlMs > 0 ? ttlMs : 10_000;

  return {
    get(dbOnline: boolean): OverviewPayload | null {
      const entry = buckets.get(dbOnline);
      if (!entry) return null;
      if (Date.now() >= entry.expiresAt) return null;
      return entry.value;
    },
    peek(dbOnline: boolean): OverviewPayload | null {
      const entry = buckets.get(dbOnline);
      return entry ? entry.value : null;
    },
    set(dbOnline: boolean, value: OverviewPayload): void {
      buckets.set(dbOnline, { value, expiresAt: Date.now() + resolvedTtl });
    },
    invalidate(): void {
      buckets.delete(ONLINE_KEY);
      buckets.delete(OFFLINE_KEY);
    },
  };
}
