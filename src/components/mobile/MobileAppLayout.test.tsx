import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import MobileAppLayout from './MobileAppLayout';

function Fixture() {
  const location = useLocation();
  const navigate = useNavigate();
  const detail = location.pathname.startsWith('/market-detail/');
  return <MobileAppLayout activeKey={location.pathname} activeTitle={detail ? '行情详情' : '测试工作区'}
    navigationItems={[{ key: '/paper-trading', label: '模拟交易' }, { key: '/data', label: '数据管理' }]}
    onNavigate={key => navigate(key)} onBack={detail ? () => navigate('/market-data') : undefined}
    colorMode="light" onToggleColorMode={() => {}} topBar={null}
    center={<section><span data-testid="current-path">{location.pathname}</span>
      <button onClick={() => navigate('/market-detail/000001')}>打开股票详情</button>
    </section>} />;
}

function createVisualViewport(initialHeight: number) {
  const listeners = new Set<EventListenerOrEventListenerObject>();
  const viewport = {
    height: initialHeight,
    scale: 1,
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener);
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener);
    }),
    emitResize: () => {
      const event = new Event('resize');
      listeners.forEach((listener) => {
        if (typeof listener === 'function') listener(event);
        else listener.handleEvent(event);
      });
    },
  };
  return viewport;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('mobile workspace navigation', () => {
  it('keeps secondary workspaces reachable through More and closes the menu after navigation', async () => {
    render(<MemoryRouter initialEntries={['/factors']}><Fixture /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '更多功能' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '模拟交易' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/paper-trading');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '自选' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/watchlist');
  });

  it('returns stock details to the watchlist they were opened from', () => {
    render(<MemoryRouter initialEntries={['/watchlist']}><Fixture /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '打开股票详情' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/market-detail/000001');
    expect(screen.queryByRole('navigation', { name: '移动主导航' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回自选' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/watchlist');
  });

  it('uses 行情 as the safe return target for a directly opened detail route', () => {
    render(<MemoryRouter initialEntries={['/market-detail/000001']}><Fixture /></MemoryRouter>);
    expect(screen.queryByRole('navigation', { name: '移动主导航' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '返回行情' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/market-data');
  });

  it('returns to a non-market workspace when details were opened there', () => {
    render(<MemoryRouter initialEntries={['/stock-selection']}><Fixture /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '打开股票详情' }));
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(screen.getByTestId('current-path').textContent).toBe('/stock-selection');
  });

  it('restores the originating list scroll position after returning from detail', async () => {
    render(<MemoryRouter initialEntries={['/watchlist']}><Fixture /></MemoryRouter>);
    const scroller = document.querySelector('.mobile-app-scroll') as HTMLDivElement;
    scroller.scrollTop = 236;
    fireEvent.scroll(scroller);

    fireEvent.click(screen.getByRole('button', { name: '打开股票详情' }));
    fireEvent.click(screen.getByRole('button', { name: '返回自选' }));
    await waitFor(() => expect(scroller.scrollTop).toBe(236));
  });

  it('cleans up mobile-only portal styling when the layout unmounts', () => {
    const result = render(<MemoryRouter><Fixture /></MemoryRouter>);
    expect(document.body.classList.contains('mobile-layout-active')).toBe(true);
    result.unmount();
    expect(document.body.classList.contains('mobile-layout-active')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('');
  });

  it('tracks visual viewport changes and marks the bottom navigation hidden while the keyboard is open', async () => {
    const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const previousInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');
    const viewport = createVisualViewport(844);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });

    try {
      const result = render(<MemoryRouter><Fixture /></MemoryRouter>);
      await waitFor(() => expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('844px'));
      expect(document.body.classList.contains('mobile-keyboard-open')).toBe(false);
      expect(screen.getByRole('navigation', { name: '移动主导航' })).toBeTruthy();

      viewport.height = 500;
      act(() => viewport.emitResize());
      await waitFor(() => expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('500px'));
      expect(document.body.classList.contains('mobile-keyboard-open')).toBe(true);

      result.unmount();
      expect(document.body.classList.contains('mobile-keyboard-open')).toBe(false);
      expect(document.documentElement.style.getPropertyValue('--mobile-viewport-height')).toBe('');
      expect(viewport.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    } finally {
      if (previousViewport) Object.defineProperty(window, 'visualViewport', previousViewport);
      else Reflect.deleteProperty(window, 'visualViewport');
      if (previousInnerHeight) Object.defineProperty(window, 'innerHeight', previousInnerHeight);
    }
  });
});
