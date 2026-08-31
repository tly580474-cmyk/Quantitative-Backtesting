import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';
import AgentWorkspaceNav from './AgentWorkspaceNav';

afterEach(cleanup);

it('keeps report and run history in the agent context and allows direct navigation', () => {
  render(<MemoryRouter initialEntries={['/agent-reports']}><AgentWorkspaceNav /></MemoryRouter>);
  expect(screen.getByRole('button', { name: '研究报告' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: '运行记录' }));
  expect(screen.getByRole('button', { name: '运行记录' }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByRole('button', { name: '研究报告' }).getAttribute('aria-current')).toBeNull();
});
