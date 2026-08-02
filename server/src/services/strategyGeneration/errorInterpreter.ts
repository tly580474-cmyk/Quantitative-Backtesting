import { z } from 'zod';
import OpenAI from 'openai';
import {
  EXPERIMENT_ERROR_CATEGORY_META,
  type ExperimentErrorCategory,
} from '../../experiments/errorClassification.js';

// N4.2：中文解释 Agent（设计文档 9.2）。
// 基于结构化错误（错误码 + 字段路径 + 校验问题）+ 能力清单，
// 输出通俗中文解释与"可点选修正建议"。只解释、只给提示文本，
// 绝不返回修改后的策略 JSON 或补丁（ADR-11）。

export interface ErrorInterpretationSuggestion {
  id: string;
  label: string;
  /** 点选后预填到用户 prompt 的修正文本 */
  promptPatch: string;
  /** 适用的字段路径或错误码 */
  appliesTo: string;
}

export interface ErrorInterpretation {
  category: ExperimentErrorCategory;
  explanation: string;
  suggestions: ErrorInterpretationSuggestion[];
  /** 是否为确定性兜底（LLM 不可用时） */
  fallback: boolean;
}

export interface ErrorInterpreterRequest {
  category: ExperimentErrorCategory;
  issues: string[];
  fieldPaths: string[];
  prompt?: string;
  capabilitySummary?: string;
}

const suggestionSchema = z.object({
  label: z.string().min(1).max(200),
  promptPatch: z.string().min(1).max(1000),
  appliesTo: z.string().min(1).max(200),
});

const interpretationSchema = z.object({
  explanation: z.string().min(1).max(2000),
  suggestions: z.array(suggestionSchema).min(1).max(5),
});

export interface ErrorInterpreterProvider {
  interpret(request: ErrorInterpreterRequest): Promise<ErrorInterpretation>;
}

const SYSTEM_PROMPT = [
  '你是量化实验的智能报错解释助手。',
  '输入是结构化错误（错误类别、字段路径、校验问题）与研究能力清单。',
  '输出 JSON：{"explanation":"中文解释（说明发生在哪个字段、为什么不能执行）",',
  '"suggestions":[{"label":"修正建议标题","promptPatch":"可直接粘贴进用户提示词的一段中文修正文本",',
  '"appliesTo":"对应字段路径或错误码"}]}。',
  '硬性约束：',
  '- 只解释与给出提示文本，绝不返回或修改任何策略 JSON、DSL 或代码补丁；',
  '- 不得建议放宽数据、成本、风险和验证门槛；',
  '- VALIDATION_FAILED 应说明这是研究结论，不是程序故障，不可重试；',
  '- 不得读取或建议针对锁定测试区间调参。',
].join('\n');

export class OpenAIErrorInterpreterProvider implements ErrorInterpreterProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, baseURL: string, model: string, timeoutMs = 60_000) {
    this.client = new OpenAI({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 1 });
    this.model = model;
  }

  async interpret(request: ErrorInterpreterRequest): Promise<ErrorInterpretation> {
    const meta = EXPERIMENT_ERROR_CATEGORY_META[request.category];
    const userPrompt = [
      `错误类别：${request.category}（${meta.label}）`,
      `产生组件：${meta.producedBy}`,
      request.issues.length > 0 ? `校验问题：\n${request.issues.join('\n')}` : '',
      request.fieldPaths.length > 0 ? `涉及字段：${request.fieldPaths.join('、')}` : '',
      request.prompt ? `原始描述：${request.prompt}` : '',
      request.capabilitySummary ? `能力清单：${request.capabilitySummary}` : '',
    ].filter(Boolean).join('\n');
    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 2048,
    });
    const text = response.choices[0]?.message?.content;
    if (!text) throw new Error('解释模型返回了空响应');
    const parsed = interpretationSchema.parse(JSON.parse(text));
    return {
      category: request.category,
      explanation: parsed.explanation,
      suggestions: parsed.suggestions.map((item, index) => ({
        id: `suggestion-${index + 1}`,
        label: item.label,
        promptPatch: item.promptPatch,
        appliesTo: item.appliesTo,
      })),
      fallback: false,
    };
  }
}

/** 确定性兜底：不依赖 LLM，基于错误类别元数据生成中文解释与标准建议。 */
export function fallbackInterpretation(request: ErrorInterpreterRequest): ErrorInterpretation {
  const meta = EXPERIMENT_ERROR_CATEGORY_META[request.category];
  const fieldText = request.fieldPaths.length > 0 ? `涉及字段：${request.fieldPaths.join('、')}。` : '';
  const issueText = request.issues.length > 0 ? request.issues[0] : '';
  const suggestions: ErrorInterpretationSuggestion[] = [];
  if (request.category === 'SCHEMA_INVALID') {
    suggestions.push({
      id: 'suggestion-1',
      label: '修正字段后重新生成',
      promptPatch: `请修正以下字段后再生成策略：${request.fieldPaths.join('、') || '参数/条件格式'}。${request.prompt ?? ''}`,
      appliesTo: request.fieldPaths[0] ?? 'root',
    });
  } else if (request.category === 'UNSUPPORTED_CAPABILITY') {
    suggestions.push({
      id: 'suggestion-1',
      label: '缩小到能力清单内',
      promptPatch: `请只使用当前能力清单内支持的因子/指标/策略，并缩小请求范围。${request.prompt ?? ''}`,
      appliesTo: request.category,
    });
  } else if (request.category === 'VALIDATION_FAILED') {
    suggestions.push({
      id: 'suggestion-1',
      label: '查看研究结论',
      promptPatch: '请查看校验报告中的研究结论，这是实验结论而非程序故障，请调整假设后新建实验。',
      appliesTo: request.category,
    });
  } else {
    suggestions.push({
      id: 'suggestion-1',
      label: meta.userAction,
      promptPatch: `${meta.userAction}：${request.prompt ?? ''}`,
      appliesTo: request.category,
    });
  }
  return {
    category: request.category,
    explanation: `${meta.label}：${meta.producedBy} 检测到错误。${fieldText}${issueText ? `（${issueText}）` : ''}${meta.userAction}。`,
    suggestions,
    fallback: true,
  };
}

/** 解释编排：LLM 失败或输出非法时回退确定性模板。 */
export async function interpretError(input: {
  request: ErrorInterpreterRequest;
  provider: ErrorInterpreterProvider;
}): Promise<ErrorInterpretation> {
  try {
    return await input.provider.interpret(input.request);
  } catch {
    return fallbackInterpretation(input.request);
  }
}
