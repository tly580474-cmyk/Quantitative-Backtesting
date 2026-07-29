import { createHash } from 'node:crypto';
import type {
  AstFactorExpression,
  FactorAstNode,
  FactorDirection,
} from '../definitions/schema.js';

const COMMUTATIVE_OPERATORS = new Set(['add', 'mul', 'min', 'max']);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function windowBucket(window: number | undefined): string | null {
  if (window == null) return null;
  if (window <= 5) return 'very_short';
  if (window <= 20) return 'short';
  if (window <= 60) return 'medium';
  return 'long';
}

function normalizeExact(node: FactorAstNode): unknown {
  if (node.type === 'terminal') return { type: 'terminal', name: node.name };
  if (node.type === 'constant') return { type: 'constant', value: node.value };
  const args = node.args.map(normalizeExact);
  return {
    type: 'operator',
    op: node.op,
    ...(node.window == null ? {} : { window: node.window }),
    args: COMMUTATIVE_OPERATORS.has(node.op)
      ? args.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      : args,
  };
}

function normalizeFamily(node: FactorAstNode): unknown {
  if (node.type === 'terminal') return { type: 'terminal', name: node.name };
  if (node.type === 'constant') return { type: 'constant', value: '*' };
  const args = node.args.map(normalizeFamily);
  return {
    type: 'operator',
    op: node.op,
    ...(node.window == null ? {} : { window: windowBucket(node.window) }),
    args: COMMUTATIVE_OPERATORS.has(node.op)
      ? args.sort((left, right) => stableJson(left).localeCompare(stableJson(right)))
      : args,
  };
}

export function buildCandidateSignatures(
  expression: AstFactorExpression,
  direction: FactorDirection,
): { signature: string; familySignature: string } {
  return {
    signature: hash({ direction, root: normalizeExact(expression.root) }),
    familySignature: hash({ direction, root: normalizeFamily(expression.root) }),
  };
}
