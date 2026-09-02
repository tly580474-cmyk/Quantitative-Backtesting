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
import { aggregateCandles, type ChartPeriod } from './timeframe';
import { calculateChipDistribution } from '@/features/marketData/chipDistribution';
import ChipProfile from '@/features/marketData/ChipProfile';
import { analyzeChanlun } from '@/features/chanlun';
import { ChanStructurePrimitive } from './ChanStructurePrimitive';
import { chartTimeKey, toChartTime } from './chartTime';
import type { Candle } from '@/models';
import { getChartSurfaceColors } from '@/theme';
import { DrawingPrimitive } from './drawing/DrawingPrimitive';
import type { Drawing, DrawingDraft, DrawingPoint, DrawingTool } from './drawing/types';
import { useDrawingStore } from '@/stores/useDrawingStore';

interface IndicatorPaneEntry {
  chart: IChartApi;
  series: Map<string, ISeriesApi<'Line' | 'Histogram'>>;
  container: HTMLDivElement;
  unsubscribeRange?: () => void;
  unsubscribeCrosshair?: () => void;
}

interface ChartContainerProps {
  sourceCandles?: readonly Candle[];
  drawingContextKey?: string;
  showRangeLines?: boolean;
  period?: ChartPeriod;
  showChipProfile?: boolean;
  showChanPens?: boolean;
  showChanFractals?: boolean;
  showChanSegments?: boolean;
  showChanPenCenters?: boolean;
  showChanSegmentCenters?: boolean;
}

function drawingPointAt(
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  candles: readonly Candle[],
  x: number,
  y: number,
): DrawingPoint | null {
  if (candles.length === 0) return null;
  const logical = chart.timeScale().coordinateToLogical(x);
  const price = series.coordinateToPrice(y);
  if (logical == null || price == null || !Number.isFinite(price)) return null;
  const index = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
  return { time: candles[index].time, price };
}

function parseDrawingHit(externalId: string): {
  id: string;
  part: 'anchor' | 'body' | 'stroke';
  anchorIndex?: number;
} | null {
  const match = externalId.match(/^drawing-(.+?)-(anchor)-(\d+)$/);
  if (match) return { id: match[1], part: 'anchor', anchorIndex: Number(match[3]) };
  const body = externalId.match(/^drawing-(.+?)-(body|stroke)$/);
  return body ? { id: body[1], part: body[2] as 'body' | 'stroke' } : null;
}

function nearestCandleIndex(
  chart: IChartApi,
  candles: readonly Candle[],
  x: number,
): number | null {
  if (candles.length === 0) return null;
  const logical = chart.timeScale().coordinateToLogical(x);
  if (logical == null || !Number.isFinite(logical)) return null;
  return Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
}

function rectangleCorners(points: readonly DrawingPoint[], chart: IChartApi, series: ISeriesApi<'Candlestick'>): DrawingPoint[] {
  if (points.length < 2) return [...points];
  const firstX = chart.timeScale().timeToCoordinate(toChartTime(points[0].time));
  const secondX = chart.timeScale().timeToCoordinate(toChartTime(points[1].time));
  const firstY = series.priceToCoordinate(points[0].price);
  const secondY = series.priceToCoordinate(points[1].price);
  if (firstX == null || secondX == null || firstY == null || secondY == null) return [...points];
  const leftTime = firstX <= secondX ? points[0].time : points[1].time;
  const rightTime = firstX <= secondX ? points[1].time : points[0].time;
  const topPrice = firstY <= secondY ? points[0].price : points[1].price;
  const bottomPrice = firstY <= secondY ? points[1].price : points[0].price;
  return [
    { time: leftTime, price: topPrice },
    { time: rightTime, price: topPrice },
    { time: rightTime, price: bottomPrice },
    { time: leftTime, price: bottomPrice },
  ];
}

