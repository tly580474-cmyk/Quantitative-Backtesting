import {
  sanitizePublicContent,
  sanitizeToolName,
  type PublicAgentEvent,
} from './eventProtocol.js';

export type ParsedEvent = PublicAgentEvent;

interface StreamBlock {
  type?: string;
  id?: string;
  tool_use_id?: string;
  name?: string;
  text?: string;
  content?: unknown;
  is_error?: boolean;
}

function now(): string {
  return new Date().toISOString();
}

interface ConfirmationOption { label: string; value: string; description?: string; }
interface ConfirmationQuestion { id: string; question: string; options: ConfirmationOption[]; allowCustom: boolean; }

function cleanConfirmation(value: unknown): { questions: ConfirmationQuestion[] } | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { questions?: unknown }).questions)) return null;
  const questions = (value as { questions: unknown[] }).questions.slice(0, 4).flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const question = sanitizePublicContent(item.question, '').slice(0, 500);
    if (!question) return [];
    const options = Array.isArray(item.options) ? item.options.slice(0, 5).flatMap(option => {
      if (!option || typeof option !== 'object') return [];
      const candidate = option as Record<string, unknown>;
      const label = sanitizePublicContent(candidate.label, '').slice(0, 120);
      const optionValue = sanitizePublicContent(candidate.value, '').slice(0, 500);
      if (!label || !optionValue) return [];
      const description = sanitizePublicContent(candidate.description, '').slice(0, 300);
      return [{ label, value: optionValue, ...(description ? { description } : {}) }];
    }) : [];
    return [{
      id: sanitizePublicContent(item.id, `q${index + 1}`).replace(/[^\w-]/g, '').slice(0, 64) || `q${index + 1}`,
      question,
      options,
      allowCustom: item.allowCustom === true || options.length === 0,
    }];
  });
  return questions.length ? { questions } : null;
}

function extractConfirmation(content: string): { answer: string; confirmation: string | null } {
  const match = content.match(/```agent-confirmation\s*([\s\S]*?)```/i);
  if (!match) return { answer: content, confirmation: null };
  try {
    const cleaned = cleanConfirmation(JSON.parse(match[1]));
    if (!cleaned) return { answer: content.replace(match[0], '').trim(), confirmation: null };
    return { answer: content.replace(match[0], '').trim(), confirmation: JSON.stringify(cleaned) };
  } catch {
    return { answer: content.replace(match[0], '').trim(), confirmation: null };
  }
}

/** Extract the resumable provider session id without publishing a display event. */
export function extractSessionId(line: string): string | null {
  try {
    const obj = JSON.parse(line.trim());
    return (obj?.type === 'system' || obj?.type === 'result') && typeof obj.session_id === 'string'
      ? obj.session_id
      : null;
  } catch {
    return null;
  }
}

function parseBlocks(blocks: StreamBlock[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  for (const block of blocks) {
    // Preserve visible activity without exposing or persisting chain-of-thought.
    if (block.type === 'thinking') {
      events.push({ type: 'progress', publicContent: '正在深入分析任务细节', timestamp: now() });
      continue;
    }

    if (block.type === 'text') {
      const publicContent = sanitizePublicContent(block.text);
      if (publicContent) events.push({ type: 'progress', publicContent, timestamp: now() });
      continue;
    }

    if (block.type === 'tool_use') {
      const toolName = sanitizeToolName(block.name) ?? 'tool';
      events.push({
        type: 'tool_started',
        publicContent: `正在使用 ${toolName}`,
        timestamp: now(),
        toolName,
        toolUseId: typeof block.id === 'string' ? block.id.slice(0, 128) : undefined,
      });
      continue;
    }

    if (block.type === 'tool_result') {
      events.push({
        type: block.is_error ? 'error' : 'tool_finished',
        publicContent: block.is_error ? '工具执行失败' : '工具执行完成',
        timestamp: now(),
        toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id.slice(0, 128) : undefined,
      });
    }
  }
  return events;
}

/** Parse one provider JSONL record into zero or more public v2 events. */
export function parseStreamLine(line: string): ParsedEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let obj: Record<string, any>;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
    return parseBlocks(obj.message.content);
  }

  // With --include-partial-messages Claude emits provider stream events before
  // the complete assistant record. Publish only safe lifecycle markers; never
  // forward thinking deltas or partial tool input.
  if (obj.type === 'stream_event') {
    const event = obj.event as Record<string, any> | undefined;
    if (event?.type === 'content_block_start') {
      const block = event.content_block as StreamBlock | undefined;
      if (block?.type === 'thinking') {
        return [{ type: 'progress', publicContent: '正在深入分析任务细节', timestamp: now() }];
      }
      if (block?.type === 'tool_use') return parseBlocks([block]);
      if (block?.type === 'text') {
        return [{ type: 'progress', publicContent: '正在组织回答', timestamp: now() }];
      }
    }
    return [];
  }

  // Claude stream-json emits tool results as a user message with nested content.
  if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
    return parseBlocks(obj.message.content);
  }

  // Keep compatibility with older top-level tool_result records.
  if (obj.type === 'tool_result') {
    return parseBlocks([{ ...obj, type: 'tool_result' }]);
  }

  if (obj.type === 'result') {
    const subtype = typeof obj.subtype === 'string' ? obj.subtype : '';
    if (subtype.startsWith('error') || obj.is_error === true) {
      return [{
        type: 'error',
        publicContent: sanitizePublicContent(obj.error ?? obj.result, '智能体执行失败'),
        timestamp: now(),
      }];
    }
    const rawResult = typeof obj.result === 'string' ? obj.result : '';
    const extracted = extractConfirmation(rawResult);
    const publicContent = sanitizePublicContent(
      extracted.answer,
      extracted.confirmation ? '需要你确认以下事项后继续。' : '',
    );
    return [
      ...(publicContent ? [{ type: 'assistant_final' as const, publicContent, timestamp: now() }] : []),
      ...(extracted.confirmation ? [{
        type: 'confirmation_required' as const,
        publicContent: extracted.confirmation,
        timestamp: now(),
      }] : []),
    ];
  }

  return [];
}

export function extractReportInfo(html: string): { title: string; summary: string } {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = sanitizePublicContent(titleMatch?.[1], '未命名报告').slice(0, 255);
  const summaryMatch = html.match(/<!--\s*REPORT_SUMMARY:\s*(.+?)\s*-->/i);
  const summary = sanitizePublicContent(summaryMatch?.[1]);
  return { title, summary };
}
