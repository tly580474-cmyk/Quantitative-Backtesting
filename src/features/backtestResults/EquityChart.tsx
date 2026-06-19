import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type MouseEventParams,
  type Time,
  CrosshairMode,
} from 'lightweight-charts';
import type { EquityPoint } from '@/models';
import { CHART_COLORS } from '@/features/chart/chartConfig';

interface SeriesData {
  id?: string;
  label: string;
  color: string;
  data: EquityPoint[];
}

interface Props {
  series: SeriesData[];
  height?: number;
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
  }>>(new Map());

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

      const rows: string[] = [];
      for (const [lineSeries, meta] of seriesMetaRef.current) {
        const point = param.seriesData.get(lineSeries) as LineData<Time> | undefined;
        if (!point || typeof point.value !== 'number' || meta.initialEquity <= 0) continue;
        const change = (point.value / meta.initialEquity - 1) * 100;
        const changeClass = change > 0 ? 'is-positive' : change < 0 ? 'is-negative' : '';
        rows.push(`
          <div class="equity-tooltip-row">
            <span class="equity-tooltip-label">
              <i style="background:${meta.color}"></i>${escapeHtml(meta.label)}
            </span>
            <span class="equity-tooltip-equity">¥${formatMoney(point.value)}</span>
            <span class="equity-tooltip-change ${changeClass}">${formatPercent(change)}</span>
          </div>
        `);
      }

      if (rows.length === 0) {
        tooltip.style.display = 'none';
        return;
      }

      tooltip.innerHTML = `
        <div class="equity-tooltip-time">${formatChartTime(param.time)}</div>
        ${rows.join('')}
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
        });
        seriesRef.current.set(seriesId, lineSeries);
      }

      const data: LineData[] = s.data
        .filter((p) => p.equity > 0)
        .map((p) => ({
          time: p.time as Time,
          value: p.equity,
        }));
      lineSeries.setData(data);
      seriesMetaRef.current.set(lineSeries, {
        label: s.label,
        color: s.color,
        initialEquity: s.data.find((point) => point.equity > 0)?.equity ?? 0,
      });
    }

    // Remove stale series
    for (const [seriesId, s] of seriesRef.current) {
      if (!activeLabels.has(seriesId)) {
        chart.removeSeries(s);
        seriesMetaRef.current.delete(s);
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
