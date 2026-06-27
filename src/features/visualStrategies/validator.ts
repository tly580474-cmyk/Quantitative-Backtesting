import type {
  VisualStrategyDocument,
  ValidationResult,
  ValidationError,
  Operand,
  ConditionRule,
  RuleGroup,
} from './types';
import { visualStrategyDocumentSchema } from './schema';
import { INDICATOR_REGISTRY } from '@/features/indicators/registry';

/**
 * Full validation pipeline: structure → semantics.
 */
export function validateDocument(doc: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];

  // ---- Step 1: Structure validation via Zod ----
  const result = visualStrategyDocumentSchema.safeParse(doc);
  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
    return { valid: false, errors, warnings };
  }

  const document = result.data;

  // ---- Step 2: Semantic validation ----
  validateIndicatorNodes(document, errors);
  validateNoCircularDependencies(document, errors);
  validateNoFutureFunction(document, errors);
  validateRuleGroupNonEmpty(document.entry, 'entry', errors);
  validateRuleGroupNonEmpty(document.exit, 'exit', errors);
  validateConditions(document, errors);
  validateCrossOperands(document, errors);
  validateParameterReferences(document, errors);
  validateUnusedParameters(document, warnings);
  validateRiskRules(document, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---- Semantic checks ----

function addError(path: string, message: string, errors: ValidationError[]): void {
  errors.push({ path, message });
}

/**
 * Ensure each IndicatorNode's indicatorId exists in the registry.
 */
function validateIndicatorNodes(doc: VisualStrategyDocument, errors: ValidationError[]): void {
  for (const node of doc.indicators) {
    const def = INDICATOR_REGISTRY.find((d) => d.id === node.indicatorId);
    if (!def) {
      addError(
        `indicators.${node.id}`,
        `未知指标类型: ${node.indicatorId}`,
        errors,
      );
      continue;
    }

    // Validate that outputs reference known series keys for this indicator
    const knownKeys = new Set(def.display.series.map((s) => s.key));
    // RSI used a single `rsi` output before the three-period configuration.
    // Accept that persisted output so existing drafts remain publishable.
    if (node.indicatorId === 'rsi') knownKeys.add('rsi');
    for (const output of node.outputs) {
      if (!knownKeys.has(output.key)) {
        addError(
          `indicators.${node.id}.outputs.${output.key}`,
          `指标 ${node.indicatorId} 没有输出字段: ${output.key}（可用: ${[...knownKeys].join(', ')}）`,
          errors,
        );
      }
    }

    // Validate provided params are within allowed range
    for (const [paramName, paramValue] of Object.entries(node.params)) {
      const defParam = def.params.find((p) => p.name === paramName);
      if (defParam && typeof paramValue === 'number') {
        if (paramValue < defParam.min || paramValue > defParam.max) {
          addError(
            `indicators.${node.id}.params.${paramName}`,
            `参数 ${paramName}=${paramValue} 超出范围 [${defParam.min}, ${defParam.max}]`,
            errors,
          );
        }
      }
    }
  }
}

/**
 * Detect circular indicator references (not yet applicable in MVP since
 * indicators don't reference other indicators, but scaffold for future).
 */
function validateNoCircularDependencies(
  _doc: VisualStrategyDocument,
  _errors: ValidationError[],
): void {
  // In MVP, indicators don't depend on other indicators.
  // A topological sort is a no-op. Added for future use.
}

/**
 * Reject any operand with offset > 0 (future function).
 */
function validateNoFutureFunction(doc: VisualStrategyDocument, errors: ValidationError[]): void {
  const checkOperand = (op: Operand, path: string): void => {
    if ('offset' in op && typeof op.offset === 'number' && op.offset > 0) {
      addError(path, `禁止使用未来函数: offset=${op.offset}（只能引用当前及历史K线）`, errors);
    }
  };

  const walkOperands = (op: Operand, path: string): void => {
    checkOperand(op, path);
  };

  const walkCondition = (cond: ConditionRule, path: string): void => {
    walkOperands(cond.left, `${path}.left`);
    walkOperands(cond.right, `${path}.right`);
    if (cond.upper) {
      walkOperands(cond.upper, `${path}.upper`);
    }
  };

  const walkGroup = (group: RuleGroup, path: string): void => {
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child.type === 'condition') {
        walkCondition(child, `${path}.children[${i}]`);
      } else {
        walkGroup(child, `${path}.children[${i}]`);
      }
    }
  };

  walkGroup(doc.entry, 'entry');
  walkGroup(doc.exit, 'exit');
}

/**
 * Rule groups must have at least one child condition/group.
 */
function validateRuleGroupNonEmpty(
  group: RuleGroup,
  path: string,
  errors: ValidationError[],
): void {
  if (group.children.length === 0) {
    addError(path, '规则组不能为空', errors);
  }
  for (let i = 0; i < group.children.length; i++) {
    const child = group.children[i];
    if (child.type === 'group') {
      validateRuleGroupNonEmpty(child, `${path}.children[${i}]`, errors);
    }
  }
}

/**
 * Validate condition-level constraints:
 * - 'between' operator must have `upper` operand
 * - Non-'between' operators should not have `upper`
 * - Type compatibility (number vs boolean) for operators
 */
function validateConditions(doc: VisualStrategyDocument, errors: ValidationError[]): void {
  const walkGroup = (group: RuleGroup, path: string): void => {
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child.type === 'condition') {
        validateCondition(child, `${path}.children[${i}]`, errors);
      } else {
        walkGroup(child, `${path}.children[${i}]`);
      }
    }
  };

  walkGroup(doc.entry, 'entry');
  walkGroup(doc.exit, 'exit');
}

