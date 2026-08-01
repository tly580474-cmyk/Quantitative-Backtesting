import { canonicalHash } from '../experiments/schema.js';
import {
  finalizeOptimizerResult,
  optimizerSpecSchema,
  type OptimizerResult,
  type OptimizerSpec,
} from './extensionSchema.js';

export interface OptimizerCandidate {
  instrumentKey: string;
  expectedReturn: number;
  riskProxy: number;
  previousWeight: number;
  industryCode: string | null;
  benchmarkIndustryWeight?: number;
}

export interface OptimizerLimits {
  grossExposure: number;
  maxSingleWeight: number;
  minCashWeight: number;
}

export function solvePortfolioOptimizer(input: {
  decisionDate: string;
  candidates: OptimizerCandidate[];
  spec: OptimizerSpec;
  limits: OptimizerLimits;
}): OptimizerResult {
  const spec = optimizerSpecSchema.parse(input.spec);
  const candidates = [...input.candidates]
    .sort((left, right) => right.expectedReturn - left.expectedReturn
      || left.instrumentKey.localeCompare(right.instrumentKey))
    .slice(0, spec.maxHoldings);
  const inputHash = canonicalHash({ ...input, spec, candidates });
  const gross = Math.min(input.limits.grossExposure, 1 - input.limits.minCashWeight);
  const minimumWeight = spec.minPositionWeight ?? 0;
  const infeasible = feasibilityConflicts(candidates, gross, input.limits.maxSingleWeight, minimumWeight, spec);
  if (infeasible.length > 0) return failedResult('infeasible', inputHash, spec, infeasible);

  const baseline = floorCapAndRedistribute(
    candidates.map(() => gross / candidates.length),
    minimumWeight, input.limits.maxSingleWeight,
    gross,
  ).map(roundOptimizer);
  const adjustedScores = candidates.map((candidate) => (
    candidate.expectedReturn - spec.riskAversion * candidate.riskProxy
      + spec.turnoverPenalty * candidate.previousWeight
  ));
  const minimum = Math.min(...adjustedScores);
  const strengths = adjustedScores.map((value) => Math.max(1e-12, value - minimum + 1e-6));
  const strengthTotal = strengths.reduce((sum, value) => sum + value, 0);
  let weights = spec.mode === 'baseline'
    ? baseline
    : floorCapAndRedistribute(
      strengths.map((value) => gross * value / strengthTotal),
      minimumWeight, input.limits.maxSingleWeight,
      gross,
    );
  let iterations = 1;

  const previous = candidates.map((candidate) => candidate.previousWeight);
  const rawTurnover = turnover(weights, previous);
  if (rawTurnover > spec.maxTurnover) {
    const scale = spec.maxTurnover / rawTurnover;
    weights = weights.map((weight, index) => previous[index] + (weight - previous[index]) * scale);
    weights = floorCapAndRedistribute(weights, minimumWeight, input.limits.maxSingleWeight, Math.min(gross, sum(weights)));
    iterations += 1;
  }

  if (spec.industryNeutral) {
    const constrainedGross = sum(weights);
    const neutralized = neutralizeIndustries(candidates, weights, constrainedGross, spec.industryNeutral.maxActiveDeviation,
      spec.industryNeutral.allowUnknown, spec.industryNeutral.absoluteBounds,
      input.limits.maxSingleWeight, spec.solver.maxIterations, spec.solver.tolerance);
    if (neutralized.conflicts.length > 0) {
      return failedResult('infeasible', inputHash, spec, neutralized.conflicts);
    }
    weights = neutralized.weights;
    iterations += neutralized.iterations;
  }

  weights = weights.map(roundOptimizer);
  if (weights.some((weight) => weight > spec.solver.tolerance && weight < minimumWeight - spec.solver.tolerance)) {
    return failedResult('infeasible', inputHash, spec, ['MINIMUM_POSITION_WEIGHT_NOT_SATISFIED']);
  }

  const finalTurnover = roundOptimizer(turnover(weights, previous));
  const industryExposure = mapRounded(exposure(candidates, weights));
  const baselineIndustryExposure = mapRounded(exposure(candidates, baseline));
  const benchmarkIndustryExposure = mapRounded(benchmarkExposure(candidates, sum(weights)));
  const expectedReturn = roundOptimizer(candidates.reduce((sumValue, candidate, index) => (
    sumValue + candidate.expectedReturn * weights[index]
  ), 0));
  const riskPenalty = roundOptimizer(spec.riskAversion * candidates.reduce((sumValue, candidate, index) => (
    sumValue + candidate.riskProxy * weights[index] ** 2
  ), 0));
  const turnoverPenalty = roundOptimizer(spec.turnoverPenalty * finalTurnover);
  const portfolioMetrics = (portfolioWeights: number[]) => ({
    expectedReturn: roundOptimizer(candidates.reduce((total, candidate, index) => (
      total + candidate.expectedReturn * portfolioWeights[index]
    ), 0)),
    riskProxy: roundOptimizer(candidates.reduce((total, candidate, index) => (
      total + candidate.riskProxy * portfolioWeights[index] ** 2
    ), 0)),
    turnover: roundOptimizer(turnover(portfolioWeights, previous)),
    concentration: roundOptimizer(portfolioWeights.reduce((total, weight) => total + weight ** 2, 0)),
  });
  const output = finalizeOptimizerResult({
    protocolVersion: '1.0', status: 'solved',
    solver: { ...spec.solver, iterations },
    weights: candidates.map((candidate, index) => ({
      instrumentKey: candidate.instrumentKey,
      baselineWeight: baseline[index], optimizedWeight: weights[index],
      previousWeight: candidate.previousWeight, expectedReturn: candidate.expectedReturn,
      riskProxy: candidate.riskProxy, industryCode: candidate.industryCode,
    })),
    objective: {
      expectedReturn, riskPenalty, turnoverPenalty,
      value: roundOptimizer(expectedReturn - riskPenalty - turnoverPenalty),
    },
    comparison: { baseline: portfolioMetrics(baseline), optimized: portfolioMetrics(weights) },
    turnover: finalTurnover, grossExposure: roundOptimizer(sum(weights)),
    industryExposure, baselineIndustryExposure, benchmarkIndustryExposure,
    constraintMargins: {
      gross: roundOptimizer(gross - sum(weights)),
      singleWeight: roundOptimizer(input.limits.maxSingleWeight - Math.max(...weights)),
      turnover: roundOptimizer(spec.maxTurnover - finalTurnover),
      industryDeviation: roundOptimizer(industryDeviationMargin(industryExposure, benchmarkIndustryExposure,
        spec.industryNeutral?.maxActiveDeviation)),
    },
    conflicts: [], inputHash,
  });
  validatePortfolioOptimizerResult(output, spec, input.limits);
  return output;
}

