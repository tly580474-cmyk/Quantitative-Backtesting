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
  const visibleThreshold = maxWeight * 0.05;
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

  return (
    <aside
      className="market-chip-profile"
      aria-label={`${asOfDate ?? '最新'}筹码峰，峰值 ${fmt(distribution.peakPrice)}，平均成本 ${fmt(distribution.averageCost)}，获利比例 ${fmt(distribution.profitRatio * 100)}%`}
    >
      <div className="market-chip-summary">
        <strong>筹码峰 {fmt(distribution.peakPrice)}</strong>
        {asOfDate && <time dateTime={asOfDate}>截至 {asOfDate}</time>}
        <span>平均成本 {fmt(distribution.averageCost)}</span>
        <span>获利 {fmt(distribution.profitRatio * 100)}%</span>
      </div>
      <div className="market-chip-bars" aria-hidden="true">
        {visibleBins.map((bin, index) => (
          <i
            key={`${bin.price}-${index}`}
            className={bin.price <= distribution.latestClose ? 'is-profit' : 'is-trapped'}
            style={{
              top: `${bin.coordinate}px`,
              width: `${maxWeight > 0 ? bin.weight / maxWeight * 92 : 0}%`,
              height: `${Math.max(1.2, coordinateStep + 0.3)}px`,
            }}
          />
        ))}
        {peakTop != null && peakTop >= 0 && peakTop <= chartHeight
          && <b className="market-chip-peak-line" style={{ top: `${peakTop}px` }} />}
      </div>
      <div className="market-chip-foot">
        70%成本 {fmt(distribution.costRange70[0])}–{fmt(distribution.costRange70[1])}
        {distribution.coverageRatio < 1
          && ` · 覆盖 ${fmt(distribution.coverageRatio * 100, 0)}%`}
      </div>
    </aside>
  );
}

function fmt(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
