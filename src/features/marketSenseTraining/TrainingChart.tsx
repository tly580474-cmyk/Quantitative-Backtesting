import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, createChart, createSeriesMarkers, HistogramSeries,
  LineSeries, LineStyle, type SeriesMarker, type Time,
} from 'lightweight-charts';
import type { KlinePoint } from '@/features/marketData/types';
import type { TrainingTrade } from './engine';
import { calculateTrainingIndicators, type IndicatorValue } from './indicators';
import {
  TrainingDrawingPrimitive,
  type TrainingDrawing,
  type TrainingDrawingPoint,
} from './TrainingDrawingPrimitive';

export type TrainingIndicator = 'ma' | 'boll' | 'rsi' | 'macd';
export type TrainingDrawingMode = 'none' | 'horizontal' | 'trend';

export interface TrainingChartSnapshot {
  index: number;
  bar: KlinePoint;
  indicator: IndicatorValue;
  changePercent: number | null;
}

interface TrainingChartProps {
  data: KlinePoint[];
  trades: TrainingTrade[];
  revealTrades?: boolean;
  theme: 'light' | 'dark';
  indicators: TrainingIndicator[];
  drawingMode: TrainingDrawingMode;
  drawings: TrainingDrawing[];
  onChartPoint: (point: TrainingDrawingPoint) => void;
  onCrosshairChange: (snapshot: TrainingChartSnapshot) => void;
}

