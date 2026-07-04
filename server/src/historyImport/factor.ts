export interface PriceRow {
  tradeDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CompressedFactor {
  effectiveDate: string;
  factor: number;
  offset: number;
}

export interface ReconstructionStats {
  comparedPrices: number;
  withinTickPrices: number;
  withinTickRatio: number;
  meanAbsoluteError: number;
  maxAbsoluteError: number;
  firstMismatchDate: string | null;
}

export interface DerivedFactorResult {
  factors: CompressedFactor[];
  qfqStats: ReconstructionStats;
  overlapRows: number;
  qfqOnlyEarlyRows: PriceRow[];
  missingRawRows: number;
  latestAnchorMismatch: boolean;
}

interface FactorSegment {
  start: number;
  end: number;
  polygon: Point[];
}

const OHLC_KEYS = ['open', 'high', 'low', 'close'] as const;
const MAX_SCALE = 100;
const MAX_ABS_OFFSET = 1_000_000;

interface Point {
  factor: number;
  offset: number;
}

/**
 * Derive a compact, latest-normalized multiplicative factor series from
 * authoritative unadjusted prices and a qfq reference series.
 *
 * Cash dividends require an affine transformation:
 * adjusted = raw * factor + offset.
 *
 * Each OHLC pair defines a strip in (factor, offset) space. Consecutive dates
 * are compressed while the intersection of all strips remains non-empty.
 * This preserves one-tick reconstruction accuracy without storing one factor
 * per trading day.
 */
export function deriveCompressedFactors(
  rawRows: PriceRow[],
  qfqRows: PriceRow[],
  tickSize = 0.01,
): DerivedFactorResult {
  if (tickSize <= 0 || !Number.isFinite(tickSize)) {
    throw new Error('tickSize must be a positive finite number');
  }
  const tolerance = tickSize + 1e-8;
  const rawByDate = new Map(rawRows.map((row) => [row.tradeDate, row]));
  const sortedRaw = [...rawRows].sort(byDate);
  const sortedQfq = [...qfqRows].sort(byDate);
  const firstRawDate = sortedRaw[0]?.tradeDate ?? null;
  const overlap: Array<{ raw: PriceRow; adjusted: PriceRow }> = [];
  const qfqOnlyEarlyRows: PriceRow[] = [];
  let missingRawRows = 0;

  for (const qfq of sortedQfq) {
    const raw = rawByDate.get(qfq.tradeDate);
    if (!raw) {
      if (firstRawDate !== null && qfq.tradeDate < firstRawDate) {
        qfqOnlyEarlyRows.push(qfq);
      } else {
        missingRawRows += 1;
      }
      continue;
    }
    validateRawPrices(raw);
    validateAdjustedPrices(qfq);
    overlap.push({ raw, adjusted: qfq });
  }

  if (overlap.length === 0) {
    return {
      factors: [],
      qfqStats: emptyStats(),
      overlapRows: 0,
      qfqOnlyEarlyRows,
      missingRawRows,
      latestAnchorMismatch: false,
    };
  }

  const segments = compressAffineTransforms(overlap, tolerance);
  const rawFactors = segments.map((segment) => polygonCentroid(segment.polygon));
  const lastIndex = rawFactors.length - 1;
  const lastSegment = segments[lastIndex];
  const identity = { factor: 1, offset: 0 };
  const latestCanAnchorAtOne = pointInPolygon(identity, lastSegment.polygon);
  if (latestCanAnchorAtOne) rawFactors[lastIndex] = identity;
  const anchor = latestCanAnchorAtOne ? identity : rawFactors[lastIndex];
  const factors = segments.map((segment, index) => ({
    effectiveDate: overlap[segment.start].raw.tradeDate,
    factor: rawFactors[index].factor / anchor.factor,
    offset: (rawFactors[index].offset - anchor.offset) / anchor.factor,
  }));

  return {
    factors,
    qfqStats: validateReconstruction(rawRows, qfqRows, factors, 'qfq', tickSize),
    overlapRows: overlap.length,
    qfqOnlyEarlyRows,
    missingRawRows,
    latestAnchorMismatch: !latestCanAnchorAtOne,
  };
}

export function validateReconstruction(
  rawRows: PriceRow[],
  adjustedRows: PriceRow[],
  factors: CompressedFactor[],
  mode: 'qfq' | 'hfq',
  tickSize = 0.01,
): ReconstructionStats {
  if (factors.length === 0) return emptyStats();
  const rawByDate = new Map(rawRows.map((row) => [row.tradeDate, row]));
  const sortedFactors = [...factors].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate));
  const earliestFactor = sortedFactors[0].factor;
  const earliestOffset = sortedFactors[0].offset;
  const latestFactor = sortedFactors[sortedFactors.length - 1].factor;
  const latestOffset = sortedFactors[sortedFactors.length - 1].offset;
  const tolerance = tickSize + 1e-8;
  let factorIndex = 0;
  let comparedPrices = 0;
  let withinTickPrices = 0;
  let absoluteErrorSum = 0;
  let maxAbsoluteError = 0;
  let firstMismatchDate: string | null = null;

  for (const adjusted of [...adjustedRows].sort(byDate)) {
    const raw = rawByDate.get(adjusted.tradeDate);
    if (!raw) continue;
    while (
      factorIndex + 1 < sortedFactors.length
      && sortedFactors[factorIndex + 1].effectiveDate <= adjusted.tradeDate
    ) {
      factorIndex += 1;
    }
    const factor = sortedFactors[factorIndex].factor;
    for (const key of OHLC_KEYS) {
      const qfqPrice = (
        raw[key] * factor
        + sortedFactors[factorIndex].offset
        - latestOffset
      ) / latestFactor;
      const reconstructed = mode === 'qfq'
        ? qfqPrice
        : (qfqPrice - earliestOffset) / earliestFactor;
      const error = Math.abs(reconstructed - adjusted[key]);
      comparedPrices += 1;
      absoluteErrorSum += error;
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      if (error <= tolerance) {
        withinTickPrices += 1;
      } else {
        firstMismatchDate ??= adjusted.tradeDate;
      }
    }
  }

  return {
    comparedPrices,
    withinTickPrices,
    withinTickRatio: comparedPrices === 0 ? 0 : withinTickPrices / comparedPrices,
    meanAbsoluteError: comparedPrices === 0 ? 0 : absoluteErrorSum / comparedPrices,
    maxAbsoluteError,
    firstMismatchDate,
  };
}

