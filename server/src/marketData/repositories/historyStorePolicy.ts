export type HistoryReadMode = 'legacy' | 'prefer-v2' | 'v2';

export interface HistoryStorePolicy {
  readMode: HistoryReadMode;
  dualWrite: boolean;
}

let currentPolicy: HistoryStorePolicy = {
  readMode: 'prefer-v2',
  dualWrite: true,
};

export function configureHistoryStorePolicy(policy: HistoryStorePolicy): void {
  currentPolicy = { ...policy };
}

export function getHistoryStorePolicy(): HistoryStorePolicy {
  return { ...currentPolicy };
}

export function allowsV2Read(policy = currentPolicy): boolean {
  return policy.readMode !== 'legacy';
}

export function allowsLegacyFallback(policy = currentPolicy): boolean {
  return policy.readMode !== 'v2';
}