export function validatePortfolioOptimizerResult(
  result: OptimizerResult,
  spec: OptimizerSpec,
  limits: OptimizerLimits,
): void {
  if (result.status !== 'solved') return;
  const tolerance = spec.solver.tolerance;
  const weights = result.weights.map((item) => item.optimizedWeight);
  const grossLimit = Math.min(limits.grossExposure, 1 - limits.minCashWeight);
  if (sum(weights) > grossLimit + tolerance) throw new Error('OPTIMIZER_GROSS_LIMIT_VIOLATION');
  if (weights.some((weight) => weight < -tolerance || weight > limits.maxSingleWeight + tolerance)) {
    throw new Error('OPTIMIZER_SINGLE_WEIGHT_VIOLATION');
  }
  const minimumWeight = spec.minPositionWeight ?? 0;
  if (weights.some((weight) => weight > tolerance && weight < minimumWeight - tolerance)) {
    throw new Error('OPTIMIZER_MINIMUM_POSITION_WEIGHT_VIOLATION');
  }
  if (result.turnover > spec.maxTurnover + tolerance) throw new Error('OPTIMIZER_TURNOVER_VIOLATION');
  if (spec.industryNeutral) {
    const actual = result.industryExposure ?? {};
    const benchmark = result.benchmarkIndustryExposure ?? {};
    for (const code of new Set([...Object.keys(actual), ...Object.keys(benchmark)])) {
      if (Math.abs((actual[code] ?? 0) - (benchmark[code] ?? 0))
        > spec.industryNeutral.maxActiveDeviation + tolerance + 1e-12) {
        throw new Error(`OPTIMIZER_INDUSTRY_DEVIATION_VIOLATION:${code}`);
      }
      const absolute = spec.industryNeutral.absoluteBounds?.[code];
      if (absolute?.min !== undefined && (actual[code] ?? 0) < absolute.min - tolerance) {
        throw new Error(`OPTIMIZER_INDUSTRY_ABSOLUTE_MIN_VIOLATION:${code}`);
      }
      if (absolute?.max !== undefined && (actual[code] ?? 0) > absolute.max + tolerance) {
        throw new Error(`OPTIMIZER_INDUSTRY_ABSOLUTE_MAX_VIOLATION:${code}`);
      }
    }
  }
}

