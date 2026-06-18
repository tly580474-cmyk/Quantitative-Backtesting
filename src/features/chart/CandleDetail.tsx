import { useChartStore } from '@/stores/useChartStore';
import { roundTo } from '@/utils/number';

export default function CandleDetail() {
  const time = useChartStore((s) => s.crosshairTime);
  const data = useChartStore((s) => s.crosshairData);

  if (!time || !data) return null;

  const changeColor =
    (data.change ?? 0) >= 0 ? '#EF4444' : '#22C55E';

  return (
    <div
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        background: 'rgba(255,255,255,0.95)',
        border: '1px solid #E5E7EB',
        borderRadius: 8,
        padding: '12px 16px',
        fontSize: 12,
        minWidth: 180,
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
