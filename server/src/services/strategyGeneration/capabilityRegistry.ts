import { createHash } from 'node:crypto';
import {
  GENERATED_ACCOUNT_FIELDS,
  GENERATED_COMPARE_OPERATORS,
  GENERATED_MARKET_FIELDS,
  GENERATED_RISK_RULE_TYPES,
  GENERATED_VISUAL_INDICATOR_CAPABILITIES,
} from './generatedIndicatorCapabilities.js';

const BASE_CAPABILITIES = {
  schemaVersion: '1.0',
  markets: ['cn_stock'],
  frequencies: ['1d'],
  executionModels: ['close_to_next_open'],
  universeTypes: ['single'],
  marketFields: GENERATED_MARKET_FIELDS,
  accountFields: GENERATED_ACCOUNT_FIELDS,
  compareOperators: GENERATED_COMPARE_OPERATORS,
  riskRules: GENERATED_RISK_RULE_TYPES,
} as const;

export function buildStrategyCapabilityRegistry(
  publishedFactorVersionIds: readonly string[] = [],
) {
  const registry = {
    ...BASE_CAPABILITIES,
    visualIndicators: GENERATED_VISUAL_INDICATOR_CAPABILITIES,
    publishedFactorVersionIds: [...new Set(publishedFactorVersionIds)].sort(),
  };
  const capabilityVersion = createHash('sha256')
    .update(JSON.stringify(registry))
    .digest('hex');
  return {
    capabilityVersion,
    generatedAt: new Date().toISOString(),
    ...registry,
  };
}
