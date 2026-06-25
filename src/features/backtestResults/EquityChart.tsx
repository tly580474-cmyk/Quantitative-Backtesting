import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
  CrosshairMode,
  createSeriesMarkers,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  type SeriesMarker,
  type ISeriesMarkersPluginApi,
} from 'lightweight-charts';
import { CHART_COLORS } from '@/features/chart/chartConfig';

export interface EquitySeriesPoint {
  time: string;
  value: number;
  /** Cumulative contributed capital at this point, used as cost basis for DCA return %. */
  costBasis?: number;
}

interface SeriesData {
  id?: string;
  label: string;
  color: string;
  data: EquitySeriesPoint[];
  valueFormat?: 'currency' | 'normalized';
  markers?: SeriesMarker<Time>[];
  /** Whether to show percentage change in the tooltip. Defaults to true. */
  showChange?: boolean;
  /** Render the line as dashed. */
  dashed?: boolean;
}

interface Props {
  series: SeriesData[];
  height?: number;
}

interface TooltipRow {
  label: string;
  color: string;
  value: number;
  valueFormat: 'currency' | 'normalized';
  change: number | null;
  order: number;
}

export default function EquityChart({ series, height = 300 }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const seriesMetaRef = useRef<Map<ISeriesApi<'Line'>, {
    label: string;
    color: string;
    initialEquity: number;
    valueFormat: 'currency' | 'normalized';
    showChange: boolean;
  }>>(new Map());
  const costBasisMapRef = useRef<Map<ISeriesApi<'Line'>, Map<string, number>>>(new Map());
  const markerPluginsRef = useRef<Map<string, ISeriesMarkersPluginApi<Time>>>(new Map());

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: CHART_COLORS.background },
        textColor: CHART_COLORS.text,
      },
      grid: {
        vertLines: { color: CHART_COLORS.grid },
        horzLines: { color: CHART_COLORS.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
      },
      rightPriceScale: {
        borderColor: '#D1D5DB',
      },
      timeScale: {
        borderColor: '#D1D5DB',
        timeVisible: true,
      },
      width: containerRef.current.clientWidth,
      height,
    });

    chartRef.current = chart;

    const handleCrosshairMove = (param: MouseEventParams<Time>) => {
      const tooltip = tooltipRef.current;
      const wrapper = wrapperRef.current;
      if (!tooltip || !wrapper || !param.point || param.time === undefined) {
        if (tooltip) tooltip.style.display = 'none';
        return;
      }

      const rows: TooltipRow[] = [];
      let order = 0;
      for (const [lineSeries, meta] of seriesMetaRef.current) {
        const point = param.seriesData.get(lineSeries) as LineData<Time> | undefined;
        if (!point || typeof point.value !== 'number' || meta.initialEquity <= 0) continue;
        const costBasisMap = costBasisMapRef.current.get(lineSeries);
        const costBasis = costBasisMap?.get(String(param.time));
        const baseline = costBasis ?? meta.initialEquity;
        const change = meta.showChange ? (point.value / baseline - 1) * 100 : null;
        rows.push({
          label: meta.label,
          color: meta.color,
          value: point.value,
          valueFormat: meta.valueFormat,
          change,
          order: order++,
        });
      }

      const sortedRows = rows
        .sort((a, b) => {
          if (a.change === null && b.change === null) return a.order - b.order;
          if (a.change === null) return 1;
          if (b.change === null) return -1;
          return b.change - a.change || a.order - b.order;
        })
        .map((row) => {
          const changeClass = row.change !== null
            ? (row.change > 0 ? 'is-positive' : row.change < 0 ? 'is-negative' : '')
            : '';
          return `
          <div class="equity-tooltip-row">
            <span class="equity-tooltip-label">
              <i style="background:${row.color}"></i>${escapeHtml(row.label)}
            </span>
            <span class="equity-tooltip-equity">${row.valueFormat === 'currency' ? `¥${formatMoney(row.value)}` : row.value.toFixed(2)}</span>
            <span class="equity-tooltip-change ${changeClass}">${row.change !== null ? formatPercent(row.change) : ''}</span>
          </div>
        `;
        });

      if (rows.length === 0) {
        tooltip.style.display = 'none';
        return;
      }

      tooltip.innerHTML = `
        <div class="equity-tooltip-time">${formatChartTime(param.time)}</div>
        ${sortedRows.join('')}
      `;
      tooltip.style.display = 'block';

      const padding = 8;
      const offset = 14;
      const maxLeft = wrapper.clientWidth - tooltip.offsetWidth - padding;
      const maxTop = wrapper.clientHeight - tooltip.offsetHeight - padding;
      tooltip.style.left = `${Math.max(padding, Math.min(param.point.x + offset, maxLeft))}px`;
      tooltip.style.top = `${Math.max(padding, Math.min(param.point.y + offset, maxTop))}px`;
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    const onResize = () => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height,
        });
      }
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
      seriesMetaRef.current.clear();
      costBasisMapRef.current.clear();
      for (const plugin of markerPluginsRef.current.values()) {
        plugin.detach();
      }
      markerPluginsRef.current.clear();
    };
  }, [height]);

  // Update series data
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const activeLabels = new Set<string>();

    for (const s of series) {
      const seriesId = s.id ?? s.label;
      activeLabels.add(seriesId);

      let lineSeries = seriesRef.current.get(seriesId);
      if (!lineSeries) {
        lineSeries = chart.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 1,
          lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceFormat: s.valueFormat === 'normalized'
            ? { type: 'custom', formatter: (value: number) => value.toFixed(2) }
            : { type: 'price', precision: 2, minMove: 0.01 },
        });
        seriesRef.current.set(seriesId, lineSeries);
      }

      const data: LineData[] = s.data
        .filter((p) => p.value > 0)
        .map((p) => ({
          time: p.time as Time,
          value: p.value,
        }));
      lineSeries.setData(data);

      const existingMarker = markerPluginsRef.current.get(seriesId);
      if (existingMarker) {
        existingMarker.detach();
        markerPluginsRef.current.delete(seriesId);
      }
      if (s.markers && s.markers.length > 0) {
        const markerPlugin = createSeriesMarkers(lineSeries, s.markers);
        markerPluginsRef.current.set(seriesId, markerPlugin);
      }

      const costBasisByTime = new Map<string, number>();
      for (const pt of s.data) {
        if (pt.costBasis !== undefined) {
          costBasisByTime.set(pt.time, pt.costBasis);
        }
      }
      if (costBasisByTime.size > 0) {
        costBasisMapRef.current.set(lineSeries, costBasisByTime);
      }

      seriesMetaRef.current.set(lineSeries, {
        label: s.label,
        color: s.color,
        initialEquity: s.data.find((point) => point.value > 0)?.value ?? 0,
        valueFormat: s.valueFormat ?? 'currency',
        showChange: s.showChange ?? true,
      });
    }

    // Remove stale series
    for (const [seriesId, s] of seriesRef.current) {
      if (!activeLabels.has(seriesId)) {
        const markerPlugin = markerPluginsRef.current.get(seriesId);
        if (markerPlugin) {
          markerPlugin.detach();
          markerPluginsRef.current.delete(seriesId);
        }
        chart.removeSeries(s);
        seriesMetaRef.current.delete(s);
        costBasisMapRef.current.delete(s);
        seriesRef.current.delete(seriesId);
      }
    }

    chart.timeScale().fitContent();
  }, [series]);

  return (
    <div ref={wrapperRef} className="equity-chart-wrapper" style={{ height }}>
      <div
        ref={containerRef}
        style={{ width: '100%', height, overflow: 'hidden' }}
      />
      <div
        ref={tooltipRef}
        className="equity-chart-tooltip"
        role="status"
        aria-live="polite"
      />
    </div>
  );
}

function formatChartTime(time: Time): string {
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toLocaleDateString('zh-CN');
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function formatMoney(value: number): string {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