function feasibilityConflicts(
  candidates: OptimizerCandidate[], gross: number, cap: number, minimumWeight: number, spec: OptimizerSpec,
): string[] {
  const conflicts: string[] = [];
  if (candidates.length === 0) conflicts.push('NO_OPTIMIZER_CANDIDATES');
  if (candidates.length * cap + spec.solver.tolerance < gross) conflicts.push('HOLDING_CAP_CANNOT_REACH_GROSS');
  if (candidates.length * minimumWeight > gross + spec.solver.tolerance) {
    conflicts.push('MINIMUM_POSITION_WEIGHT_EXCEEDS_GROSS');
  }
  if (spec.industryNeutral && !spec.industryNeutral.allowUnknown
    && candidates.some((candidate) => candidate.industryCode === null)) {
    conflicts.push('UNKNOWN_INDUSTRY_NOT_ALLOWED');
  }
  return conflicts;
}

function failedResult(
  status: 'infeasible' | 'timeout' | 'numerical', inputHash: string,
  spec: OptimizerSpec, conflicts: string[],
): OptimizerResult {
  return finalizeOptimizerResult({
    protocolVersion: '1.0', status,
    solver: { ...spec.solver, iterations: 0 }, weights: [], objective: null, comparison: null,
    turnover: 0, grossExposure: 0, constraintMargins: {}, conflicts, inputHash,
  });
}

