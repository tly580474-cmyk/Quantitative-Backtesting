// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentEventList } from './AgentEventList';

describe('AgentEventList', () => {
  it('collapses public progress while keeping the final answer visible', () => {
    render(<AgentEventList runId="run-1" userPrompt="" events={[
      { type: 'user', content: '分析样本' },
      { type: 'progress', content: '正在检查数据', timestamp: '2026-08-10T00:00:00.000Z' },
      { type: 'tool_started', content: '正在使用 Read', toolName: 'Read', timestamp: '2026-08-10T00:00:01.000Z' },
      { type: 'assistant_final', content: '这是最终结论', timestamp: '2026-08-10T00:00:02.000Z' },
    ]} />);
    expect(screen.getByText('这是最终结论')).toBeVisible();
    expect(screen.queryByText('正在检查数据')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /已处理 2秒 · 2步/ }));
    expect(screen.getByText('正在检查数据')).toBeVisible();
  });

  it('shows failure outside the process fold', () => {
    render(<AgentEventList runId="run-2" userPrompt="" events={[
      { type: 'progress', content: '处理中' },
      { type: 'terminal', content: '运行超时', terminal: { status: 'failed', exitCode: null, errorCode: 'TIMEOUT' } },
    ]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('运行超时（TIMEOUT）');
  });

  it('hides recoverable tool failures while preserving run-level failures', () => {
    render(<AgentEventList runId="run-tool-error" userPrompt="" events={[
      { type: 'error', content: '工具执行失败', toolUseId: 'tool-1' },
      { type: 'error', content: '智能体进程异常' },
    ]} />);
    expect(screen.queryByText('工具执行失败')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('智能体进程异常');
  });

  it('renders a confirmation card and submits the selected decision', () => {
    const onConfirm = vi.fn();
    render(<AgentEventList runId="run-confirm" userPrompt="" onConfirm={onConfirm} events={[
      { type: 'assistant_final', content: '请选择实施范围。', runId: 'run-confirm', seq: 1 },
      { type: 'confirmation_required', runId: 'run-confirm', seq: 2, content: JSON.stringify({ questions: [{
        id: 'scope', question: '实施范围', allowCustom: true,
        options: [{ label: '仅当前策略', value: '只修改当前策略', description: '范围最小' }],
      }] }) },
      { type: 'terminal', content: '', runId: 'run-confirm', seq: 3,
        terminal: { status: 'completed', exitCode: 0 } },
    ]} />);
    fireEvent.click(screen.getByRole('radio', { name: /仅当前策略/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.stringContaining('答复：只修改当前策略'));
  });

  it('shows immediate processing feedback before the first server event', () => {
    render(<AgentEventList runId="run-3" userPrompt="" isStreaming events={[
      { type: 'user', content: '执行一个长任务', timestamp: new Date().toISOString() },
    ]} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在分析任务');
  });

  it('shows a live analysis footer while running and removes it after completion', () => {
    const events = [
      { type: 'user' as const, content: '长任务', timestamp: '2026-08-10T00:00:00.000Z' },
      { type: 'progress' as const, content: '正在深入分析任务细节', timestamp: '2026-08-10T00:00:01.000Z' },
    ];
    const view = render(<AgentEventList runId="run-live" userPrompt="" isStreaming events={events} />);
    expect(screen.getByRole('status')).toHaveTextContent('分析仍在继续');
    view.rerender(<AgentEventList runId="run-live" userPrompt="" isStreaming={false} events={events} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByText('正在深入分析任务细节')).not.toBeInTheDocument();
  });
});
