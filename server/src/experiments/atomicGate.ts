export interface AtomicGateState<T> {
  status: 'sealed' | 'opened';
  token: string | null;
  value: T;
}

export interface AtomicGateAdapter<T> {
  read(): Promise<AtomicGateState<T>>;
  compareAndSet(token: string): Promise<boolean>;
}

export async function claimAtomicGate<T>(adapter: AtomicGateAdapter<T>, token: string) {
  const initial = await adapter.read();
  if (initial.status === 'opened') {
    return initial.token === token
      ? { type: 'opened' as const, value: initial.value, reused: true }
      : { type: 'already_opened' as const, value: initial.value };
  }
  const claimed = await adapter.compareAndSet(token);
  const current = await adapter.read();
  if (claimed || current.token === token) {
    return { type: 'opened' as const, value: current.value, reused: !claimed };
  }
  return { type: 'already_opened' as const, value: current.value };
}
