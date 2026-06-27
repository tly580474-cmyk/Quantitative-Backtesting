// ============================================================
// Strategy DSL v1.0 — Type Definitions
// ============================================================

// ---- Top-level document ----

export interface VisualStrategyDocument {
  schemaVersion: '1.0';
  id: string;
  name: string;
  description: string;
  strategyVersion: number;
  parameters: StrategyParameter[];
  indicators: IndicatorNode[];
  entry: RuleGroup;
  exit: RuleGroup;
  risk: RiskRule[];
  metadata: StrategyMetadata;
}

export interface StrategyParameter {
  name: string;
  label: string;
  type: 'number' | 'boolean';
  defaultValue: number | boolean;
  min?: number;
  max?: number;
  step?: number;
  description?: string;
}

export interface StrategyMetadata {
  source: 'visual' | 'ai' | 'imported';
  createdAt: string;
  updatedAt: string;
  aiGenerationId?: string;
}

// ---- Indicator declaration ----

export interface IndicatorNode {
  id: string;
  indicatorId: string;
  params: Record<string, number>;
  outputs: IndicatorOutputRef[];
}

export interface IndicatorOutputRef {
  key: string;
  label: string;
  type: 'number';
}

// ---- Operands ----

export type Operand =
  | MarketOperand
  | IndicatorOperand
  | AccountOperand
  | ParameterOperand
  | LiteralOperand;

export interface MarketOperand {
  type: 'market';
  field: MarketField;
  offset: number;
}

export type MarketField = 'open' | 'high' | 'low' | 'close' | 'volume';

export interface IndicatorOperand {
  type: 'indicator';
  nodeId: string;
  output: string;
  offset: number;
}

export interface AccountOperand {
  type: 'account';
  field: AccountField;
}

export type AccountField = 'hasPosition' | 'holdingDays' | 'unrealizedPnlPercent';

export interface ParameterOperand {
  type: 'parameter';
  name: string;
}

export interface LiteralOperand {
  type: 'literal';
  value: number | boolean;
}

// ---- Comparison operators ----

export type CompareOperator =
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'eq'
  | 'crossesAbove'
  | 'crossesBelow'
  | 'between';

// ---- Conditions and logic ----

export interface ConditionRule {
  type: 'condition';
  id: string;
  left: Operand;
  operator: CompareOperator;
  right: Operand;
  /** Required when operator is 'between' */
  upper?: Operand;
}

export interface RuleGroup {
  type: 'group';
  id: string;
  operator: 'all' | 'any' | 'not';
  children: Array<ConditionRule | RuleGroup>;
}

// ---- Risk rules ----

export type RiskRule =
  | {
    type: 'stopLoss' | 'takeProfit' | 'trailingStop' | 'maxHoldingDays';
    value: number;
    /** Percentage for price-based rules (e.g. 8 means 8%); days for maxHoldingDays. */
  }
  | {
    type: 'lossStreakCooldown';
    losses: number;
    months: number;
  };

// ---- Validation ----

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
}

// ---- Compilation trace (for preview/debug) ----

export interface ConditionTrace {
  conditionId: string;
  result: boolean;
  leftValue: number | boolean | null;
  rightValue: number | boolean | null;
  operator: CompareOperator;
  upperValue?: number | null;
  reason: string;
}

export interface StrategySignalWithTrace {
  time: string;
  action: 'buy' | 'sell' | 'hold';
  reason: string;
  strength?: number;
  /** Per-condition trace for this bar (only when action != 'hold') */
  trace?: ConditionTrace[];
}

// ---- Database shapes ----

export interface StoredVisualStrategy {
  id: string;
  name: string;
  document: VisualStrategyDocument;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
}

export interface StoredStrategyVersion {
  id: string;
  strategyId: string;
  version: number;
  document: VisualStrategyDocument;
  createdAt: string;
}

export interface StoredStrategyDraft {
  id: string;
  strategyId: string;
  document: VisualStrategyDocument;
  updatedAt: string;
}
