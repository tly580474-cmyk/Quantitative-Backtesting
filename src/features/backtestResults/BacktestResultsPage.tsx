import { useEffect, useState } from 'react';
import {
  Button,
  Popconfirm,
  Tag,
  Typography,
  Empty,
  Space,
  Tabs,
  Select,
  Checkbox,
  Switch,
} from 'antd';
import {
  DeleteOutlined,
  EyeOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import { useBacktestStore } from '@/stores/useBacktestStore';
import { WorkbenchPanel } from '@/components/WorkbenchPanel';
import ResultsOverview from './ResultsOverview';
import EquityChart from './EquityChart';
import TradeList from './TradeList';
import type { BacktestResult } from '@/models';
import type { Candle } from '@/models';
import { getRepository } from '@/api/useRepository';
import { normalizeBenchmark, normalizeDcaEquity, toEquitySeries } from './comparison';
import { createTradeMarkers } from './tradeMarkers';
import { getAllStrategies } from '@/features/strategies/registry';
import { getResultStrategyName } from './resultLabel';
import type { SeriesMarker, Time } from 'lightweight-charts';

const { Text } = Typography;

const COMPARISON_COLORS = ['#1677FF', '#E8590C', '#2B8A3E', '#862E9C', '#087F5B', '#C92A2A', '#5F3DC4', '#0B7285'];

function comparisonColor(index: number): string {
  return COMPARISON_COLORS[index] ?? `hsl(${(index * 137.5) % 360} 68% 42%)`;
}

function contributionBase(result: BacktestResult): number {
  return result.metrics.netContributions ?? result.metrics.initialCapital;
}

function normalizeStrategyEquity(points: BacktestResult['equityCurve'], initialCapital: number): Array<{ time: string; value: number }> {
  if (initialCapital <= 0) return [];
  return points.map((p) => ({ time: p.time, value: p.equity / initialCapital * 100 }));
}

export default function BacktestResultsPage() {
  const results = useBacktestStore((s) => s.results);
  const selectedIds = useBacktestStore((s) => s.selectedResultIds);
  const loadResults = useBacktestStore((s) => s.loadResults);
  const removeResult = useBacktestStore((s) => s.removeResult);
  const toggleSelection = useBacktestStore((s) => s.toggleResultSelection);
  const clearSelection = useBacktestStore((s) => s.clearSelection);
  const selectAll = useBacktestStore((s) => s.selectAllResults);
  const removeResults = useBacktestStore((s) => s.removeResults);

  const [activeResultId, setActiveResultId] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [sortOrder, setSortOrder] = useState<'time' | 'profitDesc' | 'profitAsc'>('time');
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [benchmarkCandles, setBenchmarkCandles] = useState<Candle[]>([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [showBuyMarkers, setShowBuyMarkers] = useState(true);
  const [showCostCurve, setShowCostCurve] = useState(false);
  const [strategyNames, setStrategyNames] = useState<Record<string, string>>(() => ({
    dca: '定投策略',
    ...Object.fromEntries(getAllStrategies().map((strategy) => [strategy.id, strategy.name])),
  }));

  useEffect(() => {
    loadResults();
    getRepository().getAllVisualStrategies()
      .then((strategies) => {
        setStrategyNames((current) => ({
          ...current,
          ...Object.fromEntries(strategies.map((strategy) => [strategy.id, strategy.name])),
        }));
      })
      .catch(() => undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sortedResults = [...results].sort((a, b) => {
    if (sortOrder === 'time') return b.startedAt.localeCompare(a.startedAt);
    const profitA = a.metrics.finalEquity - contributionBase(a);
    const profitB = b.metrics.finalEquity - contributionBase(b);
    return sortOrder === 'profitDesc' ? profitB - profitA : profitA - profitB;
  });
  const selectedResults = sortedResults.filter((r) => selectedIds.includes(r.id) && r.status === 'completed');
  const activeResult = sortedResults.find((r) => r.id === activeResultId) ?? null;

  const handleView = (r: BacktestResult) => {
    setActiveResultId(r.id);
    setCompareMode(false);
    setShowBenchmark(false);
    setBenchmarkCandles([]);
    setShowBuyMarkers(true);
    setShowCostCurve(false);
  };

  useEffect(() => {
    if (!showBenchmark || !activeResult) return;
    let active = true;
    setBenchmarkLoading(true);
    getRepository().getCandlesByDataset(activeResult.datasetSnapshot.id)
      .then((candles) => {
        if (active) setBenchmarkCandles(candles);
      })
      .finally(() => {
        if (active) setBenchmarkLoading(false);
      });
    return () => { active = false; };
  }, [showBenchmark, activeResult]);

  useEffect(() => {
    if (sortedResults.length === 0) {
      setActiveResultId(null);
      setCompareMode(false);
      return;
    }
    if (activeResultId && sortedResults.some((result) => result.id === activeResultId)) return;
    setActiveResultId(sortedResults.find((result) => result.status === 'completed')?.id ?? sortedResults[0].id);
  }, [activeResultId, sortedResults]);

  useEffect(() => {
    if (compareMode && selectedResults.length < 2) {
      setCompareMode(false);
    }
  }, [compareMode, selectedResults.length]);

  const handleCompare = () => {
    if (selectedResults.length >= 2) {
      setCompareMode(true);
    }
  };

  const strategyNameFor = (result: BacktestResult) =>
    getResultStrategyName(result, strategyNames);

  return (
    <div className="results-page">
      <div className="results-toolbar">
        <div className="results-toolbar-title">
          <Text strong>回测结果复盘</Text>
          <Text type="secondary">{results.length} 条历史记录 · {selectedResults.length} 条可对比</Text>
        </div>
        <Space wrap className="results-toolbar-actions">
          <Select
            aria-label="回测结果排序"
            value={sortOrder}
            onChange={setSortOrder}
            style={{ width: 160 }}
            options={[{ label: '按时间排序', value: 'time' }, { label: '收益金额从高到低', value: 'profitDesc' }, { label: '收益金额从低到高', value: 'profitAsc' }]}
          />
          <Button
            icon={<SwapOutlined />}
            onClick={handleCompare}
            disabled={selectedResults.length < 2}
          >
            对比所选 ({selectedResults.length})
          </Button>
          {selectedIds.length > 0 && (
            <Button onClick={clearSelection}>清除选择</Button>
          )}
          <Checkbox
            checked={results.length > 0 && selectedIds.length === results.length}
            indeterminate={selectedIds.length > 0 && selectedIds.length < results.length}
            onChange={(event) => event.target.checked ? selectAll() : clearSelection()}
          >
            全选
          </Checkbox>
          <Popconfirm
            title={`确定删除选中的 ${selectedIds.length} 条结果？`}
            onConfirm={() => removeResults(selectedIds)}
            disabled={selectedIds.length === 0}
          >
            <Button danger icon={<DeleteOutlined />} disabled={selectedIds.length === 0}>
              删除所选
            </Button>
          </Popconfirm>
        </Space>
      </div>

      <div className="results-workbench">
        <aside className="results-history-panel">
          <WorkbenchPanel
            title="结果队列"
            subtitle="选择、排序与批量对比"
          >
            {results.length === 0 ? (
              <Empty className="results-empty" description="暂无回测结果" />
            ) : (
              <div
                className="results-list"
                role="list"
                aria-label="历史回测结果"
              >
                {sortedResults.map((r) => {
                  const isSelected = selectedIds.includes(r.id);
                  const isCompleted = r.status === 'completed';
                  const isActive = r.id === activeResultId && !compareMode;
                  const profitAmount = r.metrics.finalEquity - contributionBase(r);
                  return (
                    <div
                      key={r.id}
                      role="listitem"
                      className={[
                        'result-list-item',
                        isSelected ? 'is-selected' : '',
                        isActive ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => handleView(r)}
                    >
                      <div className="result-list-content">
                        <div className="result-list-title">
                          <Text strong ellipsis>{strategyNameFor(r)}</Text>
                          <Tag color={isCompleted ? 'success' : 'error'}>
                            {isCompleted ? '完成' : r.status === 'failed' ? '失败' : '取消'}
                          </Tag>
                        </div>
                        <div className="result-list-meta">
                          <Text type="secondary">{r.datasetSnapshot.symbol}</Text>
                          <Text type="secondary">{new Date(r.startedAt).toLocaleString('zh-CN')}</Text>
                          <Text type="secondary">{r.datasetSnapshot.startTime} ~ {r.datasetSnapshot.endTime}</Text>
                          {isCompleted && (
                            <Space size={4} wrap>
                              <Tag color="blue">{((r.metrics.totalReturn ?? 0) * 100).toFixed(2)}%</Tag>
                              <Tag color={profitAmount >= 0 ? 'green' : 'red'}>
                                ¥{profitAmount.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
                              </Tag>
                              <Tag>{r.metrics.tradeCount} 笔</Tag>
                            </Space>
                          )}
                        </div>
                      </div>
                      <div className="result-list-actions">
                        <Checkbox
                          checked={isSelected}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleSelection(r.id)}
                          aria-label={`选择 ${strategyNameFor(r)} 回测结果`}
                        />
                        {isCompleted && (
                          <Button
                            type="text"
                            size="small"
                            icon={<EyeOutlined />}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleView(r);
                            }}
                          >
                            打开
                          </Button>
                        )}
                        <Popconfirm
                          title="确定删除此结果？"
                          onConfirm={(event) => {
                            event?.stopPropagation();
                            removeResult(r.id);
                          }}
                          onCancel={(event) => event?.stopPropagation()}
                        >
                          <Button
                            type="text"
                            size="small"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={(event) => event.stopPropagation()}
                            aria-label={`删除 ${strategyNameFor(r)} 回测结果`}
                          />
                        </Popconfirm>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </WorkbenchPanel>
        </aside>

        <main className="results-review-panel">
          {compareMode && selectedResults.length >= 2 ? (
            <section className="results-review-card">
              <div className="results-review-head">
                <div>
                  <Text strong>组合对比</Text>
                  <Text type="secondary">横向比较 {selectedResults.length} 个已完成回测</Text>
                </div>
                <Button onClick={() => setCompareMode(false)}>返回单项复盘</Button>
              </div>
              <Tabs
                items={[
                  {
                    key: 'metrics',
                    label: '指标对比',
                    children: (
                      <div className="results-comparison-grid">
                        {selectedResults.map((r, i) => (
                          <ResultsOverview
                            key={r.id}
                            metrics={r.metrics}
                            name={`${strategyNameFor(r)} · ${r.datasetSnapshot.symbol}`}
                            color={comparisonColor(i)}
                          />
                        ))}
                      </div>
                    ),
                  },
                  {
                    key: 'equity',
                    label: '权益曲线',
                    children: (
                      <EquityChart
                        height={420}
                        series={selectedResults.map((r, i) => ({
                          id: r.id,
                          label: `${strategyNameFor(r)} · ${r.datasetSnapshot.symbol}`,
                          color: comparisonColor(i),
                          data: toEquitySeries(r.equityCurve),
                        }))}
                      />
                    ),
                  },
                ]}
              />
            </section>
          ) : activeResult && activeResult.status === 'completed' ? (
            <section className="results-review-card">
              <div className="results-review-head">
                <div>
                  <Text strong>{strategyNameFor(activeResult)} · {activeResult.datasetSnapshot.symbol}</Text>
                  <Text type="secondary">
                    {activeResult.datasetSnapshot.startTime} ~ {activeResult.datasetSnapshot.endTime}
                  </Text>
                </div>
                <Space wrap>
                  <Tag color={(activeResult.metrics.finalEquity - contributionBase(activeResult)) >= 0 ? 'green' : 'red'}>
                    收益 {((activeResult.metrics.totalReturn ?? 0) * 100).toFixed(2)}%
                  </Tag>
                  <Tag color="blue">{activeResult.metrics.tradeCount} 笔交易</Tag>
                </Space>
              </div>
              <Tabs
                items={[
                  {
                    key: 'overview',
                    label: '绩效指标',
                    children: (
                      <ResultsOverview metrics={activeResult.metrics} name="" />
                    ),
                  },
                  {
                    key: 'chart',
                    label: '权益曲线',
                    children: (
                      <Space direction="vertical" style={{ width: '100%' }} size={8}>
                        <div className="benchmark-toggle-row">
                          <Space wrap>
                            <Switch
                              checked={showBenchmark}
                              loading={benchmarkLoading}
                              onChange={setShowBenchmark}
                              aria-label="显示同期指数变化"
                            />
                            <Text>显示同期指数变化</Text>
                            <Switch
                              checked={showBuyMarkers}
                              onChange={setShowBuyMarkers}
                              aria-label="显示买卖点"
                            />
                            <Text>显示买卖点</Text>
                            {activeResult.config.backtestMode === 'dca' && (
                              <>
                                <Switch
                                  checked={showCostCurve}
                                  onChange={setShowCostCurve}
                                  aria-label="显示成本曲线"
                                />
                                <Text>显示成本曲线</Text>
                              </>
                            )}
                            {showBenchmark && (
                              <Text type="secondary">
                                {activeResult.config.backtestMode === 'dca'
                                  ? '蓝线为当前权益 ÷ 累计投入 × 100，橙线为同期指数首日归一至 100'
                                  : '蓝线为策略权益归一至 100，橙线为同期指数首日归一至 100'}
                              </Text>
                            )}
                            {showBenchmark && !benchmarkLoading && benchmarkCandles.length === 0 && (
                              <Text type="danger">原行情数据集不可用，暂时无法显示同期指数</Text>
                            )}
                          </Space>
                        </div>
                        <EquityChart
                          key={`${activeResult.id}-${showBenchmark ? 'b' : ''}${showCostCurve ? 'c' : ''}`}
                          height={420}
                          series={(() => {
                            const builtSeries: Array<{
                              id: string;
                              label: string;
                              color: string;
                              valueFormat: 'currency' | 'normalized';
                              data: Array<{ time: string; value: number; costBasis?: number }>;
                              markers?: Array<SeriesMarker<Time>>;
                              showChange?: boolean;
                              dashed?: boolean;
                            }> = [];

                            const isDCA = activeResult.config.backtestMode === 'dca';
                            const markers = showBuyMarkers
                              ? createTradeMarkers(activeResult.trades, isDCA ? ['buy'] : ['buy', 'sell'])
                              : undefined;

                            if (showBenchmark) {
                              builtSeries.push({
                                id: `${activeResult.id}-normalized`,
                                label: isDCA ? '定投累计收益' : '策略权益',
                                color: '#1677FF',
                                valueFormat: 'normalized',
                                data: isDCA
                                  ? normalizeDcaEquity(activeResult.equityCurve)
                                  : normalizeStrategyEquity(activeResult.equityCurve, activeResult.metrics.initialCapital),
                                markers,
                              });
                              builtSeries.push({
                                id: `${activeResult.id}-benchmark`,
                                label: `${activeResult.datasetSnapshot.symbol} 同期指数`,
                                color: '#E8590C',
                                valueFormat: 'normalized',
                                data: normalizeBenchmark(
                                  benchmarkCandles,
                                  activeResult.datasetSnapshot.startTime,
                                  activeResult.datasetSnapshot.endTime,
                                ),
                              });
                            } else {
                              builtSeries.push({
                                id: activeResult.id,
                                label: activeResult.datasetSnapshot.name || activeResult.datasetSnapshot.symbol,
                                color: '#1677FF',
                                valueFormat: 'currency',
                                data: toEquitySeries(activeResult.equityCurve),
                                markers,
                              });
                            }

                            if (showCostCurve && isDCA) {
                              const costData = activeResult.equityCurve
                                .filter((p) => (p.contributedCapital ?? 0) > 0)
                                .map((p) => ({
                                  time: p.time,
                                  value: p.contributedCapital!,
                                }));
                              if (costData.length > 0) {
                                builtSeries.push({
                                  id: `${activeResult.id}-cost`,
                                  label: '累计投入成本',
                                  color: '#2B8A3E',
                                  valueFormat: 'currency',
                                  data: costData,
                                  showChange: false,
                                  dashed: true,
                                });
                              }
                            }

                            return builtSeries;
                          })()}
                        />
                      </Space>
                    ),
                  },
                  {
                    key: 'trades',
                    label: `交易明细 (${activeResult.trades.filter((t) => t.quantity > 0).length})`,
                    children: <TradeList trades={activeResult.trades} />,
                  },
                ]}
              />
            </section>
          ) : (
            <div className="results-review-empty">
              <Empty description={results.length === 0 ? '暂无回测结果' : '请选择一条已完成结果进行复盘'} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
