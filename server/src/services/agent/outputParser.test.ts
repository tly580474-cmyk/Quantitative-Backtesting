import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractReportDecision, extractReportDirective, parseStreamLine } from './outputParser.js';
import { sanitizePublicContent } from './eventProtocol.js';

describe('agent public event protocol', () => {
  it('replaces private thinking with a safe activity marker and emits every public block', () => {
    const events = parseStreamLine(JSON.stringify({
      type: 'assistant',
      message: { content: [
        { type: 'thinking', thinking: 'private reasoning and server/.env' },
        { type: 'text', text: '正在检查数据' },
        { type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'server/.env' } },
      ] },
    }));
    expect(events.map(event => event.type)).toEqual(['progress', 'progress', 'tool_started']);
    expect(events[0].publicContent).toBe('正在深入分析任务细节');
    expect(JSON.stringify(events)).not.toContain('private reasoning');
    expect(JSON.stringify(events)).not.toContain('server/.env');
  });

  it('parses nested tool results and preserves the pairing id without raw output', () => {
    const events = parseStreamLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'SECRET_OUTPUT' }] },
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_finished', toolUseId: 'call-1' });
    expect(JSON.stringify(events)).not.toContain('SECRET_OUTPUT');
  });

  it('turns partial thinking and tool starts into safe realtime markers', () => {
    const thinking = parseStreamLine(JSON.stringify({
      type: 'stream_event', event: { type: 'content_block_start', index: 0,
        content_block: { type: 'thinking', thinking: '' } },
    }));
    const tool = parseStreamLine(JSON.stringify({
      type: 'stream_event', event: { type: 'content_block_start', index: 1,
        content_block: { type: 'tool_use', id: 'live-tool', name: 'Bash', input: {} } },
    }));
    const delta = parseStreamLine(JSON.stringify({
      type: 'stream_event', event: { type: 'content_block_delta', index: 0,
        delta: { type: 'thinking_delta', thinking: 'private chain of thought' } },
    }));
    expect(thinking[0]).toMatchObject({ type: 'progress', publicContent: '正在深入分析任务细节' });
    expect(tool[0]).toMatchObject({ type: 'tool_started', toolUseId: 'live-tool', toolName: 'Bash' });
    expect(delta).toEqual([]);
  });

  it('classifies every provider error subtype as an error', () => {
    expect(parseStreamLine(JSON.stringify({
      type: 'result', subtype: 'error_max_turns', result: 'turn limit reached', is_error: true,
    }))[0]).toMatchObject({ type: 'error', publicContent: 'turn limit reached' });
  });

  it('extracts a bounded confirmation request without leaking its marker', () => {
    const events = parseStreamLine(JSON.stringify({
      type: 'result', subtype: 'success', result: `请确认实施口径。\n\n\`\`\`agent-confirmation
{"questions":[{"id":"scope","question":"选择实施范围","options":[{"label":"仅当前策略","value":"只修改当前策略"}],"allowCustom":true}]}
\`\`\``,
    }));
    expect(events.map(event => event.type)).toEqual(['assistant_final', 'confirmation_required']);
    expect(events[0].publicContent).toBe('请确认实施口径。');
    expect(JSON.parse(events[1].publicContent).questions[0]).toMatchObject({ id: 'scope', question: '选择实施范围' });
    expect(JSON.stringify(events)).not.toContain('agent-confirmation');
  });

  it('extracts an automatic report decision and keeps its control marker private', () => {
    const line = JSON.stringify({
      type: 'result', subtype: 'success', result: `已完成多因子回测，结论如下。

\`\`\`agent-report
{"generate":true,"reason":"包含完整回测方法与结果，需要留档"}
\`\`\``,
    });
    expect(extractReportDecision(line)).toEqual({
      generate: true, reason: '包含完整回测方法与结果，需要留档',
    });
    const events = parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'assistant_final', publicContent: '已完成多因子回测，结论如下。' });
    expect(JSON.stringify(events)).not.toContain('agent-report');
  });

  it('defaults to no report when the model omits or malforms its decision', () => {
    expect(extractReportDecision(JSON.stringify({ type: 'result', result: '普通回答' }))).toBeNull();
    expect(extractReportDecision(JSON.stringify({
      type: 'result', result: '普通回答\n```agent-report\n{"generate":"yes"}\n```',
    }))).toBeNull();
  });

  it('parses a provider-neutral final response for Codex', () => {
    expect(extractReportDirective(`Codex 正文\n\n\`\`\`agent-report\n{"generate":false,"reason":"普通问答"}\n\`\`\``))
      .toEqual({ answer: 'Codex 正文', decision: { generate: false, reason: '普通问答' } });
  });

  it('removes report and confirmation control blocks from intermediate text', () => {
    const events = parseStreamLine(JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: `正文
\`\`\`agent-confirmation
{"questions":[]}
\`\`\`
\`\`\`agent-report
{"generate":false,"reason":"简单问答"}
\`\`\`` }] },
    }));
    expect(events).toHaveLength(1);
    expect(events[0].publicContent).toBe('正文');
  });

  it('redacts common secrets and host paths', () => {
    const value = sanitizePublicContent('token=abc123456 C:\\Users\\alice\\secret.txt sk-abcdefghijklmnop mysql://root:pass@localhost/db');
    expect(value).not.toContain('abc123456');
    expect(value).not.toContain('alice');
    expect(value).not.toContain('abcdefghijklmnop');
    expect(value).not.toContain('root:pass');
  });

  it('keeps the supported stream-json sample contract stable', () => {
    const fixtureRoot = process.cwd().endsWith('server') ? process.cwd() : resolve(process.cwd(), 'server');
    const fixture = readFileSync(resolve(fixtureRoot, 'src/services/agent/__fixtures__/claude-stream-json.sample.jsonl'), 'utf8');
    const events = fixture.trim().split('\n').flatMap(parseStreamLine);
    expect(events.map(event => event.type)).toEqual(['progress', 'progress', 'tool_started', 'tool_finished', 'assistant_final']);
    expect(JSON.stringify(events)).not.toContain('never public');
    expect(JSON.stringify(events)).not.toContain('raw result is not public');
  });
});
