import { describe, expect, it } from 'vitest';
import { buildPrompt } from './promptBuilder.js';

describe('agent prompt report policy', () => {
  it('delegates report creation to the agent instead of a frontend switch', () => {
    const prompt = buildPrompt('你好', '/workspace', 'classic-blue');
    expect(prompt).toContain('报告由你按本轮任务自动判断');
    expect(prompt).toContain('简单问答、解释、确认');
    expect(prompt).toContain('用户明确要求生成、输出、整理或交付报告');
    expect(prompt).toContain('```agent-report');
    expect(prompt).not.toContain('本轮需要生成报告');
    expect(prompt).not.toContain('本轮是普通对话，不要创建');
  });

  it('treats template style as presentation preference rather than permission', () => {
    const prompt = buildPrompt('分析策略', '/workspace', 'dark-pro', true);
    expect(prompt).toContain('风格只影响确实需要报告时的呈现，不影响是否生成');
    expect(prompt).toContain('深色专业界面');
    expect(prompt).toContain('同一对话的后续消息');
  });
});
