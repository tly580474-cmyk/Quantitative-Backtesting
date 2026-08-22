import { describe, expect, it } from 'vitest';
import { REPORT_SUBAGENTS, serializeReportSubagents } from './reportSubagent.js';

describe('report-designer subagent', () => {
  it('keeps the detailed report template isolated in a dedicated Claude Code agent', () => {
    const definition = REPORT_SUBAGENTS['report-designer'];
    expect(definition.description).toContain('Markdown');
    expect(definition.prompt).toContain('不得补充行情');
    expect(definition.prompt).toContain('只输出最终 Markdown 报告');
    expect(JSON.parse(serializeReportSubagents())).toEqual(REPORT_SUBAGENTS);
  });
});
