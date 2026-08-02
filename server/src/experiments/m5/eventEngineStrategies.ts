import { z } from 'zod';

// N1.3：事件引擎白名单策略注册表（Backtrader 事件策略包装器）。
// 只允许注册表内声明的策略类型进入事件引擎；参数经 Zod 校验后
// 才可传递到 Python 侧。新增策略必须先在此注册并补充黄金样例。

const dualMaParamsSchema = z.object({
  fast: z.number().int().min(2).max(500),
  slow: z.number().int().min(3).max(1000),
}).refine((value) => value.fast < value.slow, {
  message: 'fast 周期必须小于 slow 周期',
  path: ['fast'],
});

export const eventStrategySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('dual_ma'),
    params: dualMaParamsSchema,
  }),
]);

export type EventStrategy = z.infer<typeof eventStrategySchema>;

export interface EventStrategyDefinition {
  id: 'dual_ma';
  name: string;
  description: string;
  paramsSchema: z.ZodType;
  warmupBars: (params: unknown) => number;
  defaultParams: Record<string, number>;
  /** 是否已有黄金样例锁定与 TS 引擎的一致性 */
  goldenParityLocked: boolean;
}

export const EVENT_STRATEGY_REGISTRY: ReadonlyMap<string, EventStrategyDefinition> = new Map([
  ['dual_ma', {
    id: 'dual_ma',
    name: '双均线交叉',
    description: '短期均线上穿长期均线买入，下穿卖出（与 TS dualMaStrategy 一致）',
    paramsSchema: dualMaParamsSchema,
    warmupBars: (params) => {
      const p = params as { fast: number; slow: number };
      return Math.max(p.fast, p.slow);
    },
    defaultParams: { fast: 5, slow: 20 },
    goldenParityLocked: true,
  }],
]);

export function getEventStrategyDefinition(type: string): EventStrategyDefinition | undefined {
  return EVENT_STRATEGY_REGISTRY.get(type);
}

export function listEventStrategyCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  warmupBars: number;
  defaultParams: Record<string, number>;
  goldenParityLocked: boolean;
}> {
  return [...EVENT_STRATEGY_REGISTRY.values()].map((definition) => ({
    id: definition.id,
    name: definition.name,
    description: definition.description,
    warmupBars: definition.warmupBars(definition.defaultParams),
    defaultParams: definition.defaultParams,
    goldenParityLocked: definition.goldenParityLocked,
  }));
}

export function parseEventStrategy(value: unknown): EventStrategy {
  return eventStrategySchema.parse(value);
}
