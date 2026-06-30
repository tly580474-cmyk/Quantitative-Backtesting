import { useMemo } from 'react';
import { Alert, Collapse, Progress, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, InfoCircleOutlined, MinusCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { calculateSelectionScore, type SelectionScoreTier } from './selectionScore';
import type { KlinePoint } from './types';

const { Text, Title } = Typography;

const TIER_COLORS: Record<SelectionScoreTier, string> = {
  core: '#cf1322',
  watch: '#d46b08',
  weak: '#475569',
  blocked: '#262626',
};

export default function StockSelectionScore({
  candles,
  benchmarkCandles,
  loading,
}: {
  candles: KlinePoint[];
  benchmarkCandles: KlinePoint[];
  loading: boolean;
}) {
  const result = useMemo(
    () => calculateSelectionScore(candles, benchmarkCandles),
    [benchmarkCandles, candles],
  );

  if (loading && candles.length === 0) {
    return (
      <section className="stock-selection-score" aria-label="选股评分">
        <Skeleton active paragraph={{ rows: 3 }} />
      </section>
    );
  }

  if (result.status === 'insufficient' || result.score == null || result.tier == null) {
    return (
      <section className="stock-selection-score" aria-label="选股评分">
        <Alert
          type="info"
          showIcon
          message="选股评分暂不可用"
          description={result.message}
        />
      </section>
    );
  }

  const tierColor = TIER_COLORS[result.tier];

  return (
    <section className="stock-selection-score" aria-label="选股评分" aria-live="polite">
      <div className="stock-score-header">
        <div className="stock-score-gauge">
          <Progress
            type="circle"
            percent={result.score}
            size={104}
            strokeColor={tierColor}
            trailColor="#e2e8f0"
            format={(value) => (
              <span className="stock-score-number" style={{ color: tierColor }}>
                {value}
                <small>分</small>
              </span>
            )}
          />
        </div>

        <div className="stock-score-summary">
          <Space wrap align="center">
            <Title level={4} style={{ margin: 0 }}>选股评分</Title>
            <Tag color={tierColor}>{result.tierLabel}</Tag>
          </Space>
          <Text>{result.tierDescription}</Text>
          <Space wrap size={[6, 6]} className="stock-score-meta">
            <Tag color="blue">技术面 {result.rawPositiveScore}/100</Tag>
            <Tag color={result.riskDeduction > 0 ? 'error' : 'success'}>
              风控 -{result.riskDeduction}
            </Tag>
            {result.forcedCooling && <Tag color="error">流动性强制冷却</Tag>}
            <Tag>{result.asOf} · {result.sampleSize} 根日 K</Tag>
          </Space>
        </div>

        <div className="stock-score-scale" aria-label="评分档位">
          <span><b className="is-core">75–100</b> 核心优选</span>
          <span><b className="is-watch">60–74</b> 观察备选</span>
          <span><b className="is-weak">45–59</b> 弱势观察</span>
          <span><b className="is-blocked">＜45</b> 冷却剔除</span>
        </div>
      </div>

      <Collapse
        ghost
        className="stock-score-breakdown"
        items={result.sections.map((scoreSection) => ({
          key: scoreSection.key,
          label: (
            <div className="stock-score-section-label">
              <span>{scoreSection.title}</span>
              <Tag color={scoreSection.score < 0 ? 'error' : 'blue'}>
                {scoreSection.score > 0 ? '+' : ''}{scoreSection.score}
                {scoreSection.maxScore == null ? '' : ` / ${scoreSection.maxScore}`}
              </Tag>
            </div>
          ),
          children: (
            <div className="stock-score-rules">
              {scoreSection.items.map((item) => (
                <div
                  className={`stock-score-rule${item.matched ? ' is-matched' : ''}${item.kind === 'penalty' ? ' is-penalty' : ''}`}
                  key={item.label}
                >
                  {item.matched
                    ? item.kind === 'penalty'
                      ? <WarningOutlined aria-hidden />
                      : <CheckCircleOutlined aria-hidden />
                    : <MinusCircleOutlined aria-hidden />}
                  <span>
                    <b>{item.label}</b>
                    <small>{item.detail}</small>
                  </span>
                  <Tag color={item.points > 0 ? 'success' : item.points < 0 ? 'error' : 'default'}>
                    {item.points > 0 ? '+' : ''}{item.points}
                  </Tag>
                </div>
              ))}
            </div>
          ),
        }))}
      />

      <div className="stock-score-footnote">
        <Tooltip title={result.assumptions.map((item) => <div key={item}>{item}</div>)}>
          <Text type="secondary"><InfoCircleOutlined /> 评分口径与量化代理</Text>
        </Tooltip>
      </div>
    </section>
  );
}
