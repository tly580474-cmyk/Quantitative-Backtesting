import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import OpenAI from 'openai';
import { buildStrategyCapabilityRegistry } from '../services/strategyGeneration/capabilityRegistry.js';
import {
  acceptanceStatus,
  allocateCategoryTargets,
  judgePassed,
  m1JudgeBatchSchema,
  m1SyntheticCandidateSchema,
  type M1Category,
  type M1JudgeResult,
  type M1SyntheticCandidate,
} from './m1SyntheticSchemas.js';

const PROMPT_VERSION = 'm1-synthetic-abc-v1';

interface CliOptions {
  target: number;
  batchSize: number;
  maxRoundsPerCategory: number;
  runId: string;
  outputRoot: string;
}

interface ModelConfig {
  role: 'A' | 'B' | 'C';
  model: string;
  baseURL: string;
  apiKey: string;
}

interface CallResult<T> {
  data: T;
  usage: unknown;
  responseId?: string;
}

interface AuditedSample {
  id: string;
  candidate: M1SyntheticCandidate;
  judgeB: M1JudgeResult;
  judgeC: M1JudgeResult;
  judgeBPassed: boolean;
  judgeCPassed: boolean;
  status: 'accepted' | 'rejected';
  promptVersion: string;
  capabilityVersion: string;
  models: { generator: string; judgeB: string; judgeC: string };
  createdAt: string;
}

function integerArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function stringArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
}

function options(): CliOptions {
  return {
    target: integerArg('target', 200),
    batchSize: Math.min(integerArg('batch-size', 10), 25),
    maxRoundsPerCategory: integerArg('max-rounds', 30),
    runId: stringArg('run-id', new Date().toISOString().replace(/[:.]/g, '-')),
    outputRoot: stringArg('output-root', path.resolve('evaluation/m1/runs')),
  };
}

function modelConfig(role: 'A' | 'B' | 'C'): ModelConfig {
  const fallbackKey = process.env.OPENAI_API_KEY ?? '';
  const fallbackBaseURL = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const fallbackModel = process.env.OPENAI_MODEL ?? '';
  return {
    role,
    apiKey: process.env[`M1_MODEL_${role}_API_KEY`] || fallbackKey,
    baseURL: process.env[`M1_MODEL_${role}_BASE_URL`] || fallbackBaseURL,
    model: process.env[`M1_MODEL_${role}`] || fallbackModel,
  };
}

function client(config: ModelConfig): OpenAI {
  if (!config.apiKey || !config.model) {
    throw new Error(`模型 ${config.role} 未配置。请设置 M1_MODEL_${config.role} 及对应 API_KEY，或配置 OPENAI_MODEL/OPENAI_API_KEY。`);
  }
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    timeout: Number(process.env.OPENAI_TIMEOUT_MS || 60000),
    maxRetries: 2,
  });
}

async function requestJson<T>(
  ai: OpenAI,
  config: ModelConfig,
  system: string,
  user: string,
  temperature: number,
): Promise<CallResult<T>> {
  const response = await ai.chat.completions.create({
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
    temperature,
    max_tokens: 16384,
    ...(/^deepseek-v4(?:-|$)/i.test(config.model.trim())
      ? { thinking: { type: 'disabled' as const } }
      : {}),
  });
  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error(`模型 ${config.role} 返回空响应`);
  return {
    data: JSON.parse(content) as T,
    usage: response.usage,
    responseId: response.id,
  };
}

function generatorSystemPrompt(capabilities: unknown): string {
  return `你是 M1 标注语料生成模型 A。你只负责生成候选语料，不负责判定自己是否通过。

目标是生成真实、多样、口语化的中文量化策略输入，以及严格基于原文证据的 Gold 候选标签。
禁止为了让标签完整而给用户原文补写交易意图。缺失关键信息必须进入 clarifications；超出能力必须进入 unsupportedCapabilities。

当前权威能力清单：
${JSON.stringify(capabilities)}

输出 JSON：{"samples":[...]}
每个样本字段：
- sourceText: 用户原话，不得像 Schema 说明书；
- category: complete | partial | short_colloquial | conflicting | unsupported；
- expectedDisposition: structured | needs_clarification | unsupported；
- extractedFacts: [{path, semanticType, operator?, value, unit?, evidenceQuote}]，evidenceQuote 必须是原文连续片段；semanticType 只能是 indicator_parameter、entry_condition、exit_condition、risk_rule、experiment_config、explicit_user_fact 之一；
- assumptions: [{field,value,basis,reason}]，basis 仅 system_constraint 或 explicit_default；
- clarifications: [{field,reason,options?}]；
- unsupportedCapabilities: string[]；
- prohibitedInferences: string[]；
- tags: string[]。

类别硬规则：
- complete 必须标记 structured，并同时包含 entry_condition 与 exit_condition；
- partial、short_colloquial、conflicting 必须标记 needs_clarification 并提出具体问题；
- unsupported 必须标记 unsupported 并写明能力缺口。

不得生成真实个人隐私、投资承诺或绕过安全约束的内容。不得重复本批或常见模板句。`;
}

