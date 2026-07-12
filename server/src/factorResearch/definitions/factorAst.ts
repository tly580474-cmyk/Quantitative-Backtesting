import type { FactorAstNode, FactorAstTerminal, FactorDependency } from './schema.js';

const TERMINALS = new Set<FactorAstTerminal>([
  'open', 'high', 'low', 'close', 'previousClose', 'volume', 'amount',
  'turnoverRatePct', 'returns', 'vwap',
  'totalMarketCap', 'log_mktcap',
]);
const ARITY: Record<string, number> = {
  add: 2, sub: 2, mul: 2, div: 2, min: 2, max: 2,
  neg: 1, abs: 1, log: 1, sqrt: 1, sign: 1, inv: 1,
  cs_rank: 1, cs_zscore: 1, cs_neutralize: 2, cs_indneutral: 1,
  ts_delay: 1, ts_delta: 1, ts_mean: 1, ts_std: 1,
  ts_min: 1, ts_max: 1, ts_sum: 1,
};
const WINDOW_OPERATORS = new Set([
  'ts_delay', 'ts_delta', 'ts_mean', 'ts_std', 'ts_min', 'ts_max', 'ts_sum',
]);

export interface FactorAstAnalysis {
  dependencies: FactorDependency[];
  warmupDays: number;
  nodeCount: number;
  depth: number;
}

export function validateAndAnalyzeFactorAst(root: FactorAstNode): FactorAstAnalysis {
  const dependencies = new Set<FactorDependency>();
  let nodeCount = 0;
  let maxDepth = 0;
  let warmupDays = 0;

  function visit(node: FactorAstNode, depth: number): void {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);
    if (nodeCount > 128) throw new Error('因子 AST 节点数不能超过 128');
    if (depth > 12) throw new Error('因子 AST 深度不能超过 12');
    if (node.type === 'constant') {
      if (!Number.isFinite(node.value) || Math.abs(node.value) > 1e6) {
        throw new Error('因子 AST 常数必须是绝对值不超过 1e6 的有限数');
      }
      return;
    }
    if (node.type === 'terminal') {
      if (!TERMINALS.has(node.name)) throw new Error(`不支持的因子终端：${node.name}`);
      if (node.name === 'returns') dependencies.add('close'), dependencies.add('previousClose');
      else if (node.name === 'vwap') dependencies.add('amount'), dependencies.add('volume');
      else if (node.name === 'log_mktcap') dependencies.add('totalMarketCap');
      else dependencies.add(node.name);
      return;
    }
    const expected = ARITY[node.op];
    if (expected === undefined) throw new Error(`不支持的因子算子：${node.op}`);
    if (node.args.length !== expected) throw new Error(`算子 ${node.op} 需要 ${expected} 个参数`);
    if (WINDOW_OPERATORS.has(node.op)) {
      if (!Number.isInteger(node.window) || Number(node.window) < 2 || Number(node.window) > 252) {
        throw new Error(`算子 ${node.op} 的窗口必须是 2～252 的整数`);
      }
      warmupDays = Math.max(warmupDays, Number(node.window));
    } else if (node.window !== undefined) {
      throw new Error(`算子 ${node.op} 不接受窗口参数`);
    }
    if (node.op === 'cs_indneutral') dependencies.add('industry');
    node.args.forEach((arg) => visit(arg, depth + 1));
  }

  visit(root, 1);
  return { dependencies: [...dependencies].sort(), warmupDays, nodeCount, depth: maxDepth };
}
