/** Cache successful collections and share in-flight work across admin clients. */
export function createAsyncCache<T>(ttl: number | ((value: T) => number)) {
  let cached: { value: T; expiresAt: number } | undefined;
  let pending: Promise<T> | undefined;
  return (collect: () => Promise<T>): Promise<T> => {
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
    if (pending) return pending;
    pending = Promise.resolve().then(collect).then(value => {
      cached = { value, expiresAt: Date.now() + (typeof ttl === 'function' ? ttl(value) : ttl) };
      return value;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
