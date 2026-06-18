import { useEffect, useLayoutEffect, useRef, useMemo, useState } from 'react';
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
  type MouseEventParams,
  type Time,
  type IRange,
  CrosshairMode,
  ColorType,
} from 'lightweight-charts';
import { useCandleStore } from '@/stores/useCandleStore';
import { useIndicatorStore } from '@/stores/useIndicatorStore';
import { useChartStore } from '@/stores/useChartStore';
import { calculateAllIndicators } from '@/features/indicators/calculator';
import type { IndicatorResult } from '@/models';
import { isWeekend } from '@/utils/date';
import {
  CHART_COLORS,
  INDICATOR_PANE_HEIGHT,
  MAIN_CHART_MIN_HEIGHT,
  VOLUME_PRICE_FORMAT,
  calculateMainChartHeight,
  getMacdHistogramColor,
} from './chartConfig';
import CandleDetail from './CandleDetail';

interface IndicatorPaneEntry {
  chart: IChartApi;
  series: Map<string, ISeriesApi<'Line' | 'Histogram'>>;
  container: HTMLDivElement;
  unsubscribeRange?: () => void;
  unsubscribeCrosshair?: () => void;
}

export default function ChartContainer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayLinesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const indicatorPanesRef = useRef<Map<string, IndicatorPaneEntry>>(new Map());
  const [mainChartHeight, setMainChartHeight] = useState(MAIN_CHART_MIN_HEIGHT);

  const candles = useCandleStore((s) => s.candles);
  const actives = useIndicatorStore((s) => s.actives);
  const candlesRef = useRef(candles);
  const activesRef = useRef(actives);
  const indicatorResultsRef = useRef<IndicatorResult[]>([]);
  const setCrosshairTime = useChartStore((s) => s.setCrosshairTime);
  const setCrosshairData = useChartStore((s) => s.setCrosshairData);
  const setCrosshairIndicators = useChartStore((s) => s.setCrosshairIndicators);

  const indicatorResults = useMemo(
    () => calculateAllIndicators(candles, actives),
    [candles, actives],
  );

  // Lightweight Charts consumes wheel events for time-scale zooming. When the
  // indicator stack is taller than its viewport, reserve an unmodified vertical
  // wheel for browsing panes; Ctrl/Cmd + wheel keeps the chart zoom gesture.
  useEffect(() => {
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (scrollContainer.scrollHeight <= scrollContainer.clientHeight) return;

      const maxScrollTop = scrollContainer.scrollHeight - scrollContainer.clientHeight;
      const canScrollUp = event.deltaY < 0 && scrollContainer.scrollTop > 0;
      const canScrollDown = event.deltaY > 0 && scrollContainer.scrollTop < maxScrollTop;
      if (!canScrollUp && !canScrollDown) return;

      event.preventDefault();
      event.stopPropagation();
      scrollContainer.scrollTop += event.deltaY;
    };

    scrollContainer.addEventListener('wheel', onWheel, {
      capture: true,
      passive: false,
    });
    return () => scrollContainer.removeEventListener('wheel', onWheel, true);
  }, []);

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
  candlesRef.current = candles;
  activesRef.current = actives;
  indicatorResultsRef.current = indicatorResults;

  const clearCrosshairDetails = () => {
    setCrosshairTime(null);
    setCrosshairData(null);
    setCrosshairIndicators([]);
  };

  const publishCrosshairDetails = (timeStr: string): number | null => {
    const currentCandles = candlesRef.current;
    const index = currentCandles.findIndex((candle) => candle.time === timeStr);
    if (index < 0) return null;

    const candle = currentCandles[index];
    const previousCandle = index > 0 ? currentCandles[index - 1] : undefined;
    const canCalculateFromPrevious = previousCandle != null
      && previousCandle.close !== 0
      && !isWeekend(previousCandle.time);
    const calculatedChange = canCalculateFromPrevious
      ? candle.close - previousCandle.close
      : undefined;
    const change = calculatedChange ?? candle.change;
    const changePercent = calculatedChange != null && previousCandle != null
      ? (calculatedChange / previousCandle.close) * 100
      : candle.changePercent;

    setCrosshairTime(timeStr);
    setCrosshairData({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      change,
      changePercent,
      volume: candle.volume,
      turnover: candle.turnover,
    });

    const indicatorDetails = indicatorResultsRef.current.flatMap((result) => {
      const active = activesRef.current.find((item) => item.id === result.id);
      if (!active) return [];

      const values = active.definition.display.series.flatMap((seriesConfig) => {
        const value = result.series[seriesConfig.key]?.[index];
        const movingAverageSlot = Number(seriesConfig.key.match(/^(?:sma|ema)(\d+)$/)?.[1]);
        const movingAveragePeriod = Number.isInteger(movingAverageSlot)
          ? active.paramValues[`period${movingAverageSlot}`]
            ?? (movingAverageSlot === 1 ? active.paramValues.period : undefined)
          : undefined;
        const label = movingAveragePeriod != null
          ? `${seriesConfig.label}${movingAveragePeriod}`
          : seriesConfig.label;
        return value == null
          ? []
          : [{
            label,
            value,
            color: result.id === 'macd' && seriesConfig.key === 'histogram'
              ? getMacdHistogramColor(value)
              : seriesConfig.color,
          }];
      });

      return values.length > 0
        ? [{ id: result.id, name: active.definition.name, values }]
        : [];
    });
    setCrosshairIndicators(indicatorDetails);
    return index;
  };

  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const updateMainChartHeight = () => {
      const nextHeight = calculateMainChartHeight(viewport.clientHeight);
      setMainChartHeight((currentHeight) =>
        currentHeight === nextHeight ? currentHeight : nextHeight,
      );
    };

    updateMainChartHeight();
    const resizeObserver = new ResizeObserver(updateMainChartHeight);
    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, []);

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
      priceFormat: VOLUME_PRICE_FORMAT,
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volSeries;

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) {
        clearCrosshairDetails();
        for (const pane of indicatorPanesRef.current.values()) {
          pane.chart.clearCrosshairPosition();
        }
        return;
      }
      const timeStr = param.time as string;
      const index = publishCrosshairDetails(timeStr);
      if (index == null) return;

      for (const [indicatorId, pane] of indicatorPanesRef.current) {
        const result = indicatorResultsRef.current.find((item) => item.id === indicatorId);
        const active = activesRef.current.find((item) => item.id === indicatorId);
        if (!result || !active) continue;

        for (const seriesConfig of active.definition.display.series) {
          const value = result.series[seriesConfig.key]?.[index];
          const series = pane.series.get(`${indicatorId}_${seriesConfig.key}`);
          if (value != null && series) {
            pane.chart.setCrosshairPosition(value, param.time, series);
            break;
          }
        }
      }
    });

    mainChartRef.current = chart;

    const onResize = () => {
      if (mainChartRef.current && container.clientWidth && container.clientHeight) {
        mainChartRef.current.applyOptions({
          width: container.clientWidth,
          height: container.clientHeight,
        });
      }
      for (const pane of indicatorPanesRef.current.values()) {
        if (pane.container.clientWidth && pane.container.clientHeight) {
          pane.chart.applyOptions({
            width: pane.container.clientWidth,
            height: pane.container.clientHeight,
          });
        }
      }
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      for (const entry of indicatorPanesRef.current.values()) {
        entry.unsubscribeRange?.();
        entry.unsubscribeCrosshair?.();
        entry.chart.remove();
      }
      indicatorPanesRef.current.clear();
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
          const isVolumeSeries = cfg.priceScale === 'volume';
          series = chart.addSeries(LineSeries, {
            color: cfg.color,
            lineWidth: 1,
            priceScaleId: isVolumeSeries ? 'volume' : 'right',
            ...(isVolumeSeries ? { priceFormat: VOLUME_PRICE_FORMAT } : {}),
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
        container.style.flex = `0 0 ${INDICATOR_PANE_HEIGHT}px`;
        container.style.overflow = 'hidden';
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
        let unsubscribeRange: (() => void) | undefined;
        if (mainChartRef.current) {
          const mainTimeScale = mainChartRef.current.timeScale();
          const syncVisibleRange = (range: IRange<number> | null) => {
            if (range) {
              chart.timeScale().setVisibleLogicalRange(range);
            }
          };
          mainTimeScale.subscribeVisibleLogicalRangeChange(syncVisibleRange);
          unsubscribeRange = () =>
            mainTimeScale.unsubscribeVisibleLogicalRangeChange(syncVisibleRange);
        }

        const handlePaneCrosshairMove = (param: MouseEventParams<Time>) => {
          if (!param.time || !param.point) return;
          publishCrosshairDetails(param.time as string);
        };
        chart.subscribeCrosshairMove(handlePaneCrosshairMove);
        const unsubscribeCrosshair = () =>
          chart.unsubscribeCrosshairMove(handlePaneCrosshairMove);

        entry = {
          chart,
          series: new Map(),
          container,
          unsubscribeRange,
          unsubscribeCrosshair,
        };
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

        if (cfg.type === 'histogram') {
          const chartData: HistogramData[] = [];
          for (let i = 0; i < data.length; i++) {
            const value = data[i];
            if (value != null) {
              chartData.push({
                time: candles[i].time as Time,
                value,
                color: result.id === 'macd' && cfg.key === 'histogram'
                  ? getMacdHistogramColor(value)
                  : cfg.color,
              });
            }
          }
          (series as ISeriesApi<'Histogram'>).setData(chartData);
        } else {
          const chartData: LineData[] = [];
          for (let i = 0; i < data.length; i++) {
            const value = data[i];
            if (value != null) {
              chartData.push({ time: candles[i].time as Time, value });
            }
          }
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

      const currentLogicalRange = mainChartRef.current
        ?.timeScale()
        .getVisibleLogicalRange();
      if (currentLogicalRange && usedSeriesIds.size > 0) {
        entry.chart.timeScale().setVisibleLogicalRange(currentLogicalRange);
      }
    }

    // Remove panes for inactive indicators
    for (const [id, entry] of existingPanes) {
      if (!activeIds.has(id)) {
        entry.unsubscribeRange?.();
        entry.unsubscribeCrosshair?.();
        entry.chart.remove();
        entry.container.remove();
        existingPanes.delete(id);
      }
    }
  }, [separates, candles, actives]);

  return (
    <div
      ref={scrollRef}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflowX: 'hidden',
        overflowY: 'auto',
        scrollbarGutter: 'stable',
        overscrollBehavior: 'contain',
      }}
    >
      <div
        ref={mainRef}
        style={{
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: `${mainChartHeight}px`,
          height: mainChartHeight,
          minHeight: MAIN_CHART_MIN_HEIGHT,
          overflow: 'hidden',
        }}
      />
      <div
        ref={panesRef}
        style={{
          display: 'flex',
          flexDirection: 'column',
          flex: '0 0 auto',
          width: '100%',
          overflow: 'hidden',
        }}
      />
      <CandleDetail />
    </div>
  );
}
