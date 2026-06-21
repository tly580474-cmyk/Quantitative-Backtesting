import { ENGINE_VERSION } from '@/features/backtest/version';
import { computeConfigHash } from './checksum';
import type { BacktestConfig } from '@/models';

export interface ExperimentFingerprint {
  fingerprint: string;
  components: {
    engineVersion: string;
    dataChecksum: string;
    configHash: string;
    strategyHash: string;
    parameterHash: string;
  };
}

export interface FingerprintInput {
  dataChecksum: string;
  config: BacktestConfig;
  strategyId: string;
  strategyVersion: string;
  strategyParams: Record<string, number | boolean | string>;
}

export function createExperimentFingerprint(input: FingerprintInput): ExperimentFingerprint {
  const configHash = computeConfigHash(input.config);
  const strategyHash = computeConfigHash({ id: input.strategyId, version: input.strategyVersion });
  const parameterHash = computeConfigHash(input.strategyParams);

  const components = {
    engineVersion: ENGINE_VERSION,
    dataChecksum: input.dataChecksum,
    configHash,
    strategyHash,
    parameterHash,
  };

  const fingerprint = computeConfigHash(components);

  return { fingerprint, components };
}
