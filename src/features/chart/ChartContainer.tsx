import { useEffect, useRef, useMemo } from 'react';
import {
  createChart,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
  CrosshairMode,
  ColorType,
} from 'lightweight-charts';
import { useCandleStore } from '@/stores/useCandleStore';
import { useIndicatorStore } from '@/stores/useIndicatorStore';
import { useChartStore } from '@/stores/useChartStore';
import { calculateAllIndicators } from '@/features/indicators/calculator';
import type { IndicatorResult } from '@/models';
import { CHART_COLORS, INDICATOR_PANE_HEIGHT } from './chartConfig';
import CandleDetail from './CandleDetail';

export default function ChartContainer() {
  const mainRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayLinesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const indicatorPanesRef = useRef<
    Map<string, { chart: IChartApi; series: Map<string, ISeriesApi<'Line' | 'Histogram'>>; container: HTMLDivElement }>
  >(new Map());
  const resizeHandlerRef = useRef<(() => void) | null>(null);

  const candles = useCandleStore((s) => s.candles);
  const actives = useIndicatorStore((s) => s.actives);
  const setCrosshairTime = useChartStore((s) => s.setCrosshairTime);
  const setCrosshairData = useChartStore((s) => s.setCrosshairData);

  const indicatorResults = useMemo(
    () => calculateAllIndicators(candles, actives),
    [candles, actives],
  );

  const overlays = useMemo(
    () => indicatorResults.filter((r) => {
      const a = actives.find((x) => x.id === r.id);
      return a?.definition.display.pane === 'overlay';
    }),
    [indicatorResults, actives],
  );

  const separates = useMemo(
    () => indicatorResults.filter((r) => {
      const a = actives.find((x) => x.id === r.id);
      return a?.definition.display.pane === 'separate';
    }),
    [indicatorResults, actives],
  );

  // Create main chart (once)
  useEffect(() => {
    if (!mainRef.current) return;
    const container = mainRef.current;

    const chart = createChart(container, {
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
        vertLine: { color: CHART_COLORS.crosshair, labelVisible: false },
        horzLine: { color: CHART_COLORS.crosshair, labelVisible: false },
      },
      rightPriceScale: {
        borderColor: '#D1D5DB',
        scaleMargins: { top: 0.05, bottom: 0.25 },
      },
      timeScale: {
        borderColor: '#D1D5DB',
        timeVisible: true,
        secondsVisible: false,
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.up,
      downColor: CHART_COLORS.down,
      borderUpColor: CHART_COLORS.up,
      borderDownColor: CHART_COLORS.down,
      wickUpColor: CHART_COLORS.wickUp,
      wickDownColor: CHART_COLORS.wickDown,
    });
    candleSeriesRef.current = candleSeries;

    const volSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      color: CHART_COLORS.volume,
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volSeries;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        setCrosshairTime(null);
        setCrosshairData(null);
        return;
      }
      const timeStr = param.time as string;
      setCrosshairTime(timeStr);
      // Use functional store read to avoid stale closure
      const currentCandles = useCandleStore.getState().candles;
      const c = currentCandles.find((x) => x.time === timeStr);
      if (c) {
        setCrosshairData({
          open: c.open, high: c.high, low: c.low, close: c.close,
          change: c.change, changePercent: c.changePercent,
          volume: c.volume, turnover: c.turnover,
        });
      }
    });

    mainChartRef.current = chart;

    const onResize = () => {
      if (mainChartRef.current && container) {
        mainChartRef.current.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
    };
    resizeHandlerRef.current = onResize;
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('resize', onResize);
      resizeHandlerRef.current = null;
      chart.remove();
      mainChartRef.current = null;
      overlayLinesRef.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update candle/volume data
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    const candleData: CandlestickData[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const volData: HistogramData[] = candles.map((c) => ({
      time: c.time as Time,
      value: c.volume ?? 0,
      color: c.close >= c.open ? CHART_COLORS.volume : CHART_COLORS.volumeDown,
    }));

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volData);
    mainChartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Update overlay indicator series
  useEffect(() => {
    const chart = mainChartRef.current;
    if (!chart || candles.length === 0) return;

    const usedIds = new Set<string>();

    for (const result of overlays) {
      const active = actives.find((a) => a.id === result.id);
      if (!active) continue;

      for (const cfg of active.definition.display.series) {
        const seriesId = `${result.id}_${cfg.key}`;
        const data = result.series[cfg.key];
        if (!data) continue;

        usedIds.add(seriesId);

        let series = overlayLinesRef.current.get(seriesId);
        if (!series) {
          series = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: 1,
            priceScaleId: 'right',
          });
          overlayLinesRef.current.set(seriesId, series);
        }

        const lineData: LineData[] = [];
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (v != null) {
            lineData.push({ time: candles[i].time as Time, value: v });
          }
        }
        series.setData(lineData);
      }
    }

    // Remove unused overlay series
    for (const [id, series] of overlayLinesRef.current) {
      if (!usedIds.has(id)) {
        chart.removeSeries(series);
        overlayLinesRef.current.delete(id);
      }
    }
  }, [overlays, candles, actives]);

  // Sync indicator panes (separate indicators)
  useEffect(() => {
    if (!panesRef.current || candles.length === 0) return;

    const panesContainer = panesRef.current;
    const existingPanes = indicatorPanesRef.current;
    const activeIds = new Set(separates.map((r) => r.id));

    // Create/update indicator panes
    for (const result of separates) {
      const active = actives.find((a) => a.id === result.id);
      if (!active) continue;

      let entry = existingPanes.get(result.id);

      if (!entry) {
        const container = document.createElement('div');
        container.style.width = '100%';
        container.style.height = `${INDICATOR_PANE_HEIGHT}px`;
        panesContainer.appendChild(container);

        const chart = createChart(container, {
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
            vertLine: { color: CHART_COLORS.crosshair, labelVisible: false },
            horzLine: { color: CHART_COLORS.crosshair, labelVisible: false },
          },
          rightPriceScale: { borderColor: '#D1D5DB' },
          timeScale: { borderColor: '#D1D5DB', visible: false },
          width: container.clientWidth,
          height: INDICATOR_PANE_HEIGHT,
        });

        // Sync time scale with main chart
        if (mainChartRef.current) {
          mainChartRef.current.timeScale().subscribeVisibleTimeRangeChange((range) => {
            if (range) {
              chart.timeScale().setVisibleRange(range);
            }
          });
        }

        entry = { chart, series: new Map(), container };
        existingPanes.set(result.id, entry);
      }

      // Update series data
      const usedSeriesIds = new Set<string>();
      for (const cfg of active.definition.display.series) {
        const seriesId = `${result.id}_${cfg.key}`;
        const data = result.series[cfg.key];
        if (!data) continue;

        usedSeriesIds.add(seriesId);

        let series = entry.series.get(seriesId);
        if (!series) {
          if (cfg.type === 'histogram') {
            const s = entry.chart.addSeries(HistogramSeries, { color: cfg.color });
            entry.series.set(seriesId, s as ISeriesApi<'Line' | 'Histogram'>);
          } else {
            const s = entry.chart.addSeries(LineSeries, { color: cfg.color, lineWidth: 1 });
            entry.series.set(seriesId, s as ISeriesApi<'Line' | 'Histogram'>);
          }
          series = entry.series.get(seriesId);
        }

        if (!series) continue;

        const chartData: LineData[] = [];
        for (let i = 0; i < data.length; i++) {
          const v = data[i];
          if (v != null) {
            chartData.push({ time: candles[i].time as Time, value: v });
          }
        }

        if (cfg.type === 'histogram') {
          (series as ISeriesApi<'Histogram'>).setData(chartData);
        } else {
          (series as ISeriesApi<'Line'>).setData(chartData);
        }
      }

      // Remove unused series in this pane
      for (const [sid, s] of entry.series) {
        if (!usedSeriesIds.has(sid)) {
          entry.chart.removeSeries(s);
          entry.series.delete(sid);
        }
      }
    }

    // Remove panes for inactive indicators
    for (const [id, entry] of existingPanes) {
      if (!activeIds.has(id)) {
        entry.chart.remove();
        entry.container.remove();
        existingPanes.delete(id);
      }
    }
  }, [separates, candles, actives]);

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div ref={mainRef} style={{ flex: '1 1 60%', minHeight: 0 }} />
      <div
        ref={panesRef}
        style={{ flex: '0 0 auto', overflow: 'auto', maxHeight: '40%' }}
      />
      <CandleDetail />
    </div>
  );
}