/**
 * Cross-check hfq without treating it as authoritative. Tencent expresses hfq
 * as one affine change of basis from qfq. The earliest stable overlap is used
 * only to calibrate that basis; later deviations are reported as source
 * inconsistencies.
 */
export function validateHfqCrosscheck(
  rawRows: PriceRow[],
  qfqRows: PriceRow[],
  hfqRows: PriceRow[],
  factors: CompressedFactor[],
  tickSize = 0.01,
): ReconstructionStats {
  if (factors.length === 0) return emptyStats();
  const qfqByDate = new Map(qfqRows.map((row) => [row.tradeDate, row]));
  const calibrationRows = [...hfqRows].sort(byDate).flatMap((hfq) => {
    const qfq = qfqByDate.get(hfq.tradeDate);
    return qfq ? [{ raw: qfq, adjusted: hfq }] : [];
  });
  if (calibrationRows.length === 0) return emptyStats();
  const tolerance = tickSize + 1e-8;
  const basis = fitAffineLeastSquares(calibrationRows.slice(0, 20));
  const rawByDate = new Map(rawRows.map((row) => [row.tradeDate, row]));
  const sortedFactors = [...factors].sort((a, b) =>
    a.effectiveDate.localeCompare(b.effectiveDate));
  const latest = sortedFactors[sortedFactors.length - 1];
  let factorIndex = 0;
  let comparedPrices = 0;
  let withinTickPrices = 0;
  let absoluteErrorSum = 0;
  let maxAbsoluteError = 0;
  let firstMismatchDate: string | null = null;

  for (const hfq of [...hfqRows].sort(byDate)) {
    const raw = rawByDate.get(hfq.tradeDate);
    if (!raw) continue;
    while (
      factorIndex + 1 < sortedFactors.length
      && sortedFactors[factorIndex + 1].effectiveDate <= hfq.tradeDate
    ) {
      factorIndex += 1;
    }
    const factor = sortedFactors[factorIndex];
    for (const key of OHLC_KEYS) {
      const qfqPrice = (
        raw[key] * factor.factor + factor.offset - latest.offset
      ) / latest.factor;
      const reconstructed = qfqPrice * basis.factor + basis.offset;
      const error = Math.abs(reconstructed - hfq[key]);
      comparedPrices += 1;
      absoluteErrorSum += error;
      maxAbsoluteError = Math.max(maxAbsoluteError, error);
      if (error <= tolerance) {
        withinTickPrices += 1;
      } else {
        firstMismatchDate ??= hfq.tradeDate;
      }
    }
  }
  return {
    comparedPrices,
    withinTickPrices,
    withinTickRatio: comparedPrices === 0 ? 0 : withinTickPrices / comparedPrices,
    meanAbsoluteError: comparedPrices === 0 ? 0 : absoluteErrorSum / comparedPrices,
    maxAbsoluteError,
    firstMismatchDate,
  };
}

