import type { ReactNode } from 'react';
import { Empty } from 'antd';

export function PageHeader({ title, description, actions, className = '' }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return <header className={`workspace-page-header ${className}`}>
    <div className="workspace-page-heading">
      <h1>{title}</h1>
      {description && <div className="workspace-page-description">{description}</div>}
    </div>
    {actions && <div className="workspace-page-actions">{actions}</div>}
  </header>;
}

export type MetricTone = 'neutral' | 'positive' | 'negative' | 'risk';

export function financialTone(value: number | null | undefined): MetricTone {
  return value != null && Number.isFinite(value)
    ? value > 0 ? 'positive' : value < 0 ? 'negative' : 'neutral'
    : 'neutral';
}

export function MetricStrip({ items, label = '关键指标', className = '' }: {
  items: Array<{ label: string; value: ReactNode; note?: ReactNode; tone?: MetricTone }>;
  label?: string;
  className?: string;
}) {
  return <dl className={`workspace-metric-strip ${className}`} aria-label={label}>
    {items.map((item) => <div key={item.label} className={`workspace-metric is-${item.tone ?? 'neutral'}`}>
      <dt>{item.label}</dt>
      <dd>{item.value}</dd>
      {item.note && <small>{item.note}</small>}
    </div>)}
  </dl>;
}

export function WorkbenchEmpty({ title, description, action }: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return <div className="workspace-empty">
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={
      <div><strong>{title}</strong>{description && <p>{description}</p>}</div>
    }>{action}</Empty>
  </div>;
}
