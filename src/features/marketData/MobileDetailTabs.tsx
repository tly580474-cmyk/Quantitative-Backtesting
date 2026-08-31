import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';

const PANELS = [
  { key: 'chart', label: '走势' },
  { key: 'analysis', label: '分析' },
  { key: 'info', label: '资料' },
] as const;
type Panel = typeof PANELS[number]['key'];

/** Keep the chart and in-progress research mounted while switching context. */
export default function MobileDetailTabs({ chart, analysis, info, hasScore }: {
  chart: ReactNode; analysis: ReactNode; info: ReactNode; hasScore: boolean;
}) {
  const [active, setActive] = useState<Panel>('chart');
  const root = useRef<HTMLDivElement>(null);
  const positions = useRef<Record<Panel, number>>({ chart: 0, analysis: 0, info: 0 });
  const switched = useRef(false);
  const select = (next: Panel) => {
    if (next === active) return;
    const scroller = root.current?.closest('.mobile-app-scroll');
    if (scroller) positions.current[active] = scroller.scrollTop;
    switched.current = true;
    setActive(next);
  };
  useLayoutEffect(() => {
    const scroller = root.current?.closest('.mobile-app-scroll');
    if (switched.current && scroller) scroller.scrollTop = positions.current[active];
  }, [active]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' ? (index + 1) % PANELS.length
      : event.key === 'ArrowLeft' ? (index + PANELS.length - 1) % PANELS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? PANELS.length - 1 : null;
    if (next == null) return;
    event.preventDefault();
    select(PANELS[next].key);
    root.current?.querySelector<HTMLButtonElement>(`#detail-tab-${PANELS[next].key}`)?.focus();
  };
  return <div className="mobile-detail-tabs" ref={root}>
    <div className="mobile-detail-tab-list" role="tablist" aria-label="个股详情内容">
      {PANELS.map((panel, index) => <button key={panel.key} type="button" role="tab"
        id={`detail-tab-${panel.key}`} aria-controls={`detail-panel-${panel.key}`}
        aria-selected={active === panel.key} tabIndex={active === panel.key ? 0 : -1}
        onClick={() => select(panel.key)} onKeyDown={(event) => onKeyDown(event, index)}>{panel.label}</button>)}
    </div>
    <section id="detail-panel-chart" role="tabpanel" aria-labelledby="detail-tab-chart" hidden={active !== 'chart'}>
      {chart}
      <button className="mobile-detail-analysis-link" type="button" onClick={() => select('analysis')}>
        <span><strong>{hasScore ? '量化评分与 AI 分析' : 'AI 分析'}</strong><small>查看分析依据与风险</small></span>
        <ArrowRightOutlined />
      </button>
    </section>
    <section id="detail-panel-analysis" role="tabpanel" aria-labelledby="detail-tab-analysis" hidden={active !== 'analysis'}>{analysis}</section>
    <section id="detail-panel-info" role="tabpanel" aria-labelledby="detail-tab-info" hidden={active !== 'info'}>{info}</section>
  </div>;
}
