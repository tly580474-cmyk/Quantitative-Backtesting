import { ZodError } from 'zod';
import { StrategyOutputValidationError } from '../services/strategyGeneration/schema.js';

// N4.1：确定性错误分类（设计文档 9.1）。
// 错误码由发生错误的组件直接产生，不依靠 LLM 从 Traceback 猜测；
// 未知异常统一为 INTERNAL_ERROR，不允许把 VALIDATION_FAILED 等业务错误
// 降级为可重试错误（ADR-11）。

export const experimentErrorCategories = [
  'SCHEMA_INVALID',
  'SEMANTIC_CONFLICT',
  'UNSUPPORTED_CAPABILITY',
  'COMPILE_FAILED',
  'DATA_MISSING',
  'DATA_QUALITY_FAILED',
  'RESOURCE_EXCEEDED',
  'RUNTIME_FAILED',
  'VALIDATION_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ExperimentErrorCategory = (typeof experimentErrorCategories)[number];

export interface ErrorCategoryMeta {
  /** 中文标签（供 UI/解释 Agent 使用） */
  label: string;
  /** 产生组件 */
  producedBy: string;
  /** 用户动作指引 */
  userAction: string;
  /** 是否可通过基础设施重试解决（业务错误不得重试，见设计文档 9.3） */
  retryable: boolean;
}

export const EXPERIMENT_ERROR_CATEGORY_META: Record<ExperimentErrorCategory, ErrorCategoryMeta> = {
  SCHEMA_INVALID: {
    label: 'Schema 校验失败',
    producedBy: 'Schema Validator',
    userAction: '查看字段定位并修正描述/选项',
    retryable: true,
  },
  SEMANTIC_CONFLICT: {
    label: '语义冲突',
    producedBy: 'Semantic Validator',
    userAction: '解决冲突条件',
    retryable: true,
  },
  UNSUPPORTED_CAPABILITY: {
    label: '能力超出边界',
    producedBy: 'Capability Resolver',
    userAction: '缩小范围或等待能力实现',
    retryable: false,
  },
  COMPILE_FAILED: {
    label: '策略编译失败',
    producedBy: 'Deterministic Compiler',
    userAction: '根据规则路径修正策略',
    retryable: true,
  },
  DATA_MISSING: {
    label: '数据缺失',
    producedBy: 'Data Resolver',
    userAction: '更换快照、区间或字段',
    retryable: true,
  },
  DATA_QUALITY_FAILED: {
    label: '数据质量未通过',
    producedBy: 'Data Gate',
    userAction: '修复数据后重新运行',
    retryable: true,
  },
  RESOURCE_EXCEEDED: {
    label: '资源超限',
    producedBy: 'Worker Supervisor',
    userAction: '缩小实验或提高已审批预算',
    retryable: false,
  },
  RUNTIME_FAILED: {
    label: '运行失败',
    producedBy: 'Runtime Adapter',
    userAction: '提交工程问题，不自动改策略',
    retryable: false,
  },
  VALIDATION_FAILED: {
    label: '研究结论未通过验证',
    producedBy: 'Validation Gate',
    userAction: '查看研究结论，不作为程序错误重试',
    retryable: false,
  },
  INTERNAL_ERROR: {
    label: '内部错误',
    producedBy: 'Unknown',
    userAction: '附关联 ID 反馈',
    retryable: false,
  },
};

export function isExperimentErrorCategory(value: string): value is ExperimentErrorCategory {
  return (experimentErrorCategories as readonly string[]).includes(value);
}

/** 结构化错误载荷（路由返回 + 解释 Agent 输入）。 */
export interface CategorizedErrorPayload {
  category: ExperimentErrorCategory;
  code: ExperimentErrorCategory;
  message: string;
  /** 字段路径列表（如 "entry.left"），供 UI 定位 */
  fieldPaths: string[];
  issues: string[];
}

function extractFieldPaths(errors: string[]): string[] {
  const paths: string[] = [];
  for (const line of errors) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0 && !line.startsWith('root:')) {
      paths.push(line.slice(0, colonIndex).trim());
    }
  }
  return paths;
}

/**
 * 把策略输出校验错误分类为 SCHEMA_INVALID，并提取字段路径。
 * 兜底 INTERNAL_ERROR（未知异常不得被 Agent 降级为可重试错误）。
 */
export function classifyStrategyOutputError(error: unknown): CategorizedErrorPayload {
  if (error instanceof StrategyOutputValidationError) {
    const issues = error.validationErrors;
    return {
      category: 'SCHEMA_INVALID',
      code: 'SCHEMA_INVALID',
      message: '模型返回的策略未通过 DSL 校验',
      fieldPaths: extractFieldPaths(issues),
      issues,
    };
  }
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      return `${path}: ${issue.message}`;
    });
    return {
      category: 'SCHEMA_INVALID',
      code: 'SCHEMA_INVALID',
      message: '请求未通过 Schema 校验',
      fieldPaths: error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
      issues,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    category: 'INTERNAL_ERROR',
    code: 'INTERNAL_ERROR',
    message,
    fieldPaths: [],
    issues: [message],
  };
}

/** 运行失败错误码 → 九类分类（fail 枚举与类别一一对应）。 */
export function classifyRunFailure(errorCode: string): ExperimentErrorCategory {
  if (isExperimentErrorCategory(errorCode) && errorCode !== 'INTERNAL_ERROR') return errorCode;
  return 'INTERNAL_ERROR';
}