function fitAffineLeastSquares(
  rows: Array<{ raw: PriceRow; adjusted: PriceRow }>,
): Point {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (const row of rows) {
    for (const key of OHLC_KEYS) {
      const x = row.raw[key];
      const y = row.adjusted[key];
      count += 1;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
    }
  }
  const denominator = count * sumXX - sumX * sumX;
  if (count === 0) return { factor: 1, offset: 0 };
  if (Math.abs(denominator) < 1e-12) {
    return { factor: 1, offset: (sumY - sumX) / count };
  }
  const factor = (count * sumXY - sumX * sumY) / denominator;
  return {
    factor,
    offset: (sumY - factor * sumX) / count,
  };
}

function compressAffineTransforms(
  rows: Array<{ raw: PriceRow; adjusted: PriceRow }>,
  tolerance: number,
): FactorSegment[] {
  const segments: FactorSegment[] = [];
  let current = startAffineSegment(rows[0], 0, tolerance);
  for (let index = 1; index < rows.length; index += 1) {
    const clipped = clipRow(current.polygon, rows[index], tolerance);
    if (clipped.length > 0) {
      current.end = index + 1;
      current.polygon = clipped;
    } else {
      segments.push(current);
      current = startAffineSegment(rows[index], index, tolerance);
    }
  }
  segments.push(current);
  return segments;
}

function startAffineSegment(
  row: { raw: PriceRow; adjusted: PriceRow },
  index: number,
  tolerance: number,
): FactorSegment {
  const polygon = clipRow(initialPolygon(), row, tolerance);
  if (polygon.length === 0) {
    throw new Error(`${row.raw.tradeDate} cannot be represented by an affine adjustment`);
  }
  return {
    start: index,
    end: index + 1,
    polygon,
  };
}

function initialPolygon(): Point[] {
  return [
    { factor: 0, offset: -MAX_ABS_OFFSET },
    { factor: MAX_SCALE, offset: -MAX_ABS_OFFSET },
    { factor: MAX_SCALE, offset: MAX_ABS_OFFSET },
    { factor: 0, offset: MAX_ABS_OFFSET },
  ];
}