function timeText(value: Time): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value * 1000).toISOString().slice(0, 10);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export default function TrainingChart({
  data, trades, revealTrades = false, theme, indicators, drawingMode, drawings, onChartPoint,
  onCrosshairChange,
}: TrainingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || data.length === 0) return undefined;
    const light = theme === 'light';
    const colors = light
      ? { background: '#fff', text: '#526174', grid: '#edf1f5', border: '#d8e0e9', crosshair: '#64748b', label: '#334155' }
      : { background: '#090d12', text: '#8f9aaa', grid: '#151b23', border: '#232b36', crosshair: '#667085', label: '#344054' };
    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: 'Inter, "Microsoft YaHei", system-ui, sans-serif',
        panes: { separatorColor: colors.border, separatorHoverColor: '#2563eb', enableResize: true },
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: {
        borderColor: colors.border, rightOffset: 5, barSpacing: 8,
        visible: revealTrades, borderVisible: revealTrades, ticksVisible: revealTrades,
        tickMarkFormatter: revealTrades ? undefined : () => '',
      },
      crosshair: {
        vertLine: { color: colors.crosshair, labelBackgroundColor: colors.label, labelVisible: revealTrades },
        horzLine: { color: colors.crosshair, labelBackgroundColor: colors.label },
      },
      handleScroll: drawingMode === 'none',
      handleScale: drawingMode === 'none',
      localization: { locale: 'zh-CN' },
    });
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#ef4444', downColor: '#16a34a', wickUpColor: '#ef4444', wickDownColor: '#16a34a',
      borderVisible: false, priceLineVisible: false,
    }, 0);
    candleSeries.setData(data.map((bar) => ({
      time: bar.date as Time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    })));

    const computed = calculateTrainingIndicators(data);
    const snapshots = data.map((bar, index): TrainingChartSnapshot => {
      const previousClose = bar.previousClose ?? data[index - 1]?.close;
      const suppliedChange = bar.changePct;
      const changePercent = Number.isFinite(suppliedChange)
        ? suppliedChange!
        : previousClose && Number.isFinite(previousClose)
          ? (bar.close - previousClose) / previousClose * 100
          : null;
      return { index, bar, indicator: computed[index], changePercent };
    });
    const snapshotByDate = new Map(snapshots.map((snapshot) => [snapshot.bar.date, snapshot]));
    const latestSnapshot = snapshots[snapshots.length - 1];
    onCrosshairChange(latestSnapshot);
    const addMainLine = (
      key: 'ma5' | 'ma10' | 'ma20' | 'bollUpper' | 'bollMiddle' | 'bollLower',
      color: string,
      width: 1 | 2 = 1,
    ) => {
      const series = chart.addSeries(LineSeries, {
        color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      }, 0);
      series.setData(computed.flatMap((value) => value[key] == null
        ? []
        : [{ time: value.date as Time, value: value[key] }]));
    };
    if (indicators.includes('ma')) {
      addMainLine('ma5', '#f59e0b', 2);
      addMainLine('ma10', '#8b5cf6');
      addMainLine('ma20', '#0ea5e9');
    }
    if (indicators.includes('boll')) {
      addMainLine('bollUpper', '#6366f1');
      addMainLine('bollMiddle', '#94a3b8');
      addMainLine('bollLower', '#6366f1');
    }

    let paneIndex = 1;
    const volumePane = paneIndex;
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'right', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
    }, paneIndex);
    volume.setData(data.map((bar) => ({
      time: bar.date as Time, value: bar.volume,
      color: bar.close >= bar.open ? 'rgba(239,68,68,.45)' : 'rgba(22,163,74,.45)',
    })));
    paneIndex += 1;

    if (indicators.includes('rsi')) {
      const rsiPane = paneIndex;
      const rsi = chart.addSeries(LineSeries, {
        color: '#8b5cf6', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'RSI14',
      }, rsiPane);
      rsi.setData(computed.flatMap((value) => value.rsi14 == null
        ? []
        : [{ time: value.date as Time, value: value.rsi14 }]));
      for (const threshold of [30, 70]) {
        const guide = chart.addSeries(LineSeries, {
          color: threshold === 70 ? '#f87171' : '#4ade80', lineWidth: 1,
          lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false,
        }, rsiPane);
        guide.setData(data.map((bar) => ({ time: bar.date as Time, value: threshold })));
      }
      paneIndex += 1;
    }

    if (indicators.includes('macd')) {
      const macdPane = paneIndex;
      const histogram = chart.addSeries(HistogramSeries, {
        priceLineVisible: false, lastValueVisible: false, title: 'MACD',
      }, macdPane);
      histogram.setData(computed.map((value) => ({
        time: value.date as Time, value: value.macdHistogram,
        color: value.macdHistogram >= 0 ? 'rgba(239,68,68,.7)' : 'rgba(22,163,74,.7)',
      })));
      const dif = chart.addSeries(LineSeries, {
        color: '#0ea5e9', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      }, macdPane);
      dif.setData(computed.map((value) => ({ time: value.date as Time, value: value.macdDif })));
      const dea = chart.addSeries(LineSeries, {
        color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      }, macdPane);
      dea.setData(computed.map((value) => ({ time: value.date as Time, value: value.macdDea })));
      paneIndex += 1;
    }

    if (revealTrades && trades.length > 0) {
      const markers: SeriesMarker<Time>[] = trades.map((trade) => ({
        time: trade.date as Time,
        position: trade.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: trade.side === 'buy' ? '#fb7185' : '#4ade80',
        shape: trade.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: trade.side === 'buy' ? '买' : '卖',
      }));
      createSeriesMarkers(candleSeries, markers);
    }

    const primitive = new TrainingDrawingPrimitive();
    primitive.setDrawings(drawings);
    candleSeries.attachPrimitive(primitive);
    if (drawingMode !== 'none') {
      chart.subscribeClick((param) => {
        if (!param.point || param.time == null || (param.paneIndex ?? 0) !== 0) return;
        const price = candleSeries.coordinateToPrice(param.point.y);
        if (price != null) onChartPoint({ time: timeText(param.time), price });
      });
    }

    let selectedDate = latestSnapshot.bar.date;
    const handleCrosshairMove = (param: Parameters<typeof chart.subscribeCrosshairMove>[0] extends (value: infer T) => void ? T : never) => {
      const date = param.time == null || !param.point ? null : timeText(param.time);
      const snapshot = date ? snapshotByDate.get(date) : latestSnapshot;
      if (!snapshot || snapshot.bar.date === selectedDate) return;
      selectedDate = snapshot.bar.date;
      onCrosshairChange(snapshot);
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    chart.timeScale().fitContent();
    const panes = chart.panes();
    panes[volumePane]?.setHeight(78);
    for (let index = volumePane + 1; index < panes.length; index += 1) panes[index]?.setHeight(104);
    const observer = new ResizeObserver(() => {
      chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
    };
  }, [data, drawingMode, drawings, indicators, onChartPoint, onCrosshairChange, revealTrades, theme, trades]);

  return <div
    ref={containerRef}
    className={`market-sense-chart${drawingMode === 'none' ? '' : ' is-drawing'}`}
    aria-label={`盘感训练 K 线图，红涨绿跌${drawingMode === 'none' ? '' : '，画线模式已启用'}`}
  />;
}