const JUDGE_COMMON = `你是 M1 合成标注集的独立盲审模型。你看不到另一位评审的结果，也不得假设另一位评审会修正问题。
对每条候选分别给出 1-5 的整数评分：accuracy、evidenceGrounding、ambiguityHandling、capabilityCompliance、diversityNaturalness。
任何事实没有原文证据、把缺失语义当默认值、错误判定支持范围、澄清项不充分、条件逻辑自相矛盾或 evidenceQuote 不是原文片段，都必须写入 violations。
输出严格 JSON：{"results":[{"id":"...","scores":{...},"violations":[],"reason":"..."}]}。不得输出 pass 字段；通过状态由程序统一计算。`;

function judgeSystemPrompt(role: 'B' | 'C', capabilities: unknown): string {
  const focus = role === 'B'
    ? '你的重点是语义准确、条件逻辑、参数单位、原文证据与 Gold 标签完整性。'
    : '你的重点是歧义处理、能力边界、禁止幻觉、语言自然度、重复模板和潜在未来函数。';
  return `${JUDGE_COMMON}\n${focus}\n当前权威能力清单：\n${JSON.stringify(capabilities)}`;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSource(value: string): string {
  return value.trim().toLocaleLowerCase('zh-CN').replace(/[\s，。；、！？,.!?;]+/g, '');
}

async function generateBatch(
  ai: OpenAI,
  config: ModelConfig,
  capabilities: unknown,
  category: M1Category,
  count: number,
  forbiddenHashes: string[],
): Promise<{ samples: M1SyntheticCandidate[]; call: Omit<CallResult<unknown>, 'data'> }> {
  let validationFeedback = '';
  let lastIssues: unknown = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await requestJson<unknown>(
      ai,
      config,
      generatorSystemPrompt(capabilities),
      `生成 ${count} 条 category=${category} 的候选。必须全部属于该类别。避免与这些已存在文本哈希对应的表达重复：${forbiddenHashes.slice(-100).join(',')}。${validationFeedback}`,
      0.8,
    );
    const container = response.data !== null && typeof response.data === 'object'
      ? response.data as { samples?: unknown }
      : {};
    if (Array.isArray(container.samples)) {
      const itemResults = container.samples.map((sample) => m1SyntheticCandidateSchema.safeParse(sample));
      const matching: M1SyntheticCandidate[] = [];
      for (const result of itemResults) {
        if (result.success && result.data.category === category) matching.push(result.data);
      }
      if (matching.length > 0) {
        if (matching.length < count) {
          console.warn(`[M1] 模型 A 本批 ${container.samples.length} 条中仅 ${matching.length} 条通过候选 Schema，其余丢弃并后续补足`);
        }
        return {
          samples: matching.slice(0, count),
          call: { usage: response.usage, responseId: response.responseId },
        };
      }
      lastIssues = itemResults.flatMap((result) => result.success ? [] : result.error.issues);
    } else {
      lastIssues = [{ path: ['samples'], message: 'samples 必须是数组' }];
    }
    validationFeedback = `\n上一次没有任何候选通过输出 Schema。仅修正字段结构和枚举值，不改变候选业务语义。错误：${JSON.stringify(lastIssues)}`;
  }
  throw new Error(`模型 A 连续两次未通过候选语料 Schema (${category}): ${JSON.stringify(lastIssues)}`);
}

async function judgeBatch(
  ai: OpenAI,
  config: ModelConfig,
  capabilities: unknown,
  samples: Array<{ id: string; candidate: M1SyntheticCandidate }>,
): Promise<{ results: Map<string, M1JudgeResult>; call: Omit<CallResult<unknown>, 'data'> }> {
  let validationFeedback = '';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await requestJson<unknown>(
      ai,
      config,
      judgeSystemPrompt(config.role as 'B' | 'C', capabilities),
      `${JSON.stringify({ samples })}${validationFeedback}`,
      0,
    );
    const parsed = m1JudgeBatchSchema.safeParse(response.data);
    if (!parsed.success) {
      validationFeedback = `\n上一次响应未通过评审输出 Schema。仅修正格式，保留原评分判断。错误：${JSON.stringify(parsed.error.issues)}`;
      continue;
    }
    const expectedIds = new Set(samples.map((sample) => sample.id));
    const results = new Map<string, M1JudgeResult>();
    for (const result of parsed.data.results) {
      if (expectedIds.has(result.id)) results.set(result.id, result);
    }
    const missing = [...expectedIds].filter((id) => !results.has(id));
    if (missing.length === 0) {
      return { results, call: { usage: response.usage, responseId: response.responseId } };
    }
    validationFeedback = `\n上一次遗漏这些 id：${missing.join(',')}。必须逐条返回，且不得改变已经给出的评分。`;
  }
  throw new Error(`模型 ${config.role} 连续两次未返回完整且合法的评审结果`);
}

