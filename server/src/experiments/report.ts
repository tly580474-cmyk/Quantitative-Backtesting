import { canonicalHash } from './schema.js';
import { VALIDATION_CALCULATOR_VERSION, type ValidationCheck } from './validation.js';

export const EXPERIMENT_REPORT_TEMPLATE_VERSION = 'experiment-report-1.0.0';

export interface TraceableMetric {
  key: string;
  label: string;
  value: unknown;
  sourcePath: string;
  calculatorVersion: string;
}

export interface StructuredExperimentReport {
  schemaVersion: '1.0';
  templateVersion: string;
  runId: string;
  experimentVersionId: string;
  generatedAt: string;
  strategy: { name: string; specHash: string; compilerVersion: string };
  dataset: Record<string, unknown>;
  execution: Record<string, unknown>;
  metrics: TraceableMetric[];
  validation: { status: string; policyVersion: string; checks: ValidationCheck[] };
  evidence: { resultHash: string; evaluationHash: string; calculatorVersion: string };
}

const METRIC_LABELS: Record<string, string> = {
  totalReturn: '累计收益率', annualizedReturn: '年化收益率', annualizedVolatility: '年化波动率',
  sharpeRatio: '夏普比率', maxDrawdown: '最大回撤', tradeCount: '交易次数', winRate: '胜率',
  profitFactor: '盈亏比', totalCommission: '总手续费', totalTax: '总印花税', totalSlippage: '总滑点成本',
  benchmarkReturn: '基准收益率', excessReturn: '超额收益率', finalEquity: '期末权益',
};

export function buildStructuredReport(input: {
  runId: string;
  experimentVersionId: string;
  generatedAt: string;
  strategyName: string;
  specHash: string;
  compilerVersion: string;
  dataset: Record<string, unknown>;
  execution: Record<string, unknown>;
  metrics: Record<string, unknown>;
  validationStatus: string;
  policyVersion: string;
  checks: ValidationCheck[];
  resultHash: string;
  evaluationHash: string;
}): StructuredExperimentReport {
  const metrics = Object.entries(input.metrics).map(([key, value]) => ({
    key,
    label: METRIC_LABELS[key] ?? key,
    value,
    sourcePath: `$.backtestResult.metrics.${key}`,
    calculatorVersion: VALIDATION_CALCULATOR_VERSION,
  }));
  return {
    schemaVersion: '1.0', templateVersion: EXPERIMENT_REPORT_TEMPLATE_VERSION,
    runId: input.runId, experimentVersionId: input.experimentVersionId, generatedAt: input.generatedAt,
    strategy: { name: input.strategyName, specHash: input.specHash, compilerVersion: input.compilerVersion },
    dataset: input.dataset, execution: input.execution, metrics,
    validation: { status: input.validationStatus, policyVersion: input.policyVersion, checks: input.checks },
    evidence: { resultHash: input.resultHash, evaluationHash: input.evaluationHash, calculatorVersion: VALIDATION_CALCULATOR_VERSION },
  };
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  if (typeof value === 'object') return `\`${JSON.stringify(value)}\``;
  return String(value);
}

export function renderExperimentMarkdown(report: StructuredExperimentReport): string {
  const metricRows = report.metrics.map((metric) => `| ${metric.label} | ${display(metric.value)} | \`${metric.sourcePath}\` | \`${metric.calculatorVersion}\` |`).join('\n');
  const checkRows = report.validation.checks.map((check) => `| ${check.category} | ${check.message} | ${check.status} | \`${check.sourcePath}\` | ${display(check.value)} |`).join('\n');
  return [
    `# ${report.strategy.name} — 实验报告`, '',
    `- 实验运行：\`${report.runId}\``,
    `- 实验版本：\`${report.experimentVersionId}\``,
    `- 规格摘要：\`${report.strategy.specHash}\``,
    `- 报告模板：\`${report.templateVersion}\``,
    `- 门禁结论：**${report.validation.status}**（策略 \`${report.validation.policyVersion}\`）`, '',
    '## 数据与执行', '',
    `- 数据快照：\`${JSON.stringify(report.dataset)}\``,
    `- 执行计划：\`${JSON.stringify(report.execution)}\``, '',
    '## 核心绩效', '',
    '| 指标 | 数值 | 数据来源 | 计算器版本 |', '| --- | ---: | --- | --- |', metricRows, '',
    '## 校验门禁', '',
    '| 类别 | 检查 | 状态 | 数据来源 | 数值 |', '| --- | --- | --- | --- | ---: |', checkRows, '',
    '## 证据链', '',
    `- 回测结果哈希：\`${report.evidence.resultHash}\``,
    `- 门禁评价哈希：\`${report.evidence.evaluationHash}\``,
    `- 报告结构哈希：\`${canonicalHash(report)}\``, '',
    '> 本报告用于研究复核，不构成投资建议。',
  ].join('\n');
}

export function reportHash(report: StructuredExperimentReport, markdown: string): string {
  return canonicalHash({ report, markdown });
}
