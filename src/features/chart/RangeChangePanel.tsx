import { useMemo } from 'react';
import { Button, Typography, Tooltip } from 'antd';
import { AimOutlined, InfoCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { useCandleStore } from '@/stores/useCandleStore';
import { useChartStore } from '@/stores/useChartStore';
import { calculateRangeChange } from '@/utils/rangeChange';
import type { RangeChangeResult } from '@/utils/rangeChange';

const { Text } = Typography;

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function ResultRow({ label, value, tooltip }: { label: string; value: string; tooltip?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>
      <Text strong style={{ fontSize: 13 }}>{value}</Text>
      {tooltip && (
        <Tooltip title={tooltip}>
          <InfoCircleOutlined style={{ color: '#94A3B8', fontSize: 12 }} />
        </Tooltip>
      )}
    </span>
  );
}

interface RangeChangePanelProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

export default function RangeChangePanel({ enabled, onEnabledChange }: RangeChangePanelProps) {
  const importResult = useCandleStore((s) => s.importResult);
  const candles = useCandleStore((s) => s.candles);
  const rangeLineStart = useChartStore((s) => s.rangeLineStart);
  const rangeLineEnd = useChartStore((s) => s.rangeLineEnd);

  const { result, error } = useMemo(() => {
    if (!rangeLineStart || !rangeLineEnd) return { result: null, error: null };
    const status = calculateRangeChange(candles, rangeLineStart, rangeLineEnd);
    if (status.type === 'success') return { result: status.result, error: null };
    return { result: null, error: status.message };
  }, [candles, rangeLineStart, rangeLineEnd]);

  const isPositive = result != null && result.change >= 0;
  const changeColor = result == null ? undefined : isPositive ? '#CF1322' : '#3F8600';

  if (!importResult || candles.length === 0) return null;

  return (
    <div
      style={{
        padding: '6px 16px',
        background: '#FAFBFC',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        minHeight: 40,
      }}
    >
      <Button
        type={enabled ? 'primary' : 'default'}
        size="small"
        icon={<AimOutlined />}
        aria-pressed={enabled}
        onClick={() => onEnabledChange(!enabled)}
      >
        {enabled ? '关闭区间选择' : '开启区间选择'}
      </Button>

      {enabled && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          拖拽图表上的蓝线选择区间
        </Text>
      )}

      {enabled && result && (
        <>
          <Text style={{ fontSize: 13, fontWeight: 500 }}>
            {result.actualStartDate} ~ {result.actualEndDate}
          </Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {fmt(result.startClose, 2)} → {fmt(result.endClose, 2)}
          </Text>
          <Text strong style={{ color: changeColor, fontSize: 14 }}>
            {isPositive ? '+' : ''}{fmt(result.change, 2)} ({isPositive ? '+' : ''}{fmt(result.changePercent, 2)}%)
          </Text>
          <Text type="secondary" style={{ fontSize: 11 }}>
            {result.totalBars}根K线
          </Text>
          {result.isAdjustedStart && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              (起始日已调整至 {result.actualStartDate})
            </Text>
          )}
          {result.isAdjustedEnd && (
            <Text type="secondary" style={{ fontSize: 11 }}>
              (结束日已调整至 {result.actualEndDate})
            </Text>
          )}
        </>
      )}

      {enabled && error && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <WarningOutlined style={{ color: '#FAAD14', fontSize: 14 }} />
          <Text style={{ color: '#8C8C8C', fontSize: 12 }}>{error}</Text>
        </span>
      )}
    </div>
  );
}