function shiftDrawingPoints(
  drawing: Drawing,
  startPoint: DrawingPoint,
  currentPoint: DrawingPoint,
  candles: readonly Candle[],
): DrawingPoint[] {
  const priceDelta = currentPoint.price - startPoint.price;
  if (drawing.type === 'horizontal') {
    return drawing.points.map((point) => ({ ...point, price: point.price + priceDelta }));
  }
  const startIndex = candles.findIndex((candle) => candle.time === startPoint.time);
  const currentIndex = candles.findIndex((candle) => candle.time === currentPoint.time);
  if (startIndex < 0 || currentIndex < 0) {
    return drawing.points.map((point) => ({ ...point, price: point.price + priceDelta }));
  }
  const indexDelta = currentIndex - startIndex;
  return drawing.points.map((point) => {
    const index = candles.findIndex((candle) => candle.time === point.time);
    const nextIndex = index < 0
      ? -1
      : Math.max(0, Math.min(candles.length - 1, index + indexDelta));
    return {
      time: nextIndex >= 0 ? candles[nextIndex].time : point.time,
      price: point.price + priceDelta,
    };
  });
}

export default function ChartContainer({
  sourceCandles: sourceCandlesOverride,
  drawingContextKey,
  showRangeLines = false,
  period = 'day',
  showChipProfile = false,
  showChanPens = false,
  showChanFractals = false,
  showChanSegments = false,
  showChanPenCenters = false,
  showChanSegmentCenters = false,
}: ChartContainerProps) {
  const chartSurface = useMemo(() => getChartSurfaceColors(), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const mainChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const overlayLinesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const indicatorPanesRef = useRef<Map<string, IndicatorPaneEntry>>(new Map());
  const [mainChartHeight, setMainChartHeight] = useState(MAIN_CHART_MIN_HEIGHT);

  const storedCandles = useCandleStore((s) => s.candles);
  const sourceCandles = sourceCandlesOverride ?? storedCandles;
  const candles = useMemo(
    () => aggregateCandles(sourceCandles, period),
    [period, sourceCandles],
  );
  const actives = useIndicatorStore((s) => s.actives);
  const signals = useBacktestStore((s) => s.signals);
  const candlesRef = useRef(candles);
  const sourceCandlesRef = useRef(sourceCandles);
  const periodRef = useRef(period);
  const showChipProfileRef = useRef(showChipProfile);
  const activesRef = useRef(actives);
  const indicatorResultsRef = useRef<IndicatorResult[]>([]);
  const setCrosshairTime = useChartStore((s) => s.setCrosshairTime);
  const setCrosshairData = useChartStore((s) => s.setCrosshairData);
  const setCrosshairIndicators = useChartStore((s) => s.setCrosshairIndicators);
  const setVisibleRange = useChartStore((s) => s.setVisibleRange);
  const setRangeLineState = useChartStore((s) => s.setRangeLineState);
  const rangeLineDragging = useChartStore((s) => s.rangeLineDragging);
  const drawings = useDrawingStore((s) => s.drawings);
  const drawingDraft = useDrawingStore((s) => s.draft);
  const drawingSelectedId = useDrawingStore((s) => s.selectedId);
  const drawingTool = useDrawingStore((s) => s.tool);
  const setDrawingContextKey = useDrawingStore((s) => s.setContextKey);
  const setDrawingDraft = useDrawingStore((s) => s.setDraft);
  const clearDrawingDraft = useDrawingStore((s) => s.clearDraft);
  const setDrawingSelectedId = useDrawingStore((s) => s.setSelectedId);
  const addDrawing = useDrawingStore((s) => s.add);
  const updateDrawing = useDrawingStore((s) => s.update);
  const visibleRangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeLineRef = useRef<RangeLinePrimitive | null>(null);
  const drawingPrimitiveRef = useRef<DrawingPrimitive | null>(null);
  const chanStructureRef = useRef<ChanStructurePrimitive | null>(null);
  const rangeLineHoveredRef = useRef<'start' | 'end' | null>(null);
  const drawingToolRef = useRef<DrawingTool>(drawingTool);
  drawingToolRef.current = drawingTool;
  const drawingEnabled = Boolean(drawingContextKey);
  const drawingEnabledRef = useRef(drawingEnabled);
  drawingEnabledRef.current = drawingEnabled;
  const drawingsRef = useRef<readonly Drawing[]>(drawings);
  const drawingDraftRef = useRef<DrawingDraft | null>(drawingDraft);
  drawingsRef.current = drawings;
  drawingDraftRef.current = drawingDraft;
  const drawingPreviewRef = useRef<readonly Drawing[] | null>(null);
  const drawingDragRef = useRef<{
    id: string;
    part: 'anchor' | 'body' | 'stroke';
    anchorIndex?: number;
    pointerId: number;
    startPoint: DrawingPoint;
    points: DrawingPoint[];
  } | null>(null);
  const chipPriceToCoordinateRef = useRef<((price: number) => number | null) | null>(null);
  const [chipChartLayout, setChipChartLayout] = useState({ height: 0, revision: 0 });
  const [chipEndIndex, setChipEndIndex] = useState(-1);

  useEffect(() => {
    if (drawingContextKey != null) setDrawingContextKey(drawingContextKey);
  }, [drawingContextKey, setDrawingContextKey]);

  useEffect(() => {
    const primitive = drawingPrimitiveRef.current;
    if (!primitive) return;
    primitive.setDrawings(drawingEnabled ? drawingPreviewRef.current ?? drawings : []);
    primitive.setDraft(drawingEnabled ? drawingDraft : null);
    primitive.setSelectedDrawing(drawingEnabled ? drawingSelectedId : null);
  }, [drawingDraft, drawingEnabled, drawingSelectedId, drawings]);

  useEffect(() => {
    const chart = mainChartRef.current;
    if (!chart) return;
    const enabled = !drawingEnabled || drawingTool === 'select';
    chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
  }, [drawingEnabled, drawingTool]);

  const indicatorResults = useMemo(
    () => calculateAllIndicators(candles, actives),
    [candles, actives],
  );
  const chanAnalysis = useMemo(
    () => analyzeChanlun(candles),
    [candles],
  );
  const confirmedPenCount = chanAnalysis.pens.filter((pen) => pen.status === 'confirmed').length;
  const candidatePenCount = chanAnalysis.pens.length - confirmedPenCount;
  const confirmedSegmentCount = chanAnalysis.segments.filter((segment) => segment.status === 'confirmed').length;
  const candidateSegmentCount = chanAnalysis.segments.length - confirmedSegmentCount;
  const confirmedPenCenterCount = chanAnalysis.penCenters.filter((center) => center.status === 'confirmed').length;
  const candidatePenCenterCount = chanAnalysis.penCenters.length - confirmedPenCenterCount;
  const confirmedSegmentCenterCount = chanAnalysis.segmentCenters.filter((center) => center.status === 'confirmed').length;
  const candidateSegmentCenterCount = chanAnalysis.segmentCenters.length - confirmedSegmentCenterCount;
  const latestPenCenter = chanAnalysis.penCenters[chanAnalysis.penCenters.length - 1];
  const latestSegmentCenter = chanAnalysis.segmentCenters[chanAnalysis.segmentCenters.length - 1];
  const effectiveChipEndIndex = chipEndIndex >= 0
    ? Math.min(chipEndIndex, sourceCandles.length - 1)
    : sourceCandles.length - 1;
  const chipAsOfDate = sourceCandles[effectiveChipEndIndex]?.time ?? null;
  const chipDistribution = useMemo(() => {
    if (!showChipProfile || period !== 'day' || effectiveChipEndIndex < 0) return null;
    return calculateChipDistribution(
      sourceCandles.slice(0, effectiveChipEndIndex + 1).map((candle) => ({
        date: candle.time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume ?? 0,
        turnoverRatePct: candle.turnoverRatePct,
      })),
    );
  }, [effectiveChipEndIndex, period, showChipProfile, sourceCandles]);

  useEffect(() => {
    setChipEndIndex(sourceCandles.length - 1);
  }, [sourceCandles]);

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
  sourceCandlesRef.current = sourceCandles;
  periodRef.current = period;
  showChipProfileRef.current = showChipProfile;
  activesRef.current = actives;
  indicatorResultsRef.current = indicatorResults;

  const clearCrosshairDetails = () => {
    setCrosshairTime(null);
    setCrosshairData(null);
    setCrosshairIndicators([]);
    if (showChipProfileRef.current && periodRef.current === 'day') {
      setChipEndIndex(sourceCandlesRef.current.length - 1);
    }
  };

  const publishCrosshairDetails = (time: Time): number | null => {
    const currentCandles = candlesRef.current;
    const key = chartTimeKey(time);
    const index = currentCandles.findIndex((candle) => chartTimeKey(toChartTime(candle.time)) === key);
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

    setCrosshairTime(candle.time);
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
    if (showChipProfileRef.current && periodRef.current === 'day') {
      setChipEndIndex(index);
    }
    return index;
  };

  // Create main chart (once)
  useEffect(() => {
    if (!mainRef.current) return;
    const container = mainRef.current;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: chartSurface.background },
        textColor: chartSurface.text,
      },
      grid: {
        vertLines: { color: chartSurface.grid },
        horzLines: { color: chartSurface.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: chartSurface.crosshair, labelVisible: false },
        horzLine: { color: chartSurface.crosshair, labelVisible: false },
      },
      rightPriceScale: {
        borderColor: chartSurface.border,
        scaleMargins: { top: 0.05, bottom: 0.25 },
      },
      timeScale: {
        borderColor: chartSurface.border,
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: !drawingEnabledRef.current || drawingToolRef.current === 'select',
      handleScale: !drawingEnabledRef.current || drawingToolRef.current === 'select',
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
    chipPriceToCoordinateRef.current = (price) => candleSeries.priceToCoordinate(price);
    const publishChipLayout = () => {
      setChipChartLayout((current) => ({
        height: container.clientHeight,
        revision: current.revision + 1,
      }));
    };
    publishChipLayout();

    const volSeries = chart.addSeries(HistogramSeries, {
      priceScaleId: 'volume',
      color: CHART_COLORS.volume,
      priceFormat: VOLUME_PRICE_FORMAT,
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });
    volumeSeriesRef.current = volSeries;

    const chanStructure = new ChanStructurePrimitive();
    chanStructureRef.current = chanStructure;
    candleSeries.attachPrimitive(chanStructure);

    const drawingPrimitive = new DrawingPrimitive();
    drawingPrimitiveRef.current = drawingPrimitive;
    drawingPrimitive.setDrawings(drawingEnabledRef.current ? drawingsRef.current : []);
    drawingPrimitive.setDraft(drawingEnabledRef.current ? drawingDraftRef.current : null);
    drawingPrimitive.setSelectedDrawing(drawingEnabledRef.current ? useDrawingStore.getState().selectedId : null);
    candleSeries.attachPrimitive(drawingPrimitive);

    // Keep the range primitive attached for the lifetime of the chart. Enabling
    // the range tool now only supplies/clears its endpoints, so the chart and its
    // current logical viewport never need to be remounted.
    const rangeLine = new RangeLinePrimitive();
    rangeLineRef.current = rangeLine;
    rangeLine.onChange = (state) => {
      setRangeLineState(state);
    };
    candleSeries.attachPrimitive(rangeLine);

    const handleRangeMouseDown = (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      if (drawingToolRef.current !== 'select') return;
      const hit = rangeLine.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (!hit) return;

      const which = hit.externalId === 'range-line-start' ? 'start' : 'end';
      rangeLine.setDragging(which);
      event.preventDefault();
      event.stopPropagation();
    };
    container.addEventListener('mousedown', handleRangeMouseDown, true);

    const pointFromPointerEvent = (event: PointerEvent): { x: number; y: number; point: DrawingPoint | null } => {
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { x, y, point: drawingPointAt(chart, candleSeries, candlesRef.current, x, y) };
    };
    const updateChartInteraction = () => {
      const enabled = !drawingEnabledRef.current
        || (drawingToolRef.current === 'select' && drawingDragRef.current == null);
      chart.applyOptions({ handleScroll: enabled, handleScale: enabled });
    };
    const drawingById = (id: string) => drawingsRef.current.find((drawing) => drawing.id === id);
    const setDrawingPreview = (id: string, points: DrawingPoint[]) => {
      const preview = drawingsRef.current.map((drawing) => drawing.id === id
        ? { ...drawing, points }
        : drawing);
      drawingPreviewRef.current = preview;
      drawingPrimitive.setDrawings(preview);
    };
    const finishDrawingDrag = (event?: PointerEvent, cancelled = false) => {
      const drag = drawingDragRef.current;
      if (!drag || (event && event.pointerId !== drag.pointerId)) return;
      const preview = drawingPreviewRef.current;
      if (!cancelled && preview) {
        const updated = preview.find((drawing) => drawing.id === drag.id);
        if (updated) updateDrawing(drag.id, { points: updated.points });
      }
      drawingPreviewRef.current = null;
      drawingDragRef.current = null;
      drawingPrimitive.setDrawings(drawingsRef.current);
      if (event && container.hasPointerCapture(event.pointerId)) container.releasePointerCapture(event.pointerId);
      updateChartInteraction();
    };
    const handleDrawingPointerDown = (event: PointerEvent) => {
      if (!drawingEnabledRef.current) return;
      const tool = drawingToolRef.current;
      const { x, y, point } = pointFromPointerEvent(event);
      if (x < 0 || y < 0 || x > container.clientWidth || y > container.clientHeight) return;

      if (tool !== 'select') {
        if (!point) return;
        if (rangeLine.getDragging()) rangeLine.setDragging(null);
        const draft = drawingDraftRef.current;
        if (tool === 'horizontal') {
          addDrawing({ type: 'horizontal', points: [point] });
          drawingDraftRef.current = null;
          drawingPrimitive.setDraft(null);
        } else if (draft?.type === tool && draft.points.length > 0) {
          addDrawing({ type: tool, points: [draft.points[0], point] });
          drawingDraftRef.current = null;
          drawingPrimitive.setDraft(null);
        } else {
          const nextDraft: DrawingDraft = { type: tool, points: [point] };
          drawingDraftRef.current = nextDraft;
          setDrawingDraft(nextDraft);
          drawingPrimitive.setDraft(nextDraft);
        }
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const hit = parseDrawingHit(drawingPrimitive.hitTest(x, y)?.externalId ?? '');
      if (!hit) {
        setDrawingSelectedId(null);
        return;
      }
      const drawing = drawingById(hit.id);
      if (!drawing || !point) return;
      setDrawingSelectedId(hit.id);
      drawingDragRef.current = {
        id: hit.id,
        part: hit.part,
        anchorIndex: hit.anchorIndex,
        pointerId: event.pointerId,
        startPoint: point,
        points: drawing.points.map((item) => ({ ...item })),
      };
      drawingPreviewRef.current = null;
      chart.applyOptions({ handleScroll: false, handleScale: false });
      try { container.setPointerCapture(event.pointerId); } catch { /* unsupported in test DOM */ }
      event.preventDefault();
      event.stopPropagation();
    };
    const handleDrawingPointerMove = (event: PointerEvent) => {
      if (!drawingEnabledRef.current) return;
      const { x, y, point } = pointFromPointerEvent(event);
      if (x < 0 || y < 0 || x > container.clientWidth || y > container.clientHeight) return;
      const drag = drawingDragRef.current;
      if (drag && point) {
        const drawing = drawingsRef.current.find((item) => item.id === drag.id);
        if (!drawing) return;
        let nextPoints: DrawingPoint[];
        if (drag.part === 'anchor' && drag.anchorIndex != null) {
          if (drawing.type === 'rectangle') {
            const corners = rectangleCorners(drag.points, chart, candleSeries);
            const opposite = corners[(drag.anchorIndex + 2) % corners.length];
            nextPoints = opposite ? [point, opposite] : drag.points.map((item) => ({ ...item }));
          } else {
            nextPoints = drag.points.map((item, index) => index === drag.anchorIndex ? point : { ...item });
          }
        } else {
          nextPoints = shiftDrawingPoints(drawing, drag.startPoint, point, candlesRef.current);
        }
        setDrawingPreview(drag.id, nextPoints);
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (drawingToolRef.current !== 'select') {
        const draft = drawingDraftRef.current;
        if (draft && draft.points.length > 0 && point) {
          drawingPrimitive.setDraft({ ...draft, previewPoint: point });
        }
      }
    };
    const handleDrawingPointerUp = (event: PointerEvent) => finishDrawingDrag(event);
    const handleDrawingPointerCancel = (event: PointerEvent) => finishDrawingDrag(event, true);
    const handleDrawingPointerLeave = () => {
      if (drawingToolRef.current !== 'select' && drawingDraftRef.current) {
        drawingPrimitive.setDraft(drawingDraftRef.current);
      }
    };
    container.addEventListener('pointerdown', handleDrawingPointerDown, true);
    container.addEventListener('pointermove', handleDrawingPointerMove, true);
    container.addEventListener('pointerleave', handleDrawingPointerLeave, true);
    document.addEventListener('pointerup', handleDrawingPointerUp, true);
    document.addEventListener('pointercancel', handleDrawingPointerCancel, true);

    chart.subscribeCrosshairMove((param) => {
      // Range line drag handling
      const rl = rangeLineRef.current;
      if (rl) {
        if (rl.getDragging() && param.point) {
          const currentCandles = candlesRef.current;
          let timeStr: string | null = null;
          if (currentCandles.length > 0) {
            // 优先用逻辑索引匹配（分时与日K通用，避免 coordinateToTime 在分时下返回数字时间戳）
            const logical = chart.timeScale().coordinateToLogical(param.point.x);
            if (logical != null) {
              const idx = Math.max(0, Math.min(currentCandles.length - 1, Math.round(logical)));
              timeStr = currentCandles[idx].time;
            }
          }
          if (!timeStr) {
            // 回退：用 coordinateToTime + chartTimeKey 归一化
            const newTime = chart.timeScale().coordinateToTime(param.point.x);
            if (newTime) timeStr = chartTimeKey(newTime);
          }
          if (timeStr) {
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
      const index = publishCrosshairDetails(param.time);
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
      publishChipLayout();
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
      publishChipLayout();
    };
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (visibleRangeTimerRef.current) clearTimeout(visibleRangeTimerRef.current);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRangeChange);
      container.removeEventListener('mousedown', handleRangeMouseDown, true);
      container.removeEventListener('pointerdown', handleDrawingPointerDown, true);
      container.removeEventListener('pointermove', handleDrawingPointerMove, true);
      container.removeEventListener('pointerleave', handleDrawingPointerLeave, true);
      document.removeEventListener('pointerup', handleDrawingPointerUp, true);
      document.removeEventListener('pointercancel', handleDrawingPointerCancel, true);
      finishDrawingDrag(undefined, true);
      setVisibleRange(null);
      if (rangeLineRef.current) {
        candleSeries.detachPrimitive(rangeLineRef.current);
        rangeLineRef.current = null;
      }
      if (chanStructureRef.current) {
        candleSeries.detachPrimitive(chanStructureRef.current);
        chanStructureRef.current = null;
      }
      candleSeries.detachPrimitive(drawingPrimitive);
      drawingPrimitiveRef.current = null;
      for (const entry of indicatorPanesRef.current.values()) {
        entry.unsubscribeRange?.();
        entry.unsubscribeCrosshair?.();
        entry.chart.remove();
        entry.container.remove();
      }
      indicatorPanesRef.current.clear();
      chart.remove();
      chipPriceToCoordinateRef.current = null;
      mainChartRef.current = null;
      overlayLinesRef.current.clear();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const rangeLine = rangeLineRef.current;
    if (!rangeLine) return;
    if (!showRangeLines) {
      rangeLine.setDragging(null);
      rangeLine.setHovered(null);
      rangeLine.setStartTime(null);
      rangeLine.setEndTime(null);
      return;
    }
    if (candles.length < 2) return;
    const availableTimes = new Set(candles.map((candle) => candle.time));
    if (
      rangeLine.getStartTime()
      && rangeLine.getEndTime()
      && availableTimes.has(rangeLine.getStartTime()!)
      && availableTimes.has(rangeLine.getEndTime()!)
    ) return;
    // 优先取当前可见视口的中间 50% 作为初始区间，方便用户在缩放范围内选择
    let startIdx: number;
    let endIdx: number;
    const visibleLogical = mainChartRef.current?.timeScale().getVisibleLogicalRange();
    if (visibleLogical && Number.isFinite(visibleLogical.from) && Number.isFinite(visibleLogical.to)) {
      const visFrom = Math.max(0, Math.floor(visibleLogical.from));
      const visTo = Math.min(candles.length - 1, Math.ceil(visibleLogical.to));
      if (visTo - visFrom >= 1) {
        const visLen = visTo - visFrom;
        // 取可见范围的中间 50%
        startIdx = Math.max(0, Math.floor(visFrom + visLen * 0.25));
        endIdx = Math.min(candles.length - 1, Math.ceil(visFrom + visLen * 0.75));
      } else {
        startIdx = Math.floor(candles.length * 0.2);
        endIdx = Math.floor(candles.length * 0.8);
      }
    } else {
      // 回退：整个数据集的 20%-80%
      startIdx = Math.floor(candles.length * 0.2);
      endIdx = Math.floor(candles.length * 0.8);
    }
    if (startIdx >= endIdx) {
      // 极端边界情况保护
      startIdx = Math.max(0, Math.floor(candles.length * 0.2));
      endIdx = Math.min(candles.length - 1, Math.floor(candles.length * 0.8));
    }
    rangeLine.setStartTime(candles[startIdx].time);
    rangeLine.setEndTime(candles[endIdx].time);
  }, [candles, showRangeLines]);

  // Update candle/volume data
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current) return;

    const candleData: CandlestickData[] = candles.map((c) => ({
      time: toChartTime(c.time),
      open: c.open, high: c.high, low: c.low, close: c.close,
    }));
    const volData: HistogramData[] = candles.map((c) => ({
      time: toChartTime(c.time),
      value: c.volume ?? 0,
      color: c.close >= c.open ? CHART_COLORS.volume : CHART_COLORS.volumeDown,
    }));

    candleSeriesRef.current.setData(candleData);
    volumeSeriesRef.current.setData(volData);
    mainChartRef.current?.timeScale().fitContent();
    setChipChartLayout((current) => ({
      height: mainRef.current?.clientHeight ?? current.height,
      revision: current.revision + 1,
    }));
  }, [candles]);

  // Keep the custom Chan structure layer independent from candle and indicator series.
  useEffect(() => {
    const primitive = chanStructureRef.current;
    if (!primitive) return;
    primitive.setAnalysis(chanAnalysis);
    primitive.setVisibility({
      pens: showChanPens,
      fractals: showChanFractals,
      segments: showChanSegments,
      penCenters: showChanPenCenters,
      segmentCenters: showChanSegmentCenters,
    });
  }, [
    chanAnalysis,
    showChanFractals,
    showChanPenCenters,
    showChanPens,
    showChanSegmentCenters,
    showChanSegments,
  ]);

  // Signal markers on candlestick chart
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series || candles.length === 0) return;

    try {
      const activeSignals = period === 'day'
        ? signals.filter((s) => s.action !== 'hold')
        : [];
      if (activeSignals.length === 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (series as any).setMarkers?.([]);
        return;
      }

      const markers = activeSignals.map((s: StrategySignal) => ({
        time: toChartTime(s.time),
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
  }, [signals, candles, period]);

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
            lineData.push({ time: toChartTime(candles[i].time), value: v });
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
            background: { type: ColorType.Solid, color: chartSurface.background },
            textColor: chartSurface.text,
          },
          grid: {
            vertLines: { color: chartSurface.grid },
            horzLines: { color: chartSurface.grid },
          },
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { color: chartSurface.crosshair, labelVisible: false },
            horzLine: { color: chartSurface.crosshair, labelVisible: false },
          },
          rightPriceScale: { borderColor: chartSurface.border },
          timeScale: { borderColor: chartSurface.border, visible: false },
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
                time: toChartTime(candles[i].time),
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
  }, [separates, candles, actives, chartSurface]);

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
        className={`analysis-main-stage${showChipProfile && period === 'day' ? ' has-chip-profile' : ''}`}
        style={{
          flexGrow: 0,
          flexShrink: 0,
          flexBasis: `${mainChartHeight}px`,
          height: mainChartHeight,
          minHeight: MAIN_CHART_MIN_HEIGHT,
          overflow: 'hidden',
        }}
      >
        <div ref={mainRef} className="analysis-main-chart" />
        {(showChanPens || showChanFractals || showChanSegments || showChanPenCenters || showChanSegmentCenters) && (
          <div className="chan-chart-legend" aria-label="缠论结构图例">
            <span className="chan-version-badge">{chanAnalysis.config.algorithmVersion}</span>
            {showChanPens && (
              <>
                <span className="chan-legend-item is-confirmed">确认笔 {confirmedPenCount}</span>
                <span className="chan-legend-item is-candidate">候选笔 {candidatePenCount}</span>
              </>
            )}
            {showChanFractals && (
              <span className="chan-legend-item is-fractal">分型 {chanAnalysis.fractals.length}</span>
            )}
            {showChanSegments && (
              <>
                <span className="chan-legend-item is-segment">确认段 {confirmedSegmentCount}</span>
                <span className="chan-legend-item is-segment-candidate">候选段 {candidateSegmentCount}</span>
              </>
            )}
            {showChanPenCenters && (
              <span
                className="chan-legend-item is-pen-center"
                title={latestPenCenter
                  ? `笔中枢 [${latestPenCenter.zd}, ${latestPenCenter.zg}] · ${latestPenCenter.lifecycle} · 确认 ${latestPenCenter.confirmedAt ?? '等待'}`
                  : '当前没有笔中枢'}
              >
                笔中枢 {confirmedPenCenterCount}/{candidatePenCenterCount}
              </span>
            )}
            {showChanSegmentCenters && (
              <span
                className="chan-legend-item is-segment-center"
                title={latestSegmentCenter
                  ? `段中枢 [${latestSegmentCenter.zd}, ${latestSegmentCenter.zg}] · ${latestSegmentCenter.lifecycle} · 确认 ${latestSegmentCenter.confirmedAt ?? '等待'}`
                  : '当前没有段中枢'}
              >
                段中枢 {confirmedSegmentCenterCount}/{candidateSegmentCenterCount}
              </span>
            )}
            <span className="chan-asof" title="所有结构仅使用截至该时点可获得的行情">
              截止 {chanAnalysis.current.asOf ?? '--'}
            </span>
          </div>
        )}
        {showChipProfile && period === 'day' && (
          <ChipProfile
            distribution={chipDistribution}
            asOfDate={chipAsOfDate}
            priceToCoordinate={chipPriceToCoordinateRef.current}
            chartHeight={chipChartLayout.height}
          />
        )}
      </div>
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
      <CandleDetail left={8} />
    </div>
  );
}
