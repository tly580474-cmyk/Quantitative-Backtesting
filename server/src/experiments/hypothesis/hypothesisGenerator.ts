import { listPublishedEventStrategyCatalog, parseEventStrategy } from '../m5/eventEngineStrategies.js';
import { listFactorCatalog } from '../../factorResearch/repositories/factorRepository.js';
import {
  hypothesisPlanSchema,
  hypothesisStrategyTypeSchema,
  type HypothesisPlan,
  type GenerateHypothesesRequest,
} from './hypothesisSchema.js';
import type { HypothesisLlmProvider } from './hypothesisLlm.js';

// N3.1：假设生成编排（能力清单驱动）。
// 能力边界 = 事件引擎白名单策略（可评估）+ 因子库 + 指标注册表。
// LLM 输出逐条校验：strategyType 必须在白名单内、params 必须通过
// 事件引擎参数 Schema（防幻觉/防越界）；非法条目被拒绝并返回原因。
//
// N5.4：能力清单自动发布（沿用 E7 模式）。策略清单只暴露已通过黄金样例
// 验收（goldenParityLocked === true）的策略；capabilityVersion 由服务端
// 常量决定，LLM 无法伪造。

/** 当前已发布能力版本（与已验收策略集绑定，新增能力须更新此版本） */
export const PUBLISHED_EXPERIMENT_CAPABILITY_VERSION = 'mvp4-event-engine-v1';

export interface GenerateHypothesesResult {
  plans: HypothesisPlan[];
  rejected: Array<{ name: string; reason: string }>;
}

export interface HypothesisCapabilityContext {
  factorIds: string[];
  indicatorIds: string[];
  strategyTypes: string[];
}

/** 构建注入 prompt 的能力清单上下文。 */
export function buildHypothesisCapabilityContext(input?: {
  factorIds?: string[];
  indicatorIds?: string[];
  strategyTypes?: string[];
}): HypothesisCapabilityContext {
  return {
    factorIds: input?.factorIds ?? [],
    indicatorIds: input?.indicatorIds ?? [],
    strategyTypes: input?.strategyTypes ?? [...hypothesisStrategyTypeSchema.options],
  };
}

export function formatCapabilityContext(context: HypothesisCapabilityContext): string {
  return JSON.stringify({
    strategies: listPublishedEventStrategyCatalog(),
    factorIds: context.factorIds,
    indicatorIds: context.indicatorIds,
  });
}

/** 从因子库/指标/事件引擎白名单构建能力清单（DB 在线时含已发布因子）。 */
export async function loadHypothesisCapabilityContext(
  dbOnline: boolean,
  staticContext?: HypothesisCapabilityContext,
): Promise<HypothesisCapabilityContext> {
  const context = buildHypothesisCapabilityContext(staticContext);
  if (dbOnline) {
    try {
      const catalog = await listFactorCatalog();
      context.factorIds = catalog.map((item) => item.definition.id);
    } catch {
      // DB 不可用时退化为静态清单（仅事件引擎白名单可评估）
    }
  }
  return context;
}

/**
 * 生成假设草稿：调 LLM → 逐条校验 → 返回可落库的 plan 与拒绝清单。
 * 校验失败的条目不落库（能力边界内不允许越界假设）。
 */
export async function generateHypotheses(input: {
  provider: HypothesisLlmProvider;
  capabilityContext: HypothesisCapabilityContext;
  request: GenerateHypothesesRequest;
}): Promise<GenerateHypothesesResult> {
  const raw = await input.provider.generateHypotheses({
    capabilityContext: formatCapabilityContext(input.capabilityContext),
    prompt: input.request.prompt,
    count: input.request.count,
    model: input.request.model,
  });
  const candidates = extractHypothesisCandidates(raw);
  const plans: HypothesisPlan[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];
  for (const candidate of candidates) {
    const label = typeof candidate.name === 'string' ? candidate.name : '(未命名)';
    const name = String(label);
    try {
      // 能力边界校验：strategyType 白名单 + 事件引擎参数 Schema
      const strategy = parseEventStrategy({
        type: candidate.strategyType,
        params: candidate.params ?? {},
      });
      const plan = hypothesisPlanSchema.parse({
        protocolVersion: '1.0',
        strategyType: strategy.type,
        params: strategy.params,
        name: name.slice(0, 255),
        description: String(candidate.description ?? '').slice(0, 2000),
        rationale: String(candidate.rationale ?? '').slice(0, 4000),
        // N5.4：能力版本由服务端已发布清单决定，忽略 LLM 伪造的 capabilityVersion
        capabilityVersion: PUBLISHED_EXPERIMENT_CAPABILITY_VERSION,
      });
      plans.push(plan);
    } catch (error) {
      rejected.push({ name, reason: error instanceof Error ? error.message : 'schema validation failed' });
    }
  }
  return { plans, rejected };
}

function extractHypothesisCandidates(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const hypotheses = (raw as { hypotheses?: unknown }).hypotheses;
  if (!Array.isArray(hypotheses)) return [];
  return hypotheses.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}
