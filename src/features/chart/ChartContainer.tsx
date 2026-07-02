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
import { useBacktestStore } from '@/stores/useBacktestStore';
import { calculateAllIndicators } from '@/features/indicators/calculator';
import type { IndicatorResult, StrategySignal } from '@/models';
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
import { RangeLinePrimitive } from './RangeLinePrimitive';

interface IndicatorPaneEntry {
  chart: IChartApi;
  series: Map<string, ISeriesApi<'Line' | 'Histogram'>>;
  container: HTMLDivElement;
  unsubscribeRange?: () => void;
  unsubscribeCrosshair?: () => void;
}

interface ChartContainerProps {
  showRangeLines?: boolean;
}

export default function ChartContainer({ showRangeLines = false }: ChartContainerProps) {
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
  const signals = useBacktestStore((s) => s.signals);
  const candlesRef = useRef(candles);
  const activesRef = useRef(actives);
  const indicatorResultsRef = useRef<IndicatorResult[]>([]);
  const setCrosshairTime = useChartStore((s) => s.setCrosshairTime);
  const setCrosshairData = useChartStore((s) => s.setCrosshairData);
  const setCrosshairIndicators = useChartStore((s) => s.setCrosshairIndicators);
  const setVisibleRange = useChartStore((s) => s.setVisibleRange);
  const setRangeLineState = useChartStore((s) => s.setRangeLineState);
  const rangeLineDragging = useChartStore((s) => s.rangeLineDragging);
  const visibleRangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeLineRef = useRef<RangeLinePrimitive | null>(null);
  const rangeLineHoveredRef = useRef<'start' | 'end' | null>(null);

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

  // End range-line dragging when the pointer is released anywhere on the page.
  useEffect(() => {
    const onMouseUp = () => {
      if (rangeLineRef.current?.getDragging()) {
        rangeLineRef.current.setDragging(null);
      }
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => document.removeEventListener('mouseup', onMouseUp);
  }, []);

  // Initialize range lines from first/last candle if not yet set
  useEffect(() => {
    const rl = rangeLineRef.current;
    if (!rl || candles.length < 2) return;
    if (rl.getStartTime() && rl.getEndTime()) return;

    const total = candles.length;
    const startIdx = Math.floor(total * 0.2);
    const endIdx = Math.floor(total * 0.8);
    rl.setStartTime(candles[startIdx].time);
    rl.setEndTime(candles[endIdx].time);
    setRangeLineState({
      startTime: candles[startIdx].time,
      endTime: candles[endIdx].time,
      dragging: null,
    });
  }, [candles]);

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
  // Respect pane count in ResizeObserver callbacks without stale closures
  const separatesCountRef = useRef(0);
  separatesCountRef.current = separates.length;

  // Recalculate main chart height when viewport resizes
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;

    const updateHeight = () => {
      const next = calculateMainChartHeight(
        viewport.clientHeight,
        separatesCountRef.current,
      );
      setMainChartHeight((prev) => prev === next ? prev : next);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // Recalculate when pane count changes
  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const next = calculateMainChartHeight(
      viewport.clientHeight,
      separates.length,
    );
    setMainChartHeight((prev) => prev === next ? prev : next);
  }, [separates.length]);

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
      turnoverRatePct: candle.turnoverRatePct,
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

    let handleRangeMouseDown: ((event: MouseEvent) => void) | undefined;

    // Attach draggable range lines (only on chart page, not backtest)
    if (showRangeLines) {
      const rangeLine = new RangeLinePrimitive();
      rangeLineRef.current = rangeLine;
      rangeLine.onChange = (state) => {
        setRangeLineState(state);
      };
      candleSeries.attachPrimitive(rangeLine);

      // The chart primitive is attached after the earlier initialization effect
      // runs. When candles are already loaded on mount, initialize here as well
      // so the selector cannot remain invisible until the dataset changes.
      const currentCandles = candlesRef.current;
      if (currentCandles.length >= 2) {
        const startCandle = currentCandles[Math.floor(currentCandles.length * 0.2)];
        const endCandle = currentCandles[Math.floor(currentCandles.length * 0.8)];
        rangeLine.setStartTime(startCandle.time);
        rangeLine.setEndTime(endCandle.time);
        setRangeLineState({
          startTime: startCandle.time,
          endTime: endCandle.time,
          dragging: null,
        });
      }

      handleRangeMouseDown = (event: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const hit = rangeLine.hitTest(event.clientX - rect.left, event.clientY - rect.top);
        if (!hit) return;

        const which = hit.externalId === 'range-line-start' ? 'start' : 'end';
        rangeLine.setDragging(which);
        event.preventDefault();
        event.stopPropagation();
      };
      container.addEventListener('mousedown', handleRangeMouseDown, true);
    }

    chart.subscribeCrosshairMove((param) => {
      // Range line drag handling
      const rl = rangeLineRef.current;
      if (rl) {
        if (rl.getDragging() && param.point) {
          const newTime = chart.timeScale().coordinateToTime(param.point.x);
          if (newTime) {
            const timeStr = String(newTime);
            const otherEnd = rl.getDragging() === 'start' ? rl.getEndTime() : rl.getStartTime();
            // Enforce order: start < end
            if (rl.getDragging() === 'start' && otherEnd && timeStr >= otherEnd) {
              // clamped
            } else if (rl.getDragging() === 'end' && otherEnd && timeStr <= otherEnd) {
              // clamped
            } else {
              if (rl.getDragging() === 'start') rl.setStartTime(timeStr);
              else rl.setEndTime(timeStr);
            }
          }
        }
        // Update hovered state
        if (param.point) {
          const hit = rl.hitTest(param.point.x, param.point.y);
          const newHovered = hit ? (hit.externalId === 'range-line-start' ? 'start' : 'end') : null;
          if (newHovered !== rangeLineHoveredRef.current) {
            rangeLineHoveredRef.current = newHovered;
            rl.setHovered(newHovered);
          }
        }
      }

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

    const handleVisibleRangeChange = (range: IRange<number> | null) => {
      if (visibleRangeTimerRef.current) {
        clearTimeout(visibleRangeTimerRef.current);
      }
      visibleRangeTimerRef.current = setTimeout(() => {
        const currentCandles = candlesRef.current;
        if (!range || currentCandles.length === 0) {
          setVisibleRange(null);
          return;
        }
        const fromIdx = Math.max(0, Math.floor(range.from));
        const toIdx = Math.min(currentCandles.length - 1, Math.ceil(range.to));
        if (fromIdx <= toIdx) {
          setVisibleRange({
            from: currentCandles[fromIdx].time,
            to: currentCandles[toIdx].time,
          });
        }
      }, 150);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRangeChange);

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
      if (visibleRangeTimerRef.current) clearTimeout(visibleRangeTimerRef.current);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      if (handleRangeMouseDown) {
        container.removeEventListener('mousedown', handleRangeMouseDown, true);
      }
      setVisibleRange(null);
      if (rangeLineRef.current) {
        candleSeries.detachPrimitive(rangeLineRef.current);
        rangeLineRef.current = null;
      }
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

  // Signal markers on candlestick chart
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || candles.length === 0) return;

    try {
      const activeSignals = signals.filter((s) => s.action !== 'hold');
      if (activeSignals.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (series as any).setMarkers?.([]);
        return;
      }

      const markers = activeSignals.map((s: StrategySignal) => ({
        time: s.time as Time,
        position: s.action === 'buy' ? 'belowBar' : 'aboveBar',
        color: s.action === 'buy' ? '#22C55E' : '#EF4444',
        shape: s.action === 'buy' ? 'arrowUp' : 'arrowDown',
        text: s.action === 'buy' ? 'B' : 'S',
        size: 2,
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (series as any).setMarkers?.(markers);
    } catch {
      // setMarkers may not be available in all lightweight-charts versions
    }
  }, [signals, candles]);

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