function validateCondition(
  cond: ConditionRule,
  path: string,
  errors: ValidationError[],
): void {
  if (cond.operator === 'between' && !cond.upper) {
    addError(path, 'between 操作符必须提供 upper 上界', errors);
  }
  if (cond.operator !== 'between' && cond.upper) {
    addError(path, `只有 between 操作符才需要 upper，当前为: ${cond.operator}`, errors);
  }

  // Check operand type compatibility
  const leftType = operandType(cond.left);
  const rightType = operandType(cond.right);

  if (leftType !== rightType && leftType !== 'any' && rightType !== 'any') {
    addError(path, `操作数类型不匹配: ${leftType} vs ${rightType}`, errors);
  }

  // Boolean operands: only eq is valid
  if (leftType === 'boolean' && cond.operator !== 'eq') {
    addError(path, `布尔类型操作数只能使用 eq 操作符，当前: ${cond.operator}`, errors);
  }
}

/** Get the value type of an operand for compatibility checks. */
function operandType(op: Operand): 'number' | 'boolean' | 'any' {
  switch (op.type) {
    case 'market':
    case 'indicator':
      return 'number';
    case 'account':
      if (op.field === 'hasPosition') return 'boolean';
      return 'number';
    case 'parameter':
      return 'any'; // Could be number or boolean
    case 'literal':
      return typeof op.value === 'boolean' ? 'boolean' : 'number';
  }
}

/**
 * Cross-above/below operators must compare compatible types (sequences, not booleans).
 */
function validateCrossOperands(doc: VisualStrategyDocument, errors: ValidationError[]): void {
  const walkGroup = (group: RuleGroup, path: string): void => {
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child.type === 'condition') {
        validateCrossCondition(child, `${path}.children[${i}]`, errors);
      } else {
        walkGroup(child, `${path}.children[${i}]`);
      }
    }
  };

  walkGroup(doc.entry, 'entry');
  walkGroup(doc.exit, 'exit');
}

function validateCrossCondition(
  cond: ConditionRule,
  path: string,
  errors: ValidationError[],
): void {
  if (cond.operator === 'crossesAbove' || cond.operator === 'crossesBelow') {
    if (operandType(cond.left) === 'boolean' || operandType(cond.right) === 'boolean') {
      addError(path, '上穿/下穿操作符不能用于布尔类型操作数', errors);
    }
  }
}

/**
 * Validate that parameter operands reference declared parameters.
 */
function validateParameterReferences(
  doc: VisualStrategyDocument,
  errors: ValidationError[],
): void {
  const paramNames = new Set(doc.parameters.map((p) => p.name));

  const checkOperand = (op: Operand, path: string): void => {
    if (op.type === 'parameter' && !paramNames.has(op.name)) {
      addError(path, `未声明的策略参数: ${op.name}`, errors);
    }
  };

  const walkGroup = (group: RuleGroup, path: string): void => {
    for (let i = 0; i < group.children.length; i++) {
      const child = group.children[i];
      if (child.type === 'condition') {
        checkOperand(child.left, `${path}.children[${i}].left`);
        checkOperand(child.right, `${path}.children[${i}].right`);
        if (child.upper) {
          checkOperand(child.upper, `${path}.children[${i}].upper`);
        }
      } else {
        walkGroup(child, `${path}.children[${i}]`);
      }
    }
  };

  walkGroup(doc.entry, 'entry');
  walkGroup(doc.exit, 'exit');
}

function validateUnusedParameters(
  doc: VisualStrategyDocument,
  warnings: ValidationError[],
): void {
  const referenced = new Set<string>();

  const checkOperand = (op: Operand): void => {
    if (op.type === 'parameter') referenced.add(op.name);
  };

  const walkGroup = (group: RuleGroup): void => {
    for (const child of group.children) {
      if (child.type === 'condition') {
        checkOperand(child.left);
        checkOperand(child.right);
        if (child.upper) checkOperand(child.upper);
      } else {
        walkGroup(child);
      }
    }
  };

  walkGroup(doc.entry);
  walkGroup(doc.exit);

  for (const param of doc.parameters) {
    if (!referenced.has(param.name)) {
      warnings.push({
        path: `parameters.${param.name}`,
        message: `策略参数 ${param.label || param.name} 未被买入/卖出条件引用，不会影响交易`,
      });
    }
  }
}

/**
 * Validate risk rules (basic).
 */
function validateRiskRules(doc: VisualStrategyDocument, errors: ValidationError[]): void {
  const types = new Set(doc.risk.map((r) => r.type));
  if (types.size !== doc.risk.length) {
    addError('risk', '风控规则中存在重复类型', errors);
  }
  for (const rule of doc.risk) {
    if (rule.type === 'stopLoss' || rule.type === 'takeProfit' || rule.type === 'trailingStop') {
      if (rule.value <= 0 || rule.value > 100) {
        addError(`risk.${rule.type}`, '价格风控百分比应在 0-100 之间', errors);
      }
    }
    if (rule.type === 'maxHoldingDays') {
      if (rule.value < 1 || rule.value > 365 * 10) {
        addError(`risk.${rule.type}`, '最大持仓天数应在 1-3650 之间', errors);
      }
    }
    if (rule.type === 'lossStreakCooldown') {
      if (rule.losses < 1 || rule.losses > 100) {
        addError(`risk.${rule.type}.losses`, '连续亏损笔数应在 1-100 之间', errors);
      }
      if (rule.months < 1 || rule.months > 120) {
        addError(`risk.${rule.type}.months`, '暂停月份应在 1-120 之间', errors);
      }
    }
  }
}
