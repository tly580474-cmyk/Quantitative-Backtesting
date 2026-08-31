import { useId, useState, type ReactNode } from 'react';
import { Tooltip } from 'antd';
import { useMobileLayout } from '@/components/mobile/useMobileLayout';

interface FactorItem {
  key: string;
  label: string;
  description: string;
  content: ReactNode;
}

/** Touch explanations stay in flow, with a single expanded row instead of hover overlays. */
export default function MarketFactorList({ items }: { items: FactorItem[] }) {
  const mobile = useMobileLayout();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const id = useId();

  return <div className="market-factor-list">
    {items.map((item) => {
      if (!mobile) return <Tooltip key={item.key} title={item.description} trigger={['hover', 'focus']}>
        <div className="market-factor-row" tabIndex={0} aria-label={`${item.label}说明`}>{item.content}</div>
      </Tooltip>;

      const expanded = expandedKey === item.key;
      const panelId = `${id}-${item.key}`;
      return <div className="market-factor-item" key={item.key}>
        <button type="button" className="market-factor-row market-factor-toggle"
          aria-label={`${item.label}说明`} aria-expanded={expanded} aria-controls={panelId}
          onClick={() => setExpandedKey(expanded ? null : item.key)}>
          {item.content}
          <span className="market-factor-disclosure-icon" aria-hidden="true">{expanded ? '−' : '+'}</span>
        </button>
        <div id={panelId} className="market-factor-explanation" hidden={!expanded}
          role="region" aria-label={`${item.label}计算说明`}>{item.description}</div>
      </div>;
    })}
  </div>;
}
