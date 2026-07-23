import type { Candle } from '@/models';
import { computeConfigHash, computeDataChecksum } from '@/utils/checksum';
import type { ChanConfig, ChanFingerprint } from './types';

export function createChanFingerprint(
  candles: readonly Candle[],
  config: ChanConfig,
): ChanFingerprint {
  const dataChecksum = computeDataChecksum([...candles]);
  const configHash = computeConfigHash(config);
  return {
    dataChecksum,
    configHash,
    fingerprint: computeConfigHash({ configHash, dataChecksum }),
  };
}