function neutralizeIndustries(
  candidates: OptimizerCandidate[], inputWeights: number[], gross: number,
  maxDeviation: number, allowUnknown: boolean,
  absoluteBounds: Record<string, { min?: number; max?: number }> | undefined,
  cap: number, maxIterations: number, tolerance: number,
): { weights: number[]; iterations: number; conflicts: string[] } {
  const weights = [...inputWeights];
  const benchmark = benchmarkExposure(candidates, gross);
  const groups = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    const code = candidate.industryCode ?? 'UNKNOWN';
    const indexes = groups.get(code) ?? [];
    indexes.push(index);
    groups.set(code, indexes);
  });
  if (!allowUnknown && groups.has('UNKNOWN')) return { weights, iterations: 0, conflicts: ['UNKNOWN_INDUSTRY_NOT_ALLOWED'] };
  const bounds = Object.fromEntries([...groups].map(([code]) => {
    const absolute = absoluteBounds?.[code];
    return [code, {
      minimum: Math.max(0, (benchmark[code] ?? 0) - maxDeviation, absolute?.min ?? 0),
      maximum: Math.min(gross, (benchmark[code] ?? 0) + maxDeviation, absolute?.max ?? gross),
    }];
  }));
  for (const [code, indexes] of groups) {
    const { minimum, maximum } = bounds[code];
    if (minimum > maximum + tolerance) {
      return { weights, iterations: 0, conflicts: [`INDUSTRY_BOUND_CONFLICT:${code}`] };
    }
    if (indexes.length * cap + tolerance < minimum) {
      return { weights, iterations: 0, conflicts: [`INDUSTRY_LOWER_BOUND_INFEASIBLE:${code}`] };
    }
  }
  const minimumTotal = sum(Object.values(bounds).map((bound) => bound.minimum));
  const maximumTotal = sum(Object.values(bounds).map((bound) => bound.maximum));
  if (minimumTotal > gross + tolerance || maximumTotal + tolerance < gross) {
    return { weights, iterations: 0, conflicts: ['INDUSTRY_AGGREGATE_BOUNDS_INFEASIBLE'] };
  }
  let iterations = 0;
  for (; iterations < maxIterations; iterations += 1) {
    const current = exposure(candidates, weights);
    let changed = false;
    for (const [code, indexes] of groups) {
      const upper = bounds[code].maximum;
      const value = current[code] ?? 0;
      if (value <= upper + tolerance) continue;
      const scale = upper / value;
      indexes.forEach((index) => { weights[index] *= scale; });
      changed = true;
    }
    const afterUpper = exposure(candidates, weights);
    for (const [code, indexes] of groups) {
      const deficit = bounds[code].minimum - (afterUpper[code] ?? 0);
      if (deficit <= tolerance) continue;
      const receivingRoom = sum(indexes.map((index) => Math.max(0, cap - weights[index])));
      const cashAvailable = Math.max(0, gross - sum(weights));
      const transferRequired = Math.max(0, deficit - cashAvailable);
      const donors = [...groups.entries()]
        .filter(([donorCode]) => donorCode !== code)
        .flatMap(([donorCode, donorIndexes]) => {
          const removable = Math.max(0, (afterUpper[donorCode] ?? 0) - bounds[donorCode].minimum);
          const donorTotal = sum(donorIndexes.map((index) => weights[index]));
          return donorIndexes.map((index) => ({
            index,
            room: donorTotal > 0 ? removable * weights[index] / donorTotal : 0,
          }));
        });
      const donorRoom = sum(donors.map((donor) => donor.room));
      if (receivingRoom + tolerance < deficit || donorRoom + tolerance < transferRequired) {
        return { weights, iterations, conflicts: [`INDUSTRY_LOWER_BOUND_INFEASIBLE:${code}`] };
      }
      if (transferRequired > 0) {
        donors.forEach((donor) => { weights[donor.index] -= transferRequired * donor.room / donorRoom; });
      }
      indexes.forEach((index) => {
        weights[index] += deficit * Math.max(0, cap - weights[index]) / receivingRoom;
      });
      changed = true;
    }
    const remaining = gross - sum(weights);
    if (remaining > tolerance) {
      const room = weights.map((weight) => Math.max(0, cap - weight));
      const roomTotal = sum(room);
      if (roomTotal + tolerance < remaining) return { weights, iterations, conflicts: ['INDUSTRY_REDISTRIBUTION_INFEASIBLE'] };
      weights.forEach((_weight, index) => { weights[index] += remaining * room[index] / roomTotal; });
      changed = true;
    }
    const projectedExposure = exposure(candidates, weights);
    const absoluteSatisfied = Object.entries(bounds).every(([code, bound]) => (
      (projectedExposure[code] ?? 0) >= bound.minimum - tolerance
        && (projectedExposure[code] ?? 0) <= bound.maximum + tolerance
    ));
    if (!changed || (industryDeviationMargin(projectedExposure, benchmark, maxDeviation) >= -tolerance
      && absoluteSatisfied)) break;
  }
  const finalExposure = exposure(candidates, weights);
  const margin = industryDeviationMargin(finalExposure, benchmark, maxDeviation);
  const absoluteViolation = Object.entries(bounds).some(([code, bound]) => (
    (finalExposure[code] ?? 0) < bound.minimum - tolerance
      || (finalExposure[code] ?? 0) > bound.maximum + tolerance
  ));
  return margin < -tolerance || absoluteViolation
    ? { weights, iterations, conflicts: ['INDUSTRY_NEUTRALITY_NOT_CONVERGED'] }
    : { weights, iterations, conflicts: [] };
}

