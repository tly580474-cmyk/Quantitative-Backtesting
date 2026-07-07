import 'dotenv/config';
import { loadConfig } from '../config.js';
import { listBuiltinFactors } from './definitions/validator.js';
import { runFactorResearch } from './engine/factorRunner.js';
import { runCompositeFactorResearch } from './engine/compositeRunner.js';
import type { CompositeFactorRunConfig, FactorRunConfig } from './definitions/schema.js';

async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const config = loadConfig();
  if (command === 'list') {
    console.log(JSON.stringify(listBuiltinFactors(), null, 2));
    return;
  }
  if (command === 'run') {
    const runConfig = parseRunConfig(args);
    console.log(JSON.stringify(await runFactorResearch({
      snapshotRoot: args.snapshotRoot ?? config.RESEARCH_SNAPSHOT_ROOT,
      artifactRoot: args.artifactRoot ?? config.FACTOR_RESEARCH_ROOT,
      config: runConfig,
      writeReport: args.writeReport !== 'false',
    }), null, 2));
    return;
  }
  if (command === 'composite') {
    const runConfig = parseCompositeRunConfig(args);
    console.log(JSON.stringify(await runCompositeFactorResearch({
      snapshotRoot: args.snapshotRoot ?? config.RESEARCH_SNAPSHOT_ROOT,
      artifactRoot: args.artifactRoot ?? config.FACTOR_RESEARCH_ROOT,
      config: runConfig,
      writeReport: args.writeReport !== 'false',
    }), null, 2));
    return;
  }
  throw new Error('用法：npm run factor:run -- --factor momentum_20 --start 2026-01-01 --end 2026-06-30，或 npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-01-01 --end 2026-06-30');
}

function parseRunConfig(args: Record<string, string>): FactorRunConfig {
  const factorId = args.factor;
  const startDate = args.start;
  const endDate = args.end;
  if (!factorId || !startDate || !endDate) {
    throw new Error('因子研究必须提供 --factor、--start 和 --end');
  }
  return {
    factorId,
    startDate,
    endDate,
    horizonDays: Number(args.horizon ?? 5),
    layers: Number(args.layers ?? 5),
    markets: splitList(args.markets),
    symbols: splitList(args.symbols),
    minDailyAmount: args.minDailyAmount === undefined ? undefined : Number(args.minDailyAmount),
  };
}

function splitList(value: string | undefined): string[] | undefined {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : undefined;
}

function parseCompositeRunConfig(args: Record<string, string>): CompositeFactorRunConfig {
  const factorIds = splitList(args.factors);
  const startDate = args.start;
  const endDate = args.end;
  if (!factorIds?.length || !startDate || !endDate) {
    throw new Error('多因子研究必须提供 --factors、--start 和 --end');
  }
  return {
    factorIds,
    startDate,
    endDate,
    validationStartDate: args.validationStart,
    horizonDays: Number(args.horizon ?? 5),
    layers: Number(args.layers ?? 5),
    weighting: parseWeighting(args.weighting),
    manualWeights: parseManualWeights(args.weights),
    markets: splitList(args.markets),
    symbols: splitList(args.symbols),
    minDailyAmount: args.minDailyAmount === undefined ? undefined : Number(args.minDailyAmount),
  };
}

function parseWeighting(value: string | undefined): CompositeFactorRunConfig['weighting'] {
  if (value === undefined) return 'equal';
  if (value === 'equal' || value === 'ic' || value === 'rankIc' || value === 'manual') return value;
  throw new Error('多因子权重方式仅支持 equal、ic、rankIc 和 manual');
}

function parseManualWeights(value: string | undefined): Record<string, number> | undefined {
  if (!value) return undefined;
  const weights: Record<string, number> = {};
  for (const item of value.split(',')) {
    const [factorId, rawWeight] = item.split(':');
    if (!factorId || rawWeight === undefined) throw new Error('手动权重格式应为 factor:weight,factor:weight');
    weights[factorId.trim()] = Number(rawWeight);
  }
  return weights;
}

function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${item} 缺少值`);
    result[key] = value;
    index += 1;
  }
  return result;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
