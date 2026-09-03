import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { App, Space, Tag, Typography } from 'antd';
import {
  CheckOutlined,
  DotChartOutlined,
  DownOutlined,
  FilterOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../api/client';
import StockSelectionWorkspace from '../marketData/StockSelectionWorkspace';
import { marketDataCache } from '../marketData/marketDataCache';
import type { FactorSelectionHistory, StockSearchItem } from '../marketData/types';
import FactorSelectionPanel from './FactorSelectionPanel';
import SelectionExportButton from './SelectionExportButton';
import { exportFactorSelection, type SelectionExportFormat } from './selectionExport';
import { PageHeader } from '@/components/WorkspacePrimitives';

const { Text } = Typography;
const WATCHLIST_KEY = 'quant-market-watchlist-v1';
const PINNED_WATCHLIST_KEY = 'quant-market-watchlist-pinned-v1';
const ACTIVE_STRATEGY_KEY = 'quant-stock-selection-active-strategy-v1';
type SelectionStrategy = 'technical' | 'factor';

function readArray<T>(key: string): T[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

export default function StockSelectionPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [watchlist, setWatchlist] = useState<StockSearchItem[]>(() => readArray(WATCHLIST_KEY));
  const [pinnedCodes, setPinnedCodes] = useState<string[]>(() => readArray(PINNED_WATCHLIST_KEY));
  const [selectedCode, setSelectedCode] = useState(() => watchlist[0]?.code ?? '');
  const [history, setHistory] = useState<FactorSelectionHistory | null>(null);
  const [factorLoading, setFactorLoading] = useState(false);
  const [strategyMenuOpen, setStrategyMenuOpen] = useState(false);
  const [activeStrategy, setActiveStrategy] = useState<SelectionStrategy>(() => (
    localStorage.getItem(ACTIVE_STRATEGY_KEY) === 'factor' ? 'factor' : 'technical'
  ));
  const [selectedFactorDate, setSelectedFactorDate] = useState('');
  const strategyTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedOptionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
    marketDataCache.watchlist = watchlist;
  }, [watchlist]);
  useEffect(() => {
    localStorage.setItem(PINNED_WATCHLIST_KEY, JSON.stringify(pinnedCodes));
  }, [pinnedCodes]);
  useEffect(() => {
    localStorage.setItem(ACTIVE_STRATEGY_KEY, activeStrategy);
  }, [activeStrategy]);
  useEffect(() => {
    if (strategyMenuOpen) selectedOptionRef.current?.focus();
  }, [strategyMenuOpen]);

  const loadFactorHistory = useCallback(async (force = false) => {
    setFactorLoading(true);
    try {
      const result = await apiFetch<FactorSelectionHistory>(
        `/api/market-data/factor-selection?limit=100${force ? '&force=true' : ''}`,
        { timeoutMs: 180000 },
      );
      setHistory(result);
      if (force) message.success(`已更新 ${result.dataAsOf} 的 13 因子选股结果`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '13 因子选股加载失败');
    } finally {
      setFactorLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void loadFactorHistory(false);
  }, [loadFactorHistory]);

  const addStock = useCallback((stock: StockSearchItem, price?: number) => {
    setWatchlist((current) => {
      if (current.some((item) => item.code === stock.code)) return current;
      return [...current, {
        ...stock,
        addedAt: new Date().toISOString(),
        addedPrice: price != null && price > 0 ? price : undefined,
      }];
    });
    setSelectedCode(stock.code);
    message.success(`${stock.name} 已加入自选`);
  }, [message]);

  const removeStock = useCallback((code: string) => {
    setWatchlist((current) => current.filter((item) => item.code !== code));
    setPinnedCodes((current) => current.filter((item) => item !== code));
  }, []);

  const openDetail = useCallback((stock: StockSearchItem) => {
    marketDataCache.selectedCode = stock.code;
    navigate(`/market-detail/${stock.code}`);
  }, [navigate]);

  const latestCount = history?.batches[0]?.items.length;
  const strategies: Array<{
    key: SelectionStrategy;
    title: string;
    tag: string;
    description: string;
    icon: ReactNode;
    count?: number;
  }> = [
    {
      key: 'technical',
      title: '技术选股',
      tag: '量价与指标',
      description: '按实时或盘后行情设置筛选条件',
      icon: <FilterOutlined />,
    },
    {
      key: 'factor',
      title: '13 因子选股',
      tag: '中性化',
      description: '基本面、规模与换手率多维等权排序',
      icon: <DotChartOutlined />,
      count: latestCount,
    },
  ];
  const selectedStrategy = strategies.find((item) => item.key === activeStrategy) ?? strategies[0];
  const selectedFactorBatch = history?.batches.find((item) => item.tradeDate === selectedFactorDate)
    ?? history?.batches[0]
    ?? null;

  const handleFactorExport = (format: SelectionExportFormat) => {
    if (!history || !selectedFactorBatch?.items.length) {
      message.warning('暂无可导出的因子选股结果');
      return;
    }
    try {
      const fileName = exportFactorSelection(history, selectedFactorBatch, format);
      message.success(`已导出 ${fileName}`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '选股结果导出失败');
    }
  };

  const chooseStrategy = (strategy: SelectionStrategy) => {
    setActiveStrategy(strategy);
    setStrategyMenuOpen(false);
    window.requestAnimationFrame(() => strategyTriggerRef.current?.focus());
  };

  const handleStrategyMenuKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      setStrategyMenuOpen(false);
      strategyTriggerRef.current?.focus();
    }
  };

  return <main className="stock-selection-page">
    <PageHeader title="选股工作台" description="切换选股方法，查看当日结果与历史表现。"
      actions={<Space size={8}><Tag>{strategies.length} 种方法</Tag><Text type="secondary">数据截至 {history?.dataAsOf ?? '加载中'}</Text></Space>} />

    <section className="stock-selection-strategy-picker" aria-label="选股策略">
      <div className={`stock-selection-strategy-trigger${strategyMenuOpen ? ' is-open' : ''}`}>
        <button
          ref={strategyTriggerRef}
          type="button"
          className="stock-selection-strategy-toggle"
          aria-label="切换选股策略"
          aria-expanded={strategyMenuOpen}
          aria-controls="stock-selection-strategy-options"
          onClick={() => setStrategyMenuOpen((open) => !open)}
        >
          <DownOutlined className="stock-selection-strategy-arrow" />
        </button>
        <span className="stock-selection-strategy-icon">{selectedStrategy.icon}</span>
        <span className="stock-selection-strategy-current">
          <span>
            <strong>{selectedStrategy.title}</strong>
            <Tag color={activeStrategy === 'factor' ? 'geekblue' : 'blue'}>{selectedStrategy.tag}</Tag>
            {selectedStrategy.count != null && <Tag>{selectedStrategy.count} 只</Tag>}
          </span>
          <Text type="secondary">{selectedStrategy.description}</Text>
        </span>
        {activeStrategy === 'factor' && <SelectionExportButton
          disabled={!selectedFactorBatch?.items.length || factorLoading}
          onExport={handleFactorExport}
        />}
        <Text type="secondary" className="stock-selection-strategy-hint">
          {strategyMenuOpen ? '选择一个策略' : '点击箭头切换策略'}
        </Text>
      </div>

      {strategyMenuOpen && <div
        id="stock-selection-strategy-options"
        className="stock-selection-strategy-options"
        role="listbox"
        aria-label="可用选股策略"
        onKeyDown={handleStrategyMenuKeyDown}
      >
        {strategies.map((strategy) => {
          const selected = strategy.key === activeStrategy;
          return <button
            key={strategy.key}
            ref={selected ? selectedOptionRef : undefined}
            type="button"
            role="option"
            aria-selected={selected}
            className={`stock-selection-strategy-option${selected ? ' is-selected' : ''}`}
            onClick={() => chooseStrategy(strategy.key)}
          >
            <span className="stock-selection-strategy-option-icon">{strategy.icon}</span>
            <span>
              <strong>{strategy.title}</strong>
              <small>{strategy.description}</small>
            </span>
            <span className="stock-selection-strategy-option-meta">
              <Tag color={strategy.key === 'factor' ? 'geekblue' : 'blue'}>{strategy.tag}</Tag>
              {strategy.count != null && <Tag>{strategy.count} 只</Tag>}
              {selected && <CheckOutlined aria-label="当前策略" />}
            </span>
          </button>;
        })}
      </div>}

      <div className="stock-selection-active-panel">
        {activeStrategy === 'technical'
          ? <StockSelectionWorkspace
            embedded
            mode="screen"
            watchlist={watchlist}
            selectedCode={selectedCode}
            pinnedCodes={pinnedCodes}
            benchmarkCandles={[]}
            onSelect={setSelectedCode}
            onTogglePin={(code) => setPinnedCodes((current) => (
              current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
            ))}
            onAdd={(stock) => addStock(stock)}
            onRemove={removeStock}
            onOpenDetail={openDetail}
          />
          : <FactorSelectionPanel
            history={history}
            loading={factorLoading}
            watchlist={watchlist}
            onRefresh={() => void loadFactorHistory(true)}
            onAdd={addStock}
            onOpenDetail={openDetail}
            selectedDate={selectedFactorDate}
            onSelectedDateChange={setSelectedFactorDate}
          />}
      </div>
    </section>
  </main>;
}
