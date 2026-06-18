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

const { Text } = Typography;

const COMPARISON_COLORS = ['#1677FF', '#FF5722', '#4CAF50'];

export default function BacktestResultsPage() {
  const results = useBacktestStore((s) => s.results);
  const selectedIds = useBacktestStore((s) => s.selectedResultIds);
  const loadResults = useBacktestStore((s) => s.loadResults);
  const removeResult = useBacktestStore((s) => s.removeResult);
  const toggleSelection = useBacktestStore((s) => s.toggleResultSelection);
  const clearSelection = useBacktestStore((s) => s.clearSelection);

  const [detailResult, setDetailResult] = useState<BacktestResult | null>(null);
  const [compareMode, setCompareMode] = useState(false);

  useEffect(() => {
    loadResults();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedResults = results.filter((r) => selectedIds.includes(r.id));

  const handleView = (r: BacktestResult) => {
    setDetailResult(r);
    setCompareMode(false);
  };

  const handleCompare = () => {
    if (selectedResults.length >= 2) {
      setDetailResult(null);
      setCompareMode(true);
    }
  };

  return (
    <div style={{ padding: 16, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text strong style={{ fontSize: 16 }}>历史回测结果</Text>
        <Space>
          <Button
            icon={<SwapOutlined />}
            onClick={handleCompare}
            disabled={selectedResults.length < 2}
          >
            对比所选 ({selectedResults.length}/3)
          </Button>
          {selectedResults.length > 0 && (
            <Button onClick={clearSelection}>清除选择</Button>
          )}
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
                        color={COMPARISON_COLORS[i]}
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
                      label: r.id,
                      color: COMPARISON_COLORS[i],
                      data: r.equityCurve,
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
        destroyOnClose
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
                  <EquityChart
                    height={350}
                    series={[
                      {
                        label: detailResult.id,
                        color: '#1677FF',
                        data: detailResult.equityCurve,
                      },
                    ]}
                  />
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
          dataSource={results}
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
