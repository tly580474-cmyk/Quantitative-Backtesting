import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AnalysisPlaceholder from './AnalysisPlaceholder';

afterEach(cleanup);

describe('AnalysisPlaceholder', () => {
  it('offers explicit read-only navigation when no data is open', () => {
    const onOpenData = vi.fn();
    const onOpenMarket = vi.fn();
    render(<AnalysisPlaceholder loading={false} minuteMode={false} hasSource={false}
      onOpenData={onOpenData} onOpenMarket={onOpenMarket} />);
    fireEvent.click(screen.getByRole('button', { name: /打开数据管理/ }));
    fireEvent.click(screen.getByRole('button', { name: /浏览市场行情/ }));
    expect(onOpenData).toHaveBeenCalledOnce();
    expect(onOpenMarket).toHaveBeenCalledOnce();
  });

  it('distinguishes loading from an empty dataset', () => {
    render(<AnalysisPlaceholder loading minuteMode hasSource onOpenData={vi.fn()} onOpenMarket={vi.fn()} />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText('当前范围暂无分钟行情')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps existing source data distinct from an empty minute range', () => {
    render(<AnalysisPlaceholder loading={false} minuteMode hasSource onOpenData={vi.fn()} onOpenMarket={vi.fn()} />);
    expect(screen.getByText('当前范围暂无分钟行情')).toBeTruthy();
    expect(screen.getByText(/切回日 K/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps a failed read distinct and offers a retry', () => {
    const onRetry = vi.fn();
    render(<AnalysisPlaceholder loading={false} minuteMode hasSource error="目录读取失败"
      onRetry={onRetry} onOpenData={vi.fn()} onOpenMarket={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByText('当前范围暂无分钟行情')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重新加载分钟行情' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
