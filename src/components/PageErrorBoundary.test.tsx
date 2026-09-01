import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PageErrorBoundary, { isDynamicImportError } from './PageErrorBoundary';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PageErrorBoundary', () => {
  it('identifies failed lazy route imports', () => {
    expect(isDynamicImportError(new TypeError('Failed to fetch dynamically imported module'))).toBe(true);
    expect(isDynamicImportError(new Error('ordinary render failure'))).toBe(false);
  });

  it('shows a recoverable state instead of leaving the workspace blank', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BrokenPage = () => {
      throw new Error('render failed');
    };

    render(
      <PageErrorBoundary resetKey="/broken" onBackHome={vi.fn()}>
        <BrokenPage />
      </PageErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('页面暂时无法显示')).toBeTruthy();
    expect(screen.getByRole('button', { name: /重试当前页面/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /返回市场数据/ })).toBeTruthy();
  });

  it('clears a page error when navigation changes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const BrokenPage = () => {
      throw new Error('render failed');
    };
    const onBackHome = vi.fn();
    const view = render(
      <PageErrorBoundary resetKey="/broken" onBackHome={onBackHome}>
        <BrokenPage />
      </PageErrorBoundary>,
    );

    fireEvent.click(screen.getByRole('button', { name: /返回市场数据/ }));
    expect(onBackHome).toHaveBeenCalledOnce();

    view.rerender(
      <PageErrorBoundary resetKey="/market-data" onBackHome={onBackHome}>
        <div>市场数据已恢复</div>
      </PageErrorBoundary>,
    );
    expect(screen.getByText('市场数据已恢复')).toBeTruthy();
  });
});
