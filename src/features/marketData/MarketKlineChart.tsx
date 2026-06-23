import { useEffect, useMemo, useRef, useState } from 'react';
import { CandlestickSeries, ColorType, createChart, HistogramSeries, LineSeries, type Time } from 'lightweight-charts';
import { Empty, Segmented } from 'antd';
import type { KlinePoint, MarketKlinePeriod } from './types';

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

type IntradayIndicator = 'volumeRatio' | 'rsi14' | 'macd' | 'none';

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

function formatPct(value: number | null) {
  return value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${fmt(value)}%`;
}

function chartTime(date: string): Time {
  if (date.includes(' ')) return Math.floor(new Date(`${date.replace(' ', 'T')}:00+08:00`).getTime() / 1000) as Time;
  return date as Time;
}

function formatChinaTime(time: Time) {
  if (typeof time === 'number') {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(time * 1000));
  }
  if (typeof time === 'string') return time.includes(' ') ? time.slice(11, 16) : time;
  const value = time as { year: number; month: number; day: number };
  return `${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function intradayRange(date: string) {
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return {
    from: Math.floor(new Date(`${day}T09:30:00+08:00`).getTime() / 1000) as Time,
    to: Math.floor(new Date(`${day}T15:00:00+08:00`).getTime() / 1000) as Time,
  };
}

function averagePrice(data: KlinePoint[]) {
  let amount = 0;
  let volume = 0;
  return data.map((item) => {
    amount += item.close * Math.max(0, item.volume);
    volume += Math.max(0, item.volume);
    return volume > 0 ? amount / volume : item.close;
  });
}

function intradayVolumeRatio(data: KlinePoint[]) {
  const volumes = data.map((item) => Math.max(0, item.volume));
  const ma5 = sma(volumes, 5);
  return volumes.map((value, index) => {
    const base = ma5[index] ?? null;
    return base && base > 0 ? value / base : null;
  });
}

function timeKey(time: Time): string {
  if (typeof time === 'string' || typeof time === 'number') return String(time);
  const value = time as { year: number; month: number; day: number };
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

export default function MarketKlineChart({ data, period, previousClose }: { data: KlinePoint[]; period: MarketKlinePeriod; previousClose?: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const intradayPriceRef = useRef<HTMLDivElement>(null);
  const intradayVolumeRef = useRef<HTMLDivElement>(null);
  const intradayIndicatorRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [subIndicator, setSubIndicator] = useState<IntradayIndicator>('volumeRatio');
  const indicators = useMemo(() => calculateIndicators(data), [data]);
  const latest = indicators[indicators.length - 1];
  const isIntraday = period === 'intraday';
  const avgPrices = useMemo(() => averagePrice(data), [data]);
  const volumeRatios = useMemo(() => intradayVolumeRatio(data), [data]);

  useEffect(() => {
    if (!isIntraday) return undefined;
    const priceEl = intradayPriceRef.current;
    const volumeEl = intradayVolumeRef.current;
    const indicatorEl = intradayIndicatorRef.current;
    if (!priceEl || !volumeEl || !data.length) return undefined;

    const times = data.map((item) => chartTime(item.date));
    const fixedRange = intradayRange(data[0].date);
    const baseOptions = {
      layout: { background: { type: ColorType.Solid, color: '#0b1020' }, textColor: '#cbd5e1' },
      grid: { vertLines: { color: '#263145' }, horzLines: { color: '#1f2937' } },
      crosshair: { vertLine: { color: '#64748b', labelVisible: false }, horzLine: { color: '#64748b', labelVisible: false } },
      localization: { timeFormatter: formatChinaTime },
      rightPriceScale: { borderColor: '#1e293b' },
      timeScale: { borderColor: '#1e293b', timeVisible: true, secondsVisible: false, rightOffset: 0, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: formatChinaTime },
      handleScale: false,
      handleScroll: false,
    } as const;
    const priceChart = createChart(priceEl, { ...baseOptions, width: priceEl.clientWidth, height: priceEl.clientHeight, leftPriceScale: { visible: true, borderColor: '#1e293b' } });
    const volumeChart = createChart(volumeEl, { ...baseOptions, width: volumeEl.clientWidth, height: volumeEl.clientHeight, timeScale: { ...baseOptions.timeScale, visible: false } });
    const indicatorChart = indicatorEl && subIndicator !== 'none'
      ? createChart(indicatorEl, { ...baseOptions, width: indicatorEl.clientWidth, height: indicatorEl.clientHeight })
      : null;

    const priceLine = priceChart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 2, priceLineVisible: true, priceLineColor: '#38bdf8' });
    priceLine.setData(data.map((item, index) => ({ time: times[index], value: item.close })));
    const avgLine = priceChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    avgLine.setData(avgPrices.map((value, index) => ({ time: times[index], value })));
    if (previousClose && Number.isFinite(previousClose)) {
      const zeroLine = priceChart.addSeries(LineSeries, { color: '#475569', lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      zeroLine.setData(times.map((time) => ({ time, value: previousClose })));
    }

    const volumeSeries = volumeChart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false });
    volumeSeries.setData(data.map((item, index) => {
      const previous = data[index - 1]?.close ?? previousClose ?? item.close;
      return { time: times[index], value: item.volume, color: item.close >= previous ? '#ef4444cc' : '#06b6d4cc' };
    }));

    if (indicatorChart) {
      if (subIndicator === 'volumeRatio') {
        const ratio = indicatorChart.addSeries(LineSeries, { color: '#cbd5e1', lineWidth: 1, priceLineVisible: false });
        ratio.setData(volumeRatios.flatMap((value, index) => value == null ? [] : [{ time: times[index], value }]));
      } else if (subIndicator === 'rsi14') {
        const rsiLine = indicatorChart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 1, priceLineVisible: false });
        rsiLine.setData(indicators.flatMap((item, index) => item.rsi14 == null ? [] : [{ time: times[index], value: item.rsi14 }]));
      } else if (subIndicator === 'macd') {
        const macdBars = indicatorChart.addSeries(HistogramSeries, { priceLineVisible: false });
        macdBars.setData(indicators.flatMap((item, index) => item.macd == null ? [] : [{ time: times[index], value: item.macd, color: item.macd >= 0 ? '#ef4444cc' : '#22c55ecc' }]));
        const difLine = indicatorChart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false });
        difLine.setData(indicators.flatMap((item, index) => item.dif == null ? [] : [{ time: times[index], value: item.dif }]));
        const deaLine = indicatorChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false });
        deaLine.setData(indicators.flatMap((item, index) => item.dea == null ? [] : [{ time: times[index], value: item.dea }]));
      }
    }

    const indexByDate = new Map(data.map((_item, index) => [timeKey(times[index]), index]));
    priceChart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0 || param.point.x > priceEl.clientWidth || param.point.y > priceEl.clientHeight) {
        setHover(null);
        return;
      }
      const index = indexByDate.get(timeKey(param.time));
      if (index == null) return;
      const item = data[index];
      const base = previousClose && Number.isFinite(previousClose) ? previousClose : data[index - 1]?.close;
      const change = base ? item.close - base : null;
      setHover({
        ...item, ...indicators[index], change,
        changePct: change != null && base ? change / base * 100 : null,
      });
    });
    if (fixedRange) {
      priceChart.timeScale().setVisibleRange(fixedRange);
      volumeChart.timeScale().setVisibleRange(fixedRange);
      indicatorChart?.timeScale().setVisibleRange(fixedRange);
    } else {
      priceChart.timeScale().fitContent();
      volumeChart.timeScale().fitContent();
      indicatorChart?.timeScale().fitContent();
    }

    const observer = new ResizeObserver(() => {
      if (priceEl.clientWidth > 0 && priceEl.clientHeight > 0) priceChart.applyOptions({ width: priceEl.clientWidth, height: priceEl.clientHeight });
      if (volumeEl.clientWidth > 0 && volumeEl.clientHeight > 0) volumeChart.applyOptions({ width: volumeEl.clientWidth, height: volumeEl.clientHeight });
      if (indicatorEl && indicatorChart && indicatorEl.clientWidth > 0 && indicatorEl.clientHeight > 0) indicatorChart.applyOptions({ width: indicatorEl.clientWidth, height: indicatorEl.clientHeight });
      if (fixedRange) {
        priceChart.timeScale().setVisibleRange(fixedRange);
        volumeChart.timeScale().setVisibleRange(fixedRange);
        indicatorChart?.timeScale().setVisibleRange(fixedRange);
      }
    });
    observer.observe(priceEl);
    observer.observe(volumeEl);
    if (indicatorEl) observer.observe(indicatorEl);
    return () => {
      observer.disconnect();
      priceChart.remove();
      volumeChart.remove();
      indicatorChart?.remove();
      setHover(null);
    };
  }, [avgPrices, data, indicators, isIntraday, previousClose, subIndicator, volumeRatios]);

  useEffect(() => {
    if (isIntraday) return undefined;
    const el = ref.current;
    if (!el || !data.length) return;
    const times = data.map((item) => chartTime(item.date));
    const chart = createChart(el, {
      width: el.clientWidth, height: el.clientHeight,
      layout: { background: { type: ColorType.Solid, color: '#fff' }, textColor: '#64748b' },
      grid: { vertLines: { color: '#eef2f7' }, horzLines: { color: '#eef2f7' } },
      crosshair: { vertLine: { color: '#94a3b8', labelVisible: false }, horzLine: { color: '#94a3b8', labelVisible: false } },
      rightPriceScale: { borderColor: '#e2e8f0', scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderColor: '#e2e8f0', timeVisible: isIntraday, secondsVisible: false },
    });
    if (isIntraday) {
      const priceLine = chart.addSeries(LineSeries, { color: '#2563eb', lineWidth: 2, priceLineColor: '#2563eb' });
      priceLine.setData(data.map((item, index) => ({ time: times[index], value: item.close })));
    } else {
      const candles = chart.addSeries(CandlestickSeries, { upColor: '#ef4444', downColor: '#16a34a', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#16a34a' });
      candles.setData(data.map((item, index) => ({ time: times[index], open: item.open, high: item.high, low: item.low, close: item.close })));
    }
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' } });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(data.map((item, index) => ({ time: times[index], value: item.volume, color: item.close >= item.open ? '#ef444466' : '#16a34a66' })));

    const maConfigs = [
      { key: 'ma5' as const, color: '#f59e0b' },
      { key: 'ma10' as const, color: '#2563eb' },
      { key: 'ma20' as const, color: '#8b5cf6' },
    ];
    for (const config of maConfigs) {
      const series = chart.addSeries(LineSeries, { color: config.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      series.setData(indicators.flatMap((item, index) => item[config.key] == null ? [] : [{ time: times[index], value: item[config.key] as number }]));
    }

    const indexByDate = new Map(data.map((_item, index) => [timeKey(times[index]), index]));
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
  }, [data, indicators, isIntraday]);

  if (!data.length) return <Empty className="market-chart-empty" description={isIntraday ? '暂无分时数据' : '暂无 K 线数据'} />;
  if (isIntraday) {
    const latestPoint = data[data.length - 1];
    const latestChange = previousClose ? latestPoint.close - previousClose : null;
    const latestPct = latestChange != null && previousClose ? latestChange / previousClose * 100 : null;
    const latestRatio = volumeRatios[volumeRatios.length - 1] ?? null;
    return <div className="market-intraday-shell">
      <div className="market-intraday-toolbar">
        <div className="market-intraday-legend" aria-label="分时图例">
          <span className="price">分时 {fmt(latestPoint.close)}</span>
          <span className="avg">均价 {fmt(avgPrices[avgPrices.length - 1] ?? null)}</span>
          <span className={(latestChange ?? 0) >= 0 ? 'market-up' : 'market-down'}>当日涨跌幅 {formatPct(latestPct)}</span>
        </div>
        <div className="market-intraday-indicator-picker">
          <span>副图指标</span>
          <Segmented<IntradayIndicator>
            size="small"
            value={subIndicator}
            onChange={setSubIndicator}
            options={[
              { label: '量比', value: 'volumeRatio' },
              { label: 'RSI14', value: 'rsi14' },
              { label: 'MACD', value: 'macd' },
              { label: '隐藏', value: 'none' },
            ]}
          />
        </div>
      </div>
      <div ref={intradayPriceRef} className="market-intraday-price" aria-label="股票分时主图，固定展示 09:30 到 15:00" />
      <div ref={intradayVolumeRef} className="market-intraday-volume" aria-label="分时成交量副图" />
      {subIndicator !== 'none' && <div className="market-intraday-subchart-wrap">
        <div className="market-intraday-subchart-label">{subIndicator === 'volumeRatio' ? `量比 ${fmt(latestRatio)}` : subIndicator === 'rsi14' ? `RSI14 ${fmt(latest?.rsi14 ?? null)}` : `MACD ${fmt(latest?.macd ?? null)}`}</div>
        <div ref={intradayIndicatorRef} className="market-intraday-indicator" aria-label="分时技术指标副图" />
      </div>}
      {hover && <div className="market-chart-tooltip market-intraday-tooltip" role="status">
        <strong>{hover.date}</strong>
        <dl>
          <dt>价格</dt><dd>{fmt(hover.close)}</dd>
          <dt>当日涨跌</dt><dd className={(hover.change ?? 0) >= 0 ? 'market-up' : 'market-down'}>{fmt(hover.change)}</dd>
          <dt>当日涨跌幅</dt><dd className={(hover.changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>{formatPct(hover.changePct)}</dd>
          <dt>成交量</dt><dd>{formatVolume(hover.volume)}</dd>
          <dt>量比</dt><dd>{fmt(volumeRatios[data.findIndex((item) => item.date === hover.date)] ?? null)}</dd>
          <dt>RSI14</dt><dd>{fmt(hover.rsi14)}</dd>
          <dt>MACD</dt><dd>{fmt(hover.macd)}</dd>
        </dl>
      </div>}
    </div>;
  }
  return <div className="market-kline-shell">
    <div className="market-indicator-legend" aria-label="最新技术指标">
      <span className="ma5">MA5 {fmt(latest?.ma5 ?? null)}</span>
      <span className="ma10">MA10 {fmt(latest?.ma10 ?? null)}</span>
      <span className="ma20">MA20 {fmt(latest?.ma20 ?? null)}</span>
      <span>RSI14 {fmt(latest?.rsi14 ?? null)}</span>
      <span>MACD {fmt(latest?.macd ?? null)}</span>
    </div>
    <div ref={ref} className="market-kline" aria-label={isIntraday ? '股票分时图，移动鼠标查看分钟数据' : '股票 K 线图，移动鼠标查看每日数据'} />
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
