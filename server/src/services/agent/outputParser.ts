export interface ParsedEvent {
  type: 'thought' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'done';
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

export function parseStreamLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const obj = JSON.parse(trimmed);

    // Claude Code stream-json format
    if (obj.type === 'assistant') {
      const content = obj.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'thinking') {
            return { type: 'thought', content: block.thinking || '' };
          }
          if (block.type === 'text') {
            return { type: 'text', content: block.text || '' };
          }
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              content: `调用工具: ${block.name}`,
              toolName: block.name,
              toolInput: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2),
            };
          }
        }
      }
    }

    if (obj.type === 'result') {
      if (obj.subtype === 'error') {
        return { type: 'error', content: obj.error || 'Unknown error' };
      }
      // Final result text
      if (obj.result) {
        return { type: 'text', content: obj.result };
      }
    }

    if (obj.type === 'tool_result') {
      return {
        type: 'tool_result',
        content: '工具执行完成',
        toolResult: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content, null, 2),
      };
    }

    // Fallback: try to extract useful text
    if (obj.type === 'system') {
      return null; // skip system messages
    }

    // Unknown format - try to extract text
    return null;
  } catch {
    // Not JSON, treat as plain text
    return null;
  }
}

export function extractReportInfo(html: string): { title: string; summary: string } {
  // Extract <title> tag
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '未命名报告';

  // Extract REPORT_SUMMARY comment
  const summaryMatch = html.match(/<!--\s*REPORT_SUMMARY:\s*(.+?)\s*-->/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : '';

  return { title, summary };
}
