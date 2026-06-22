import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type Time } from 'lightweight-charts';
import { Empty } from 'antd';
import type { KlinePoint } from './types';

interface IndicatorPoint {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  rsi14: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
}

interface HoverPoint extends KlinePoint, IndicatorPoint {
  change: number | null;
  changePct: number | null;
}

function sma(values: number[], period: number): Array<number | null> {
  let total = 0;
  return values.map((value, index) => {
    total += value;
    if (index >= period) total -= values[index - period];
    return index >= period - 1 ? total / period : null;
  });
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

function rsi(values: number[], period = 14): Array<number | null> {
  const result: Array<number | null> = values.map(() => null);
  if (values.length <= period) return result;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gains += Math.max(delta, 0);
    losses += Math.max(-delta, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period;
    result[index] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function calculateIndicators(data: KlinePoint[]): IndicatorPoint[] {
  const closes = data.map((item) => item.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const rsi14 = rsi(closes);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const dif = closes.map((_value, index) => ema12[index] - ema26[index]);
  const dea = ema(dif, 9);
  return closes.map((_value, index) => ({
    ma5: ma5[index], ma10: ma10[index], ma20: ma20[index], rsi14: rsi14[index],
    dif: dif[index] ?? null, dea: dea[index] ?? null,
    macd: dif[index] == null || dea[index] == null ? null : (dif[index] - dea[index]) * 2,
  }));
}

function fmt(value: number | null, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function formatVolume(value: number) {
  if (value >= 1e8) return `${fmt(value / 1e8)} 亿`;
  if (value >= 1e4) return `${fmt(value / 1e4)} 万`;
  return fmt(value, 0);
}

function timeKey(time: Time): string {
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  const value = time as { year: number; month: number; day: number };
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export default function MarketKlineChart({ data }: { data: KlinePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const indicators = useMemo(() => calculateIndicators(data), [data]);
  const latest = indicators[indicators.length - 1];

  useEffect(() => {
    const el = ref.current;
    if (!el || !data.length) return;
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#fff' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#eef2f7' }, horzLines: { color: '#eef2f7' } },
      crosshair: { vertLine: { color: '#94a3b8', labelVisible: false }, horzLine: { color: '#94a3b8', labelVisible: false } },
      rightPriceScale: { borderColor: '#e2e8f0', scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: '#e2e8f0' },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#ef4444', downColor: '#16a34a', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#16a34a' });
    candles.setData(data.map((item) => ({ time: item.date as Time, open: item.open, high: item.high, low: item.low, close: item.close })));
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' } });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(data.map((item) => ({ time: item.date as Time, value: item.volume, color: item.close >= item.open ? '#ef444466' : '#16a34a66' })));

    const maConfigs = [
      { key: 'ma5' as const, color: '#f59e0b' },
      { key: 'ma10' as const, color: '#2563eb' },
      { key: 'ma20' as const, color: '#8b5cf6' },
    ];
    for (const config of maConfigs) {
      const series = chart.addSeries(LineSeries, { color: config.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      series.setData(indicators.flatMap((item, index) => item[config.key] == null ? [] : [{ time: data[index].date as Time, value: item[config.key] as number }]));
    }

    const indexByDate = new Map(data.map((item, index) => [item.date, index]));
    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0 || param.point.x > el.clientWidth || param.point.y > el.clientHeight) {
        setHover(null);
        return;
      }
      const index = indexByDate.get(timeKey(param.time));
      if (index == null) return;
      const item = data[index];
      const previous = data[index - 1];
      const change = previous ? item.close - previous.close : null;
      setHover({
        ...item, ...indicators[index], change,
        changePct: change != null && previous.close ? change / previous.close * 100 : null,
      });
    });
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    return () => { observer.disconnect(); chart.remove(); setHover(null); };
  }, [data, indicators]);

  if (!data.length) return <Empty className="market-chart-empty" description="暂无 K 线数据" />;
  return <div className="market-kline-shell">
    <div className="market-indicator-legend" aria-label="最新技术指标">
      <span className="ma5">MA5 {fmt(latest?.ma5 ?? null)}</span>
      <span className="ma10">MA10 {fmt(latest?.ma10 ?? null)}</span>
      <span className="ma20">MA20 {fmt(latest?.ma20 ?? null)}</span>
      <span>RSI14 {fmt(latest?.rsi14 ?? null)}</span>
      <span>MACD {fmt(latest?.macd ?? null)}</span>
    </div>
    <div ref={ref} className="market-kline" aria-label="股票 K 线图，移动鼠标查看每日数据" />
    {hover && <div className="market-chart-tooltip" role="status">
      <strong>{hover.date}</strong>
      <dl>
        <dt>开盘</dt><dd>{fmt(hover.open)}</dd><dt>最高</dt><dd>{fmt(hover.high)}</dd>
        <dt>最低</dt><dd>{fmt(hover.low)}</dd><dt>收盘</dt><dd>{fmt(hover.close)}</dd>
        <dt>涨跌</dt><dd className={(hover.change ?? 0) >= 0 ? 'market-up' : 'market-down'}>{fmt(hover.change)}</dd>
        <dt>涨跌幅</dt><dd className={(hover.changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>{fmt(hover.changePct)}%</dd>
        <dt>成交量</dt><dd>{formatVolume(hover.volume)}</dd><dt>RSI14</dt><dd>{fmt(hover.rsi14)}</dd>
        <dt>MA5/10/20</dt><dd>{fmt(hover.ma5)} / {fmt(hover.ma10)} / {fmt(hover.ma20)}</dd>
        <dt>MACD</dt><dd>{fmt(hover.macd)}</dd>
      </dl>
    </div>}
  </div>;
}
