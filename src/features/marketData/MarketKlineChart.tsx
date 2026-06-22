import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type Time } from 'lightweight-charts';
import { Empty } from 'antd';
import type { KlinePoint } from './types';

export default function MarketKlineChart({ data }: { data: KlinePoint[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !data.length) return;
    const chart = createChart(el, { width: el.clientWidth, height: el.clientHeight, layout: { background: { type: ColorType.Solid, color: '#fff' }, textColor: '#64748b' }, grid: { vertLines: { color: '#eef2f7' }, horzLines: { color: '#eef2f7' } }, rightPriceScale: { borderColor: '#e2e8f0', scaleMargins: { top: 0.08, bottom: 0.24 } }, timeScale: { borderColor: '#e2e8f0' } });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#ef4444', downColor: '#16a34a', borderVisible: false, wickUpColor: '#ef4444', wickDownColor: '#16a34a' });
    candles.setData(data.map((x) => ({ time: x.date as Time, open: x.open, high: x.high, low: x.low, close: x.close })));
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' } });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volume.setData(data.map((x) => ({ time: x.date as Time, value: x.volume, color: x.close >= x.open ? '#ef444466' : '#16a34a66' })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
      }
    });
    observer.observe(el);
    return () => { observer.disconnect(); chart.remove(); };
  }, [data]);
  return data.length ? <div ref={ref} className="market-kline" aria-label="股票 K 线图" /> : <Empty className="market-chart-empty" description="暂无 K 线数据" />;
}
