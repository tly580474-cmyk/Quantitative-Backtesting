import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import MobileDetailTabs from './MobileDetailTabs';

function StatefulPanel({ name }: { name: string }) {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        {name} action {count}
      </button>
      <span data-testid={`${name}-mounted`}>mounted</span>
    </div>
  );
}

afterEach(() => cleanup());

describe('MobileDetailTabs', () => {
  it('keeps each panel mounted and preserves its local state while switching tabs', () => {
    render(
      <MobileDetailTabs
        hasScore
        chart={<StatefulPanel name="chart" />}
        analysis={<StatefulPanel name="analysis" />}
        info={<StatefulPanel name="info" />}
      />,
    );

    const chartPanel = document.getElementById('detail-panel-chart');
    const analysisPanel = document.getElementById('detail-panel-analysis');
    expect(chartPanel).not.toBeNull();
    expect(analysisPanel).not.toBeNull();
    expect(chartPanel?.hasAttribute('hidden')).toBe(false);
    expect(analysisPanel?.hasAttribute('hidden')).toBe(true);
    expect(within(chartPanel!).getByTestId('chart-mounted')).toBeTruthy();
    expect(within(analysisPanel!).getByTestId('analysis-mounted')).toBeTruthy();

    const chartAction = within(chartPanel!).getByRole('button', { name: 'chart action 0' });
    fireEvent.click(chartAction);
    expect(chartAction.textContent).toBe('chart action 1');

    fireEvent.click(screen.getByRole('tab', { name: '分析' }));
    expect(analysisPanel?.hasAttribute('hidden')).toBe(false);
    expect(chartPanel?.hasAttribute('hidden')).toBe(true);

    fireEvent.click(screen.getByRole('tab', { name: '走势' }));
    expect(chartPanel?.hasAttribute('hidden')).toBe(false);
    expect(within(chartPanel!).getByRole('button', { name: 'chart action 1' })).toBeTruthy();
  });

  it('switches tabs with arrow keys and keeps roving tab focus accessible', () => {
    render(
      <MobileDetailTabs
        hasScore={false}
        chart={<span>chart content</span>}
        analysis={<span>analysis content</span>}
        info={<span>info content</span>}
      />,
    );

    const chartTab = screen.getByRole('tab', { name: '走势' });
    const analysisTab = screen.getByRole('tab', { name: '分析' });
    const infoTab = screen.getByRole('tab', { name: '资料' });

    chartTab.focus();
    fireEvent.keyDown(chartTab, { key: 'ArrowRight' });
    expect(analysisTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(analysisTab);

    fireEvent.keyDown(analysisTab, { key: 'End' });
    expect(infoTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(infoTab);

    fireEvent.keyDown(infoTab, { key: 'ArrowLeft' });
    expect(analysisTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(analysisTab);
  });
});