function clipRow(
  polygon: Point[],
  row: { raw: PriceRow; adjusted: PriceRow },
  tolerance: number,
): Point[] {
  const exact = clipKeys(polygon, row, tolerance, OHLC_KEYS);
  if (exact.length > 0) return exact;

  // Some source rows contain one independently rounded or stale OHLC field.
  // Keep the file usable by selecting the largest feasible 3-of-4 region.
  for (const keepCount of [3, 2, 1]) {
    let best: Point[] = [];
    for (const keys of combinations(OHLC_KEYS, keepCount)) {
      const candidate = clipKeys(polygon, row, tolerance, keys);
      if (candidate.length > 0 && polygonArea(candidate) > polygonArea(best)) {
        best = candidate;
      }
    }
    if (best.length > 0) return best;
  }
  return [];
}

function clipKeys(
  polygon: Point[],
  row: { raw: PriceRow; adjusted: PriceRow },
  tolerance: number,
  keys: ReadonlyArray<typeof OHLC_KEYS[number]>,
): Point[] {
  let result = polygon;
  for (const key of keys) {
    const raw = row.raw[key];
    const adjusted = row.adjusted[key];
    result = clipHalfPlane(result, raw, 1, adjusted + tolerance);
    result = clipHalfPlane(result, -raw, -1, -adjusted + tolerance);
    if (result.length === 0) break;
  }
  return result;
}

function combinations<T>(values: readonly T[], count: number): T[][] {
  const result: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === count) {
      result.push(selected);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      visit(index + 1, [...selected, values[index]]);
    }
  };
  visit(0, []);
  return result;
}

function polygonArea(polygon: Point[]): number {
  if (polygon.length < 3) return 0;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.factor * next.offset - next.factor * current.offset;
  }
  return Math.abs(twiceArea) / 2;
}

function clipHalfPlane(
  polygon: Point[],
  a: number,
  b: number,
  c: number,
): Point[] {
  if (polygon.length === 0) return [];
  const output: Point[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentValue = a * current.factor + b * current.offset - c;
    const previousValue = a * previous.factor + b * previous.offset - c;
    const currentInside = currentValue <= 1e-9;
    const previousInside = previousValue <= 1e-9;
    if (currentInside !== previousInside) {
      const ratio = previousValue / (previousValue - currentValue);
      output.push({
        factor: previous.factor + ratio * (current.factor - previous.factor),
        offset: previous.offset + ratio * (current.offset - previous.offset),
      });
    }
    if (currentInside) output.push(current);
  }
  return output;
}

function polygonCentroid(polygon: Point[]): Point {
  return {
    factor: polygon.reduce((sum, point) => sum + point.factor, 0) / polygon.length,
    offset: polygon.reduce((sum, point) => sum + point.offset, 0) / polygon.length,
  };
}

function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = (
      (b.factor - a.factor) * (point.offset - a.offset)
      - (b.offset - a.offset) * (point.factor - a.factor)
    );
    if (Math.abs(cross) <= 1e-8) continue;
    const currentSign = Math.sign(cross);
    if (sign !== 0 && currentSign !== sign) return false;
    sign = currentSign;
  }
  return true;
}

function validateRawPrices(row: PriceRow): void {
  for (const key of OHLC_KEYS) {
    if (!Number.isFinite(row[key]) || row[key] <= 0) {
      throw new Error(`${row.tradeDate} raw ${key} must be positive and finite`);
    }
  }
}

function validateAdjustedPrices(row: PriceRow): void {
  for (const key of OHLC_KEYS) {
    if (!Number.isFinite(row[key])) {
      throw new Error(`${row.tradeDate} adjusted ${key} must be finite`);
    }
  }
}

function byDate(a: PriceRow, b: PriceRow): number {
  return a.tradeDate.localeCompare(b.tradeDate);
}

function emptyStats(): ReconstructionStats {
  return {
    comparedPrices: 0,
    withinTickPrices: 0,
    withinTickRatio: 0,
    meanAbsoluteError: 0,
    maxAbsoluteError: 0,
    firstMismatchDate: null,
  };
}
