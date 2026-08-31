import { MetricStrip, financialTone } from '@/components/WorkspacePrimitives';
import type { BacktestMetrics } from '@/models';

function pct(value: number | undefined | null, signed = false): string {
  return value != null && Number.isFinite(value)
    ? `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
    : '—';
}

function num(value: number | undefined | null, decimals = 2): string {
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '−∞';
  return value != null && Number.isFinite(value)
    ? value.toLocaleString('zh-CN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : '—';
}

interface Props {
  metrics: BacktestMetrics;
  name: string;
  color?: string;
}

export default function ResultsOverview({ metrics, name, color }: Props) {
  const secondary = [
    ['累计投入', `¥${num(metrics.netContributions ?? metrics.initialCapital)}`],
    ['基准收益', pct(metrics.benchmarkReturn, true)],
    ['年化波动率', pct(metrics.annualizedVolatility)],
    ['风险收益比', num(metrics.riskReturnRatio)],
    ['回撤收益比', num(metrics.returnMddRatio)],
    ['交易次数', num(metrics.tradeCount, 0)],
    ['胜率', pct(metrics.winRate)],
    ['盈亏比', num(metrics.profitFactor)],
    ['平均持仓天数', `${num(metrics.avgHoldingDays, 1)} 天`],
    ['总手续费', `¥${num(metrics.totalCommission)}`],
    ['总印花税', `¥${num(metrics.totalTax)}`],
  ];
  return <section className="results-metrics-card" aria-label={name || '回测绩效指标'}>
    {name && <h3 style={color ? { borderLeft: `3px solid ${color}`, paddingLeft: 8 } : undefined}>{name}</h3>}
    <MetricStrip label="回测核心指标" items={[
      { label: '累计收益率', value: pct(metrics.totalReturn, true), tone: financialTone(metrics.totalReturn) },
      { label: '年化收益率', value: pct(metrics.annualizedReturn, true), tone: financialTone(metrics.annualizedReturn) },
      { label: '最大回撤', value: pct(metrics.maxDrawdown), tone: 'risk', note: '风险指标 · 基于单位净值' },
      { label: '期末权益', value: `¥${num(metrics.finalEquity)}` },
      { label: '夏普比率', value: num(metrics.sharpeRatio) },
      { label: '超额收益', value: pct(metrics.excessReturn, true), tone: financialTone(metrics.excessReturn) },
    ]} />
    <details className="workspace-details">
      <summary>更多绩效指标与费用明细</summary>
      <dl className="results-secondary-metrics">
        {secondary.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {metrics.metricsNote && <p className="results-metrics-note">{metrics.metricsNote}</p>}
    </details>
  </section>;
}
