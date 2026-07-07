import { useChartStore } from '@/stores/useChartStore';
import { roundTo } from '@/utils/number';

export default function CandleDetail({ left = 8 }: { left?: number }) {
  const time = useChartStore((s) => s.crosshairTime);
  const data = useChartStore((s) => s.crosshairData);
  const indicators = useChartStore((s) => s.crosshairIndicators);

  if (!time || !data) return null;

  const changeColor =
    (data.change ?? 0) >= 0 ? '#EF4444' : '#22C55E';

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        left,
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #E5E7EB',
        borderRadius: 8,
        padding: '12px 16px',
        fontSize: 12,
        minWidth: 210,
        maxHeight: 'calc(100vh - 80px)',
        overflowY: 'auto',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        zIndex: 10,
        pointerEvents: 'none',
        fontFamily: 'monospace',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: '#333' }}>
        {time}
      </div>
      <Row label="开盘" value={data.open.toFixed(2)} />
      <Row label="最高" value={data.high.toFixed(2)} />
      <Row label="最低" value={data.low.toFixed(2)} />
      <Row label="收盘" value={data.close.toFixed(2)} />
      {data.change != null && (
        <Row
          label="涨跌"
          value={data.change.toFixed(2)}
          color={changeColor}
        />
      )}
      {data.changePercent != null && (
        <Row
          label="涨跌幅"
          value={`${data.changePercent.toFixed(2)}%`}
          color={changeColor}
        />
      )}
      {data.volume != null && (
        <Row label="成交量" value={formatVolume(data.volume)} />
      )}
      {data.turnover != null && (
        <Row label="成交额" value={`${data.turnover.toFixed(2)} 亿`} />
      )}
      {data.turnoverRatePct != null && (
        <Row label="换手率" value={`${data.turnoverRatePct.toFixed(2)}%`} />
      )}
      {indicators.map((indicator) => (
        <div
          key={indicator.id}
          style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #E5E7EB' }}
        >
          <div style={{ marginBottom: 2, fontWeight: 600, color: '#555' }}>
            {indicator.name}
          </div>
          {indicator.values.map((item) => (
            <Row
              key={`${indicator.id}-${item.label}`}
              label={item.label}
              value={formatIndicatorValue(item.value)}
              color={item.color}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '1px 0',
      }}
    >
      <span style={{ color: '#999' }}>{label}</span>
      <span style={{ color: color ?? '#333' }}>{value}</span>
    </div>
  );
}

function formatVolume(v: number): string {
  if (v >= 1e8) return `${roundTo(v / 1e8, 2)} 亿`;
  if (v >= 1e4) return `${roundTo(v / 1e4, 2)} 万`;
  return v.toFixed(0);
}

function formatIndicatorValue(value: number): string {
  const absValue = Math.abs(value);
  if (absValue >= 1e8) return `${roundTo(value / 1e8, 2)} 亿`;
  if (absValue >= 1e4) return `${roundTo(value / 1e4, 2)} 万`;
  return value.toFixed(2);
}
