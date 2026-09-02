import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DrawingToolbar from './DrawingToolbar';
import { useDrawingStore } from '@/stores/useDrawingStore';

function resetStore(): void {
  localStorage.clear();
  useDrawingStore.setState({
    contextKey: '',
    drawings: [],
    draft: null,
    selectedId: null,
    tool: 'select',
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
  });
}

beforeEach(resetStore);
afterEach(cleanup);

describe('DrawingToolbar', () => {
  it('exposes an accessible popover and changes the active drawing tool', () => {
    render(<DrawingToolbar />);
    expect(screen.getByRole('toolbar', { name: '画线工具栏' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '浏览模式' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '画线工具' }));
    const horizontal = screen.getByRole('menuitemradio', { name: /水平线/ });
    fireEvent.click(horizontal);

    expect(useDrawingStore.getState().tool).toBe('horizontal');
    expect(screen.getByRole('button', { name: /画线工具，当前为水平线/ }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('status').textContent).toContain('点击价格位置');
  });

  it('supports keyboard tool selection, Escape and undoable clear', () => {
    render(<DrawingToolbar />);
    fireEvent.keyDown(window, { key: 'h' });
    expect(useDrawingStore.getState().tool).toBe('horizontal');

    act(() => {
      useDrawingStore.getState().add({ type: 'horizontal', points: [{ time: '2026-01-02', price: 10 }] });
    });
    expect(screen.getByRole('button', { name: '删除选中画线' }).hasAttribute('disabled')).toBe(false);
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(useDrawingStore.getState().drawings).toHaveLength(0);

    act(() => {
      useDrawingStore.getState().add({ type: 'horizontal', points: [{ time: '2026-01-02', price: 10 }] });
    });
    fireEvent.click(screen.getByRole('button', { name: /清除全部画线/ }));
    expect(useDrawingStore.getState().drawings).toHaveLength(0);
    expect(useDrawingStore.getState().canUndo).toBe(true);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useDrawingStore.getState().tool).toBe('select');
  });

  it('forwards tool changes and supports disabled state', () => {
    const onToolChange = (tool: Parameters<NonNullable<React.ComponentProps<typeof DrawingToolbar>['onToolChange']>>[0]) => {
      expect(tool).toBe('rectangle');
    };
    render(<DrawingToolbar disabled onToolChange={onToolChange} />);
    expect(screen.getByRole('button', { name: '浏览模式' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '画线工具' }));
    expect(useDrawingStore.getState().tool).toBe('select');
  });
});
