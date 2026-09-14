import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Empty, Modal, Skeleton, Space, Tag, Typography } from 'antd';
import {
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type Time,
} from 'lightweight-charts';
import { apiFetch } from '@/api/client';
import { getChartSurfaceColors } from '@/theme';
import './daily-intraday-modal.css';

const { Text } = Typography;

export interface IntradayBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  amount: number;
}

interface MinuteBarsResponse {
  intervalMinutes: number;
  sourceFiles: number;
  truncated: boolean;
  elapsedMs: number;
  items: IntradayBar[];
}

interface DailyIntradayModalProps {
  open: boolean;
  symbol: string;
  name?: string;
  date: string | null;
  onClose: () => void;
}

export function buildDailyIntradayPath(symbol: string, date: string): string {
  const query = new URLSearchParams({
    startDate: date,
    endDate: date,
    interval: '1',
    includeZeroVolume: 'true',
    limit: '1000',
  });
  return `/api/market-data/stocks/${encodeURIComponent(symbol)}/minute?${query}`;
}

function chartTime(value: string): Time {
  const normalized = value.trim().replace(' ', 'T');
  const withSeconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)
    ? `${normalized}:00`
    : normalized;
  return Math.floor(new Date(`${withSeconds}+08:00`).getTime() / 1000) as Time;
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
  return `${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function intradayRange(date: string) {
  const day = date.slice(0, 10);
  return {
    // Keep a small visual gutter so the first and last time labels are not clipped.
    from: Math.floor(new Date(`${day}T09:25:00+08:00`).getTime() / 1000) as Time,
    to: Math.floor(new Date(`${day}T15:05:00+08:00`).getTime() / 1000) as Time,
  };
}

function formatNumber(value: number, digits = 2) {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits });
}

function formatVolume(value: number) {
  if (value >= 100_000_000) return `${formatNumber(value / 100_000_000)} 亿股`;
  if (value >= 10_000) return `${formatNumber(value / 10_000)} 万股`;
  return `${formatNumber(value, 0)} 股`;
}

function DailyIntradayChart({ data }: { data: IntradayBar[] }) {
  const priceRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const chartSurface = useMemo(() => getChartSurfaceColors(), []);
  const averagePrices = useMemo(() => {
    let cumulativeAmount = 0;
    let cumulativeVolume = 0;
    return data.map((item) => {
      cumulativeAmount += Math.max(0, item.amount);
      cumulativeVolume += Math.max(0, item.volume);
      return cumulativeVolume > 0 ? cumulativeAmount / cumulativeVolume : item.close;
    });
  }, [data]);

  useEffect(() => {
    const priceElement = priceRef.current;
    const volumeElement = volumeRef.current;
    if (!priceElement || !volumeElement || data.length === 0) return undefined;

    const common = {
      layout: {
        background: { type: ColorType.Solid, color: chartSurface.background },
        textColor: chartSurface.text,
      },
      grid: {
        vertLines: { color: chartSurface.grid },
        horzLines: { color: chartSurface.grid },
      },
      crosshair: {
        vertLine: { color: chartSurface.crosshair, labelVisible: false },
        horzLine: { color: chartSurface.crosshair, labelVisible: false },
      },
      localization: { timeFormatter: formatChinaTime },
      rightPriceScale: { borderColor: chartSurface.border, minimumWidth: 64 },
    };
    const priceChart = createChart(priceElement, {
      ...common,
      width: priceElement.clientWidth,
      height: priceElement.clientHeight,
      timeScale: { borderColor: chartSurface.border, visible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: formatChinaTime },
    });
    const volumeChart = createChart(volumeElement, {
      ...common,
      width: volumeElement.clientWidth,
      height: volumeElement.clientHeight,
      rightPriceScale: { ...common.rightPriceScale, scaleMargins: { top: 0.12, bottom: 0 } },
      timeScale: { borderColor: chartSurface.border, timeVisible: true, secondsVisible: false, tickMarkFormatter: formatChinaTime },
    });
    const price = priceChart.addSeries(LineSeries, {
      color: '#2563eb', lineWidth: 2, priceLineVisible: false, lastValueVisible: true,
    });
    const average = priceChart.addSeries(LineSeries, {
      color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
    });
    const volume = volumeChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
    });
    const times = data.map((item) => chartTime(item.date));
    price.setData(data.map((item, index) => ({ time: times[index], value: item.close })));
    average.setData(averagePrices.map((value, index) => ({ time: times[index], value })));
    volume.setData(data.map((item, index) => ({
      time: times[index],
      value: item.volume,
      color: item.close >= item.open ? '#ef444477' : '#16a34a77',
    })));

    const indexByTime = new Map(times.map((time, index) => [String(time), index]));
    let synchronizing = false;
    const syncRange = (source: IChartApi, target: IChartApi) => () => {
      if (synchronizing) return;
      const range = source.timeScale().getVisibleLogicalRange();
      if (!range) return;
      synchronizing = true;
      target.timeScale().setVisibleLogicalRange(range);
      synchronizing = false;
    };
    const priceRangeHandler = syncRange(priceChart, volumeChart);
    const volumeRangeHandler = syncRange(volumeChart, priceChart);
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(priceRangeHandler);
    volumeChart.timeScale().subscribeVisibleLogicalRangeChange(volumeRangeHandler);
    const fixedRange = intradayRange(data[0].date);
    priceChart.timeScale().setVisibleRange(fixedRange);
    volumeChart.timeScale().setVisibleRange(fixedRange);

    const publishHover = (time?: Time) => {
      if (time == null) return setHoverIndex(null);
      setHoverIndex(indexByTime.get(String(time)) ?? null);
    };
    priceChart.subscribeCrosshairMove((param) => publishHover(param.time));
    volumeChart.subscribeCrosshairMove((param) => publishHover(param.time));
    const observer = new ResizeObserver(() => {
      if (priceElement.clientWidth > 0 && priceElement.clientHeight > 0) {
        priceChart.applyOptions({ width: priceElement.clientWidth, height: priceElement.clientHeight });
      }
      if (volumeElement.clientWidth > 0 && volumeElement.clientHeight > 0) {
        volumeChart.applyOptions({ width: volumeElement.clientWidth, height: volumeElement.clientHeight });
      }
    });
    observer.observe(priceElement);
    observer.observe(volumeElement);
    return () => {
      observer.disconnect();
      priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(priceRangeHandler);
      volumeChart.timeScale().unsubscribeVisibleLogicalRangeChange(volumeRangeHandler);
      priceChart.remove();
      volumeChart.remove();
    };
  }, [averagePrices, chartSurface, data]);

  const active = data[hoverIndex ?? data.length - 1];
  const average = averagePrices[hoverIndex ?? data.length - 1];
  return <div className="daily-intraday-chart-shell">
    <div className="daily-intraday-legend" aria-live="polite">
      <span className="price">价格 {formatNumber(active.close)}</span>
      <span className="average">均价 {formatNumber(average)}</span>
      <span>成交量 {formatVolume(active.volume)}</span>
      <span>{active.date.slice(11, 16)}</span>
    </div>
    <div ref={priceRef} className="daily-intraday-price-chart" aria-label="所选交易日一分钟价格与均价走势" />
    <div ref={volumeRef} className="daily-intraday-volume-chart" aria-label="所选交易日一分钟成交量" />
  </div>;
}

export default function DailyIntradayModal({ open, symbol, name, date, onClose }: DailyIntradayModalProps) {
  const [data, setData] = useState<IntradayBar[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Pick<MinuteBarsResponse, 'sourceFiles' | 'elapsedMs' | 'truncated'> | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!open || !symbol || !date) return undefined;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData([]);
    setMeta(null);
    void apiFetch<MinuteBarsResponse>(buildDailyIntradayPath(symbol, date), {
      signal: controller.signal,
      timeoutMs: 60_000,
    }).then((response) => {
      if (response.intervalMinutes !== 1) throw new Error('服务端未返回 1 分钟行情');
      setData(response.items);
      setMeta({ sourceFiles: response.sourceFiles, elapsedMs: response.elapsedMs, truncated: response.truncated });
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : '日内走势加载失败');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [date, open, retry, symbol]);

  const first = data[0];
  const last = data[data.length - 1];
  const changePct = first?.open ? (last.close - first.open) / first.open * 100 : null;
  return <Modal
    className="daily-intraday-modal"
    open={open}
    onCancel={onClose}
    footer={null}
    destroyOnHidden
    width={920}
    title={<Space size={8} wrap>
      <span>{name || symbol} · {date} 日内走势</span>
      <Tag color="blue">1 分钟</Tag>
    </Space>}
  >
    <div className="daily-intraday-summary">
      <Text type="secondary">{symbol}</Text>
      {first && last && <>
        <Text>开 {formatNumber(first.open)}</Text>
        <Text>高 {formatNumber(Math.max(...data.map((item) => item.high)))}</Text>
        <Text>低 {formatNumber(Math.min(...data.map((item) => item.low)))}</Text>
        <Text>收 {formatNumber(last.close)}</Text>
        <Text className={(changePct ?? 0) >= 0 ? 'market-up' : 'market-down'}>
          {changePct == null ? '—' : `${changePct >= 0 ? '+' : ''}${formatNumber(changePct)}%`}
        </Text>
      </>}
      {meta && <Text type="secondary">{data.length} 根 · {meta.elapsedMs}ms{meta.truncated ? ' · 数据已截断' : ''}</Text>}
    </div>
    {loading && <div className="daily-intraday-loading" role="status" aria-label="正在加载日内走势">
      <Skeleton active paragraph={{ rows: 8 }} />
    </div>}
    {!loading && error && <Alert
      type="error"
      showIcon
      message="日内走势加载失败"
      description={error}
      action={<Button onClick={() => setRetry((value) => value + 1)}>重新加载</Button>}
    />}
    {!loading && !error && data.length === 0 && <Empty description="该交易日暂无分钟数据" />}
    {!loading && !error && data.length > 0 && <DailyIntradayChart data={data} />}
  </Modal>;
}
