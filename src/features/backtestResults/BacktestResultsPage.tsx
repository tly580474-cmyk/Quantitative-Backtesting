import { useEffect, useState } from 'react';
import {
  List,
  Button,
  Popconfirm,
  Tag,
  Typography,
  Empty,
  Space,
  Modal,
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
import ResultsOverview from './ResultsOverview';
import EquityChart from './EquityChart';
import TradeList from './TradeList';
import type { BacktestResult } from '@/models';
import type { Candle } from '@/models';
import { getCandlesByDataset } from '@/db/marketDataRepository';
import { normalizeBenchmark, normalizeDcaEquity, toEquitySeries } from './comparison';
import type { SeriesMarker, Time } from 'lightweight-charts';

const { Text } = Typography;

const COMPARISON_COLORS = ['#1677FF', '#E8590C', '#2B8A3E', '#862E9C', '#087F5B', '#C92A2A', '#5F3DC4', '#0B7285'];

function comparisonColor(index: number): string {
  return COMPARISON_COLORS[index] ?? `hsl(${(index * 137.5) % 360} 68% 42%)`;
}

function contributionBase(result: BacktestResult): number {
  return result.metrics.netContributions ?? result.metrics.initialCapital;
}

function createBuyMarkers(trades: BacktestResult['trades']): SeriesMarker<Time>[] {
  return trades
    .filter((t) => t.side === 'buy' && t.quantity > 0)
    .map((t) => ({
      time: t.time as Time,
      position: 'belowBar' as const,
      color: '#E8590C',
      shape: 'arrowUp' as const,
      text: '买',
      size: 2,
    }));
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

  const [detailResult, setDetailResult] = useState<BacktestResult | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [sortOrder, setSortOrder] = useState<'time' | 'profitDesc' | 'profitAsc'>('time');
  const [showBenchmark, setShowBenchmark] = useState(false);
  const [benchmarkCandles, setBenchmarkCandles] = useState<Candle[]>([]);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [showBuyMarkers, setShowBuyMarkers] = useState(true);
  const [showCostCurve, setShowCostCurve] = useState(false);

  useEffect(() => {
    loadResults();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedResults = results.filter((r) => selectedIds.includes(r.id) && r.status === 'completed');
  const sortedResults = [...results].sort((a, b) => {
    if (sortOrder === 'time') return b.startedAt.localeCompare(a.startedAt);
    const profitA = a.metrics.finalEquity - contributionBase(a);
    const profitB = b.metrics.finalEquity - contributionBase(b);
    return sortOrder === 'profitDesc' ? profitB - profitA : profitA - profitB;
  });

  const handleView = (r: BacktestResult) => {
    setDetailResult(r);
    setCompareMode(false);
    setShowBenchmark(false);
    setBenchmarkCandles([]);
    setShowBuyMarkers(true);
    setShowCostCurve(false);
  };

  useEffect(() => {
    if (!showBenchmark || !detailResult || detailResult.config.backtestMode !== 'dca') return;
    let active = true;
    setBenchmarkLoading(true);
    getCandlesByDataset(detailResult.datasetSnapshot.id)
      .then((candles) => {
        if (active) setBenchmarkCandles(candles);
      })
      .finally(() => {
        if (active) setBenchmarkLoading(false);
      });
    return () => { active = false; };
  }, [showBenchmark, detailResult]);

  const handleCompare = () => {
    if (selectedResults.length >= 2) {
      setDetailResult(null);
      setCompareMode(true);
    }
  };

  return (
    <div className="results-page">
      <div className="results-toolbar">
        <Text strong style={{ fontSize: 16 }}>历史回测结果</Text>
        <Space wrap>
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

      {/* Comparison view */}
      {compareMode && selectedResults.length >= 2 && (
        <div style={{ marginBottom: 16 }}>
          <Tabs
            items={[
              {
                key: 'metrics',
                label: '指标对比',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }}>
                    {selectedResults.map((r, i) => (
                      <ResultsOverview
                        key={r.id}
                        metrics={r.metrics}
                        name={r.name}
                        color={comparisonColor(i)}
                      />
                    ))}
                  </Space>
                ),
              },
              {
                key: 'equity',
                label: '权益曲线',
                children: (
                  <EquityChart
                    height={400}
                    series={selectedResults.map((r, i) => ({
                      id: r.id,
                      label: r.datasetSnapshot.name || r.datasetSnapshot.symbol,
                      color: comparisonColor(i),
                      data: toEquitySeries(r.equityCurve),
                    }))}
                  />
                ),
              },
            ]}
          />
        </div>
      )}

      {/* Detail modal */}
      <Modal
        title={detailResult?.name ?? '回测结果'}
        open={detailResult !== null}
        onCancel={() => setDetailResult(null)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        {detailResult && (
          <Tabs
            items={[
              {
                key: 'overview',
                label: '绩效指标',
                children: (
                  <ResultsOverview metrics={detailResult.metrics} name="" />
                ),
              },
              {
                key: 'chart',
                label: '权益曲线',
                children: (
                  <Space direction="vertical" style={{ width: '100%' }} size={8}>
                    {detailResult.config.backtestMode === 'dca' && (
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
                            aria-label="显示买点"
                          />
                          <Text>显示买点</Text>
                          <Switch
                            checked={showCostCurve}
                            onChange={setShowCostCurve}
                            aria-label="显示成本曲线"
                          />
                          <Text>显示成本曲线</Text>
                          {showBenchmark && (
                            <Text type="secondary">蓝线为当前权益 ÷ 累计投入 × 100，橙线为同期指数首日归一至 100</Text>
                          )}
                          {showBenchmark && !benchmarkLoading && benchmarkCandles.length === 0 && (
                            <Text type="danger">原行情数据集不可用，暂时无法显示同期指数</Text>
                          )}
                        </Space>
                      </div>
                    )}
                    <EquityChart
                      key={`${detailResult.id}-${showBenchmark ? 'b' : ''}${showCostCurve ? 'c' : ''}`}
                      height={350}
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

                        if (showBenchmark && detailResult.config.backtestMode === 'dca') {
                          builtSeries.push({
                            id: `${detailResult.id}-normalized`,
                            label: '定投累计收益',
                            color: '#1677FF',
                            valueFormat: 'normalized',
                            data: normalizeDcaEquity(detailResult.equityCurve),
                            markers: showBuyMarkers ? createBuyMarkers(detailResult.trades) : undefined,
                          });
                          builtSeries.push({
                            id: `${detailResult.id}-benchmark`,
                            label: `${detailResult.datasetSnapshot.symbol} 同期指数`,
                            color: '#E8590C',
                            valueFormat: 'normalized',
                            data: normalizeBenchmark(
                              benchmarkCandles,
                              detailResult.datasetSnapshot.startTime,
                              detailResult.datasetSnapshot.endTime,
                            ),
                          });
                        } else {
                          builtSeries.push({
                            id: detailResult.id,
                            label: detailResult.datasetSnapshot.name || detailResult.datasetSnapshot.symbol,
                            color: '#1677FF',
                            valueFormat: 'currency',
                            data: toEquitySeries(detailResult.equityCurve),
                            markers: detailResult.config.backtestMode === 'dca' && showBuyMarkers
                              ? createBuyMarkers(detailResult.trades)
                              : undefined,
                          });
                        }

                        if (showCostCurve && detailResult.config.backtestMode === 'dca') {
                          const costData = detailResult.equityCurve
                            .filter((p) => (p.contributedCapital ?? 0) > 0)
                            .map((p) => ({
                              time: p.time,
                              value: p.contributedCapital!,
                            }));
                          if (costData.length > 0) {
                            builtSeries.push({
                              id: `${detailResult.id}-cost`,
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
                label: `交易明细 (${detailResult.trades.filter((t) => t.quantity > 0).length})`,
                children: <TradeList trades={detailResult.trades} />,
              },
            ]}
          />
        )}
      </Modal>

      {/* Results list */}
      {results.length === 0 ? (
        <Empty description="暂无回测结果" />
      ) : (
        <List
          dataSource={sortedResults}
          renderItem={(r) => {
            const isSelected = selectedIds.includes(r.id);
            const isCompleted = r.status === 'completed';
            return (
              <List.Item
                style={{
                  background: isSelected ? '#e6f4ff' : undefined,
                  cursor: 'pointer',
                }}
                onClick={() => toggleSelection(r.id)}
                actions={[
                  isCompleted && (
                    <Button
                      key="view"
                      type="link"
                      icon={<EyeOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleView(r);
                      }}
                    >
                      查看
                    </Button>
                  ),
                  <Popconfirm
                    key="delete"
                    title="确定删除此结果？"
                    onConfirm={(e) => {
                      e?.stopPropagation();
                      removeResult(r.id);
                    }}
                    onCancel={(e) => e?.stopPropagation()}
                  >
                    <Button
                      type="link"
                      danger
                      icon={<DeleteOutlined />}
                      onClick={(e) => e.stopPropagation()}
                    >
                      删除
                    </Button>
                  </Popconfirm>,
                ].filter(Boolean)}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      <Text>{r.name}</Text>
                      <Tag color={isCompleted ? 'success' : 'error'}>
                        {isCompleted ? '完成' : r.status === 'failed' ? '失败' : '取消'}
                      </Tag>
                    </Space>
                  }
                  description={
                    <Space size="small">
                      <Text type="secondary">{r.datasetSnapshot.symbol}</Text>
                      <Text type="secondary">
                        {r.datasetSnapshot.startTime} ~ {r.datasetSnapshot.endTime}
                      </Text>
                      {isCompleted && (
                        <>
                          <Tag color="blue">
                            收益: {((r.metrics.totalReturn ?? 0) * 100).toFixed(2)}%
                          </Tag>
                          <Tag color={(r.metrics.finalEquity - contributionBase(r)) >= 0 ? 'green' : 'red'}>
                            金额: ¥{(r.metrics.finalEquity - contributionBase(r)).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
                          </Tag>
                          <Tag>{r.metrics.tradeCount} 笔</Tag>
                        </>
                      )}
                    </Space>
                  }
                />
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );
}
