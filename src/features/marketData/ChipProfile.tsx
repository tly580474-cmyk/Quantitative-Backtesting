import type { ChipDistribution } from './chipDistribution';

interface ChipProfileProps {
  distribution: ChipDistribution | null;
  asOfDate: string | null;
  priceToCoordinate: ((price: number) => number | null) | null;
  chartHeight: number;
}

export default function ChipProfile({
  distribution,
  asOfDate,
  priceToCoordinate,
  chartHeight,
}: ChipProfileProps) {
  if (!distribution) {
    return (
      <aside className="market-chip-profile is-empty" aria-label="筹码峰暂无数据">
        <strong>筹码峰</strong>
        <span>{asOfDate ? `${asOfDate} 缺少足够的每日换手率` : '缺少完整的每日换手率'}</span>
      </aside>
    );
  }

  const maxWeight = Math.max(...distribution.bins.map((bin) => bin.weight));
  const position = (price: number) => priceToCoordinate?.(price) ?? null;
  const peakTop = position(distribution.peakPrice);
  const visibleThreshold = maxWeight * 0.015;
  const coordinateStep = distribution.bins.length > 1
    ? Math.abs((position(distribution.bins[1].price) ?? 0)
      - (position(distribution.bins[0].price) ?? 0))
    : 1;
  const visibleBins = distribution.bins
    .map((bin) => ({ ...bin, coordinate: position(bin.price) }))
    .filter((bin) => bin.weight >= visibleThreshold
      && bin.coordinate != null
      && bin.coordinate >= 0
      && bin.coordinate <= chartHeight);
  const averageTop = position(distribution.averageCost);
  const closeTop = position(distribution.latestClose);
  const cost70Top = position(distribution.costRange70[1]);
  const cost70Bottom = position(distribution.costRange70[0]);
  const cost90Top = position(distribution.costRange90[1]);
  const cost90Bottom = position(distribution.costRange90[0]);
  const rangeStyle = (top: number | null, bottom: number | null) => {
    if (top == null || bottom == null) return undefined;
    const start = Math.max(0, Math.min(top, bottom));
    const end = Math.min(chartHeight, Math.max(top, bottom));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return undefined;
    return { top: `${start}px`, height: `${end - start}px` };
  };
  const cost70Style = rangeStyle(cost70Top, cost70Bottom);
  const cost90Style = rangeStyle(cost90Top, cost90Bottom);

  return (
    <aside
      className="market-chip-profile"
      aria-label={`${asOfDate ?? '最新'}筹码峰，峰值 ${fmt(distribution.peakPrice)}，平均成本 ${fmt(distribution.averageCost)}，获利比例 ${fmt(distribution.profitRatio * 100)}%`}
    >
      <div className="market-chip-summary">
        <strong>筹码峰 {fmt(distribution.peakPrice)}</strong>
        {asOfDate && <time dateTime={asOfDate}>截至 {asOfDate}</time>}
        <span><b>均本</b>{fmt(distribution.averageCost)}</span>
        <span><b>获利</b>{fmt(distribution.profitRatio * 100, 1)}%</span>
        <span><b>峰占</b>{fmt(distribution.peakWeight * 100, 1)}%</span>
        <span><b>集中</b>{fmt(distribution.concentration70 * 100, 1)}%</span>
      </div>
      <div className="market-chip-bars" aria-hidden="true">
        {cost90Style && <em className="market-chip-cost-band is-wide" style={cost90Style} />}
        {cost70Style && <em className="market-chip-cost-band" style={cost70Style} />}
        {visibleBins.map((bin, index) => (
          <i
            key={`${bin.price}-${index}`}
            className={bin.price <= distribution.latestClose ? 'is-profit' : 'is-trapped'}
            style={{
              top: `${bin.coordinate}px`,
              width: `${maxWeight > 0 ? bin.weight / maxWeight * 88 : 0}%`,
              height: `${Math.max(1, Math.min(5, coordinateStep + 0.45))}px`,
              opacity: `${0.28 + (maxWeight > 0 ? bin.weight / maxWeight : 0) * 0.58}`,
            }}
          />
        ))}
        {peakTop != null && peakTop >= 0 && peakTop <= chartHeight
          && <b className="market-chip-peak-line" style={{ top: `${peakTop}px` }} />}
        {distribution.secondaryPeaks.map((peak, index) => {
          const top = position(peak.price);
          return top != null && top >= 0 && top <= chartHeight
            ? <b key={`${peak.price}-${index}`} className="market-chip-peak-line is-secondary" style={{ top: `${top}px` }} />
            : null;
        })}
        {averageTop != null && averageTop >= 0 && averageTop <= chartHeight
          && <b className="market-chip-reference-line is-average" style={{ top: `${averageTop}px` }} />}
        {closeTop != null && closeTop >= 0 && closeTop <= chartHeight
          && <b className="market-chip-reference-line is-close" style={{ top: `${closeTop}px` }} />}
      </div>
      <div className="market-chip-foot">
        <span>70% {fmt(distribution.costRange70[0])}-{fmt(distribution.costRange70[1])}</span>
        <span>90% {fmt(distribution.costRange90[0])}-{fmt(distribution.costRange90[1])}</span>
        {distribution.coverageRatio < 1
          && <span>覆盖 {fmt(distribution.coverageRatio * 100, 0)}%</span>}
      </div>
    </aside>
  );
}

function fmt(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