async function loadExistingAudit(file: string): Promise<AuditedSample[]> {
  try {
    return (await readFile(file, 'utf8'))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditedSample);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function markdownReport(
  runId: string,
  targets: Record<M1Category, number>,
  accepted: AuditedSample[],
  rejected: AuditedSample[],
  configs: ModelConfig[],
): string {
  const all = [...accepted, ...rejected];
  const percent = (value: number, total: number) => total === 0 ? '0.00%' : `${(value / total * 100).toFixed(2)}%`;
  const bPassed = all.filter((item) => item.judgeBPassed).length;
  const cPassed = all.filter((item) => item.judgeCPassed).length;
  const agreed = all.filter((item) => item.judgeBPassed === item.judgeCPassed).length;
  const dimensions = ['accuracy', 'evidenceGrounding', 'ambiguityHandling', 'capabilityCompliance', 'diversityNaturalness'] as const;
  const scoreRows = dimensions.map((dimension) => {
    const average = (role: 'judgeB' | 'judgeC') => all.length === 0
      ? 0
      : all.reduce((sum, item) => sum + item[role].scores[dimension], 0) / all.length;
    return `| ${dimension} | ${average('judgeB').toFixed(2)} | ${average('judgeC').toFixed(2)} |`;
  }).join('\n');
  const categoryRows = Object.entries(targets).map(([category, target]) => {
    const passed = accepted.filter((item) => item.candidate.category === category).length;
    const failed = rejected.filter((item) => item.candidate.category === category).length;
    return `| ${category} | ${target} | ${passed} | ${failed} |`;
  }).join('\n');
  const shared = new Set(configs.map((item) => `${item.baseURL}|${item.model}`)).size < 3;
  return `# M1 A/B/C 合成标注集报告\n\n- Run ID: \`${runId}\`\n- Prompt: \`${PROMPT_VERSION}\`\n- 通过规则：模型 B 与 C 各维度均不低于 4 且无 violations，二者同时通过\n- 标注性质：**合成双评审标注集，不等同于人工标注集**\n- 模型独立性：${shared ? '**共享模型或供应商，仅实现调用与上下文隔离**' : '三个独立模型配置'}\n- A: \`${configs[0].model}\`\n- B: \`${configs[1].model}\`\n- C: \`${configs[2].model}\`\n\n| 类别 | 目标通过数 | 实际通过数 | 淘汰数 |\n| --- | ---: | ---: | ---: |\n${categoryRows}\n\n总候选：${all.length}；总通过：${accepted.length}；总淘汰：${rejected.length}。\n\n## 双评审质量统计\n\n| 指标 | 数值 |\n| --- | ---: |\n| B 通过率 | ${percent(bPassed, all.length)} |\n| C 通过率 | ${percent(cPassed, all.length)} |\n| B/C 双通过率 | ${percent(accepted.length, all.length)} |\n| B/C 二元结论一致率 | ${percent(agreed, all.length)} |\n\n| 评分维度 | B 均分 | C 均分 |\n| --- | ---: | ---: |\n${scoreRows}\n\n> 以上统计衡量合成候选的双模型共识质量，不是被测 M1 解析器的字段级 Precision/Recall。\n`;
}

function qualityStatistics(all: AuditedSample[]) {
  const dimensions = ['accuracy', 'evidenceGrounding', 'ambiguityHandling', 'capabilityCompliance', 'diversityNaturalness'] as const;
  const averageScores = (role: 'judgeB' | 'judgeC') => Object.fromEntries(dimensions.map((dimension) => [
    dimension,
    all.length === 0 ? 0 : all.reduce((sum, item) => sum + item[role].scores[dimension], 0) / all.length,
  ]));
  const violations = new Map<string, number>();
  for (const item of all) {
    for (const violation of [...item.judgeB.violations, ...item.judgeC.violations]) {
      violations.set(violation, (violations.get(violation) ?? 0) + 1);
    }
  }
  return {
    totalCandidates: all.length,
    judgeBPassed: all.filter((item) => item.judgeBPassed).length,
    judgeCPassed: all.filter((item) => item.judgeCPassed).length,
    dualPassed: all.filter((item) => item.status === 'accepted').length,
    binaryAgreement: all.filter((item) => item.judgeBPassed === item.judgeCPassed).length,
    judgeBAverageScores: averageScores('judgeB'),
    judgeCAverageScores: averageScores('judgeC'),
    violations: [...violations.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
  };
}

async function main(): Promise<void> {
  const cli = options();
  const configs = [modelConfig('A'), modelConfig('B'), modelConfig('C')];
  const [configA, configB, configC] = configs;
  const [clientA, clientB, clientC] = configs.map(client);
  const capabilities = buildStrategyCapabilityRegistry();
  const targets = allocateCategoryTargets(cli.target);
  const runDir = path.join(cli.outputRoot, cli.runId);
  const auditFile = path.join(runDir, 'audit.jsonl');
  await mkdir(runDir, { recursive: true });

  const existing = await loadExistingAudit(auditFile);
  const accepted = existing.filter((item) => item.status === 'accepted');
  const rejected = existing.filter((item) => item.status === 'rejected');
  const sourceHashes = new Set(existing.map((item) => hashText(normalizeSource(item.candidate.sourceText))));
  let serial = existing.length;

  await writeFile(path.join(runDir, 'manifest.json'), `${JSON.stringify({
    runId: cli.runId,
    target: cli.target,
    targets,
    promptVersion: PROMPT_VERSION,
    capabilityVersion: capabilities.capabilityVersion,
    models: Object.fromEntries(configs.map((item) => [item.role, { model: item.model, baseURL: item.baseURL }])),
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');

  for (const category of Object.keys(targets) as M1Category[]) {
    let rounds = 0;
    while (accepted.filter((item) => item.candidate.category === category).length < targets[category]) {
      rounds += 1;
      if (rounds > cli.maxRoundsPerCategory) {
        throw new Error(`${category} 在 ${cli.maxRoundsPerCategory} 轮后仍未达到目标，通过 ${accepted.filter((item) => item.candidate.category === category).length}/${targets[category]}`);
      }
      const deficit = targets[category] - accepted.filter((item) => item.candidate.category === category).length;
      const count = Math.min(cli.batchSize, deficit);
      console.log(`[M1] ${category}: 生成 ${count} 条，当前 ${targets[category] - deficit}/${targets[category]}`);
      const generated = await generateBatch(
        clientA,
        configA,
        capabilities,
        category,
        count,
        [...sourceHashes],
      );
      const unique = generated.samples.filter((candidate) => {
        const digest = hashText(normalizeSource(candidate.sourceText));
        if (sourceHashes.has(digest)) return false;
        sourceHashes.add(digest);
        return true;
      });
      if (unique.length === 0) continue;
      const identified = unique.map((candidate) => ({
        id: `m1-${String(++serial).padStart(4, '0')}-${randomUUID().slice(0, 8)}`,
        candidate,
      }));
      const [judgedB, judgedC] = await Promise.all([
        judgeBatch(clientB, configB, capabilities, identified),
        judgeBatch(clientC, configC, capabilities, identified),
      ]);
      for (const item of identified) {
        const judgeB = judgedB.results.get(item.id)!;
        const judgeC = judgedC.results.get(item.id)!;
        const audited: AuditedSample = {
          id: item.id,
          candidate: item.candidate,
          judgeB,
          judgeC,
          judgeBPassed: judgePassed(judgeB),
          judgeCPassed: judgePassed(judgeC),
          status: acceptanceStatus(judgeB, judgeC),
          promptVersion: PROMPT_VERSION,
          capabilityVersion: capabilities.capabilityVersion,
          models: { generator: configA.model, judgeB: configB.model, judgeC: configC.model },
          createdAt: new Date().toISOString(),
        };
        await appendFile(auditFile, `${JSON.stringify(audited)}\n`, 'utf8');
        (audited.status === 'accepted' ? accepted : rejected).push(audited);
      }
    }
  }

  const finalAccepted = accepted.slice(0, cli.target);
  await writeFile(path.join(runDir, 'accepted.jsonl'), finalAccepted.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
  await writeFile(path.join(runDir, 'rejected.jsonl'), rejected.map((item) => JSON.stringify(item)).join('\n') + (rejected.length ? '\n' : ''), 'utf8');
  await writeFile(path.join(runDir, 'report.md'), markdownReport(cli.runId, targets, finalAccepted, rejected, configs), 'utf8');
  await writeFile(path.join(runDir, 'report.json'), `${JSON.stringify({
    runId: cli.runId,
    target: cli.target,
    accepted: finalAccepted.length,
    rejected: rejected.length,
    targets,
    acceptedByCategory: Object.fromEntries((Object.keys(targets) as M1Category[]).map((category) => [
      category,
      finalAccepted.filter((item) => item.candidate.category === category).length,
    ])),
    quality: qualityStatistics([...finalAccepted, ...rejected]),
  }, null, 2)}\n`, 'utf8');
  console.log(`[M1] 完成：通过 ${finalAccepted.length}，淘汰 ${rejected.length}，目录 ${runDir}`);
}

main().catch((error) => {
  console.error('[M1] 失败:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
