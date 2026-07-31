import { createHash } from 'node:crypto';

export type RepairOperationKind =
  | 'numeric-string-to-number'
  | 'system-metadata-enrichment'
  | 'literal-output-type';

export interface RepairOperation {
  path: Array<string | number>;
  kind: RepairOperationKind;
  before: unknown;
  after: unknown;
}

export interface StrategyRepairAudit {
  version: 1;
  originalCandidate: unknown;
  beforeHash: string;
  afterHash: string;
  changed: boolean;
  operations: RepairOperation[];
}

export interface StrategyRepairResult {
  candidate: unknown;
  audit: StrategyRepairAudit;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function clone(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function convertNumericField(
  target: Record<string, unknown>,
  field: string,
  path: Array<string | number>,
  operations: RepairOperation[],
): void {
  const before = target[field];
  if (
    typeof before !== 'string'
    || before.trim() === ''
    || !Number.isFinite(Number(before))
  ) return;
  const after = Number(before);
  target[field] = after;
  operations.push({
    path: [...path, field],
    kind: 'numeric-string-to-number',
    before,
    after,
  });
}

function repairOperand(
  value: unknown,
  path: Array<string | number>,
  operations: RepairOperation[],
): void {
  if (!isRecord(value)) return;
  if (value.type === 'market' || value.type === 'indicator') {
    convertNumericField(value, 'offset', path, operations);
  }
  if (value.type === 'literal') {
    convertNumericField(value, 'value', path, operations);
  }
}

function repairRule(
  value: unknown,
  path: Array<string | number>,
  operations: RepairOperation[],
): void {
  if (!isRecord(value)) return;
  if (value.type === 'condition') {
    repairOperand(value.left, [...path, 'left'], operations);
    repairOperand(value.right, [...path, 'right'], operations);
    repairOperand(value.upper, [...path, 'upper'], operations);
    return;
  }
  if (value.type === 'group' && Array.isArray(value.children)) {
    value.children.forEach((child, index) => {
      repairRule(child, [...path, 'children', index], operations);
    });
  }
}

/**
 * Repairs representation-only defects in a strategy candidate.
 *
 * This middleware deliberately does not add rules, infer missing business
 * fields, rename indicators, remove parameters, or change condition values.
 */
export function repairStrategyCandidate(
  input: unknown,
  generationId: string,
  now = new Date().toISOString(),
): StrategyRepairResult {
  const candidate = clone(input);
  const originalCandidate = clone(candidate);
  const beforeHash = hash(candidate);
  const operations: RepairOperation[] = [];
  if (!isRecord(candidate)) {
    return {
      candidate,
      audit: {
        version: 1,
        originalCandidate,
        beforeHash,
        afterHash: beforeHash,
        changed: false,
        operations,
      },
    };
  }

  convertNumericField(candidate, 'strategyVersion', [], operations);

  if (Array.isArray(candidate.parameters)) {
    candidate.parameters.forEach((value, index) => {
      if (!isRecord(value)) return;
      if (value.type === 'number') {
        convertNumericField(value, 'defaultValue', ['parameters', index], operations);
      }
      for (const field of ['min', 'max', 'step']) {
        convertNumericField(value, field, ['parameters', index], operations);
      }
    });
  }

  if (Array.isArray(candidate.indicators)) {
    candidate.indicators.forEach((value, indicatorIndex) => {
      if (!isRecord(value)) return;
      if (isRecord(value.params)) {
        for (const field of Object.keys(value.params)) {
          convertNumericField(
            value.params,
            field,
            ['indicators', indicatorIndex, 'params'],
            operations,
          );
        }
      }
      if (Array.isArray(value.outputs)) {
        value.outputs.forEach((output, outputIndex) => {
          if (!isRecord(output) || output.type !== undefined) return;
          output.type = 'number';
          operations.push({
            path: ['indicators', indicatorIndex, 'outputs', outputIndex, 'type'],
            kind: 'literal-output-type',
            before: undefined,
            after: 'number',
          });
        });
      }
    });
  }

  repairRule(candidate.entry, ['entry'], operations);
  repairRule(candidate.exit, ['exit'], operations);

  if (Array.isArray(candidate.risk)) {
    candidate.risk.forEach((value, index) => {
      if (!isRecord(value)) return;
      for (const field of ['value', 'losses', 'months']) {
        convertNumericField(value, field, ['risk', index], operations);
      }
    });
  }

  const metadata = isRecord(candidate.metadata) ? candidate.metadata : null;
  if (metadata) {
    const systemFields: Array<[string, unknown]> = [
      ['source', 'ai'],
      ['aiGenerationId', generationId],
      ['updatedAt', now],
    ];
    if (metadata.createdAt === undefined) systemFields.push(['createdAt', now]);
    for (const [field, after] of systemFields) {
      const before = metadata[field];
      if (before === after) continue;
      metadata[field] = after;
      operations.push({
        path: ['metadata', field],
        kind: 'system-metadata-enrichment',
        before,
        after,
      });
    }
  }

  const afterHash = hash(candidate);
  return {
    candidate,
    audit: {
      version: 1,
      originalCandidate,
      beforeHash,
      afterHash,
      changed: beforeHash !== afterHash,
      operations,
    },
  };
}
