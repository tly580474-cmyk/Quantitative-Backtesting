import { sanitizeToolDetail } from './eventProtocol.js';

/** Extract only explicit tool payloads, matched by native call ID. */
export function recoverCodexToolDetails(lines: string[], sessionId: string) {
  const records = lines.filter(line => line.trim()).map(line => JSON.parse(line));
  if (!records.some(row => row.type === 'session_meta' && row.payload?.id === sessionId)) {
    throw new Error('会话日志与目标 sessionId 不一致');
  }
  const calls = new Map<string, { toolInput?: string; toolResult?: string }>();
  for (const row of records) {
    const item = row.payload;
    if (row.type !== 'response_item' || typeof item?.call_id !== 'string') continue;
    if (!['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) continue;
    const call = calls.get(item.call_id) ?? {};
    if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      let input = item.arguments ?? item.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { /* plain tool input */ } }
      call.toolInput = sanitizeToolDetail(input);
    } else call.toolResult = sanitizeToolDetail(item.output);
    calls.set(item.call_id, call);
  }
  return calls;
}
