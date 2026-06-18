import { useEffect, useRef } from 'react';
import {
  createChart,
  LineSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
  CrosshairMode,
} from 'lightweight-charts';
import type { EquityPoint } from '@/models';
import { CHART_COLORS } from '@/features/chart/chartConfig';

interface SeriesData {
  label: string;
  color: string;
  data: EquityPoint[];
}

interface Props {
  series: SeriesData[];
  height?: number;
}

export default function EquityChart({ series, height = 300 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());

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
      chart.remove();
      chartRef.current = null;
      seriesRef.current.clear();
    };
  }, [height]);

  // Update series data
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const activeLabels = new Set<string>();

    for (const s of series) {
      const label = s.label;
      activeLabels.add(label);

      let lineSeries = seriesRef.current.get(label);
      if (!lineSeries) {
        lineSeries = chart.addSeries(LineSeries, {
          color: s.color,
          lineWidth: 1,
        });
        seriesRef.current.set(label, lineSeries);
      }

      const data: LineData[] = s.data
        .filter((p) => p.equity > 0)
        .map((p) => ({
          time: p.time as Time,
          value: p.equity,
        }));
      lineSeries.setData(data);
    }

    // Remove stale series
    for (const [label, s] of seriesRef.current) {
      if (!activeLabels.has(label)) {
        chart.removeSeries(s);
        seriesRef.current.delete(label);
      }
    }

    chart.timeScale().fitContent();
  }, [series]);

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height, overflow: 'hidden' }}
    />
  );
}