function benchmarkExposure(candidates: OptimizerCandidate[], gross: number): Record<string, number> {
  const explicit = candidates.some((candidate) => candidate.benchmarkIndustryWeight !== undefined);
  if (explicit) {
    const result: Record<string, number> = {};
    for (const candidate of candidates) {
      const code = candidate.industryCode ?? 'UNKNOWN';
      result[code] = Math.max(result[code] ?? 0, candidate.benchmarkIndustryWeight ?? 0);
    }
    const total = sum(Object.values(result));
    return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, total > 0 ? value * gross / total : 0]));
  }
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    const code = candidate.industryCode ?? 'UNKNOWN';
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, gross * value / candidates.length]));
}

function exposure(candidates: OptimizerCandidate[], weights: number[]): Record<string, number> {
  const result: Record<string, number> = {};
  candidates.forEach((candidate, index) => {
    const code = candidate.industryCode ?? 'UNKNOWN';
    result[code] = (result[code] ?? 0) + weights[index];
  });
  return result;
}

function industryDeviationMargin(
  actual: Record<string, number>, benchmark: Record<string, number>, maximum?: number,
): number {
  if (maximum === undefined) return 1;
  const codes = [...new Set([...Object.keys(actual), ...Object.keys(benchmark)])];
  const largest = Math.max(0, ...codes
    .map((code) => Math.abs((actual[code] ?? 0) - (benchmark[code] ?? 0))));
  return maximum - largest;
}

function turnover(weights: number[], previous: number[]): number {
  return weights.reduce((total, weight, index) => total + Math.abs(weight - (previous[index] ?? 0)), 0);
}

function capAndRedistribute(weights: number[], cap: number, gross: number): number[] {
  if (weights.length === 0) return [];
  const output = weights.map((weight) => Math.max(0, weight));
  for (let iteration = 0; iteration < weights.length + 2; iteration += 1) {
    const total = sum(output);
    if (total <= 0) output.fill(gross / output.length);
    else output.forEach((weight, index) => { output[index] = weight * gross / total; });
    const excess = output.reduce((value, weight) => value + Math.max(0, weight - cap), 0);
    output.forEach((weight, index) => { output[index] = Math.min(cap, weight); });
    if (excess <= 1e-12) break;
    const open = output.map((weight, index) => ({ weight, index })).filter((item) => item.weight < cap - 1e-12);
    const room = open.reduce((value, item) => value + cap - item.weight, 0);
    if (room <= 0) break;
    open.forEach((item) => { output[item.index] += excess * (cap - item.weight) / room; });
  }
  return output;
}

function floorCapAndRedistribute(weights: number[], floor: number, cap: number, gross: number): number[] {
  if (floor <= 0) return capAndRedistribute(weights, cap, gross);
  const residualGross = gross - floor * weights.length;
  if (residualGross < -1e-12) return [...weights];
  const residual = capAndRedistribute(
    weights.map((weight) => Math.max(0, weight - floor)),
    cap - floor,
    Math.max(0, residualGross),
  );
  return residual.map((weight) => weight + floor);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundOptimizer(value: number): number {
  const rounded = Math.round(value * 1e10) / 1e10;
  return rounded === 0 ? 0 : rounded;
}

function mapRounded(values: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, roundOptimizer(value)]));
}
