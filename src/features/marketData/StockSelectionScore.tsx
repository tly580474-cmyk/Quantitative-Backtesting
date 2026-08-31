import { useEffect, useMemo, useState } from 'react';
import { Alert, Collapse, Progress, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, InfoCircleOutlined, MinusCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { apiFetch } from '../../api/client';
import {
  calculateSelectionScore,
  SELECTION_STYLE_OPTIONS,
  type SelectionScoreContext,
  type SelectionScoreTier,
  type SelectionStyleId,
} from './selectionScore';
import { marketDataCache } from './marketDataCache';
import type { KlinePoint, StockQuote } from './types';
import './mobile-detail-score.css';

const { Text, Title } = Typography;
const SCORE_STYLE_KEY = 'quant-selection-score-style-v1';
const SCORE_CONTEXT_CACHE_MS = 5 * 60_000;

const TIER_COLORS: Record<SelectionScoreTier, string> = {
  core: '#cf1322',
  watch: '#d46b08',
  weak: '#475569',
  blocked: '#262626',
};

const COMPACT_SCORE_COLOR = '#2563eb';

export default function StockSelectionScore({
  code,
  candles,
  benchmarkCandles,
  loading,
  quote,
  compact = false,
}: {
  code: string;
  candles: KlinePoint[];
  benchmarkCandles: KlinePoint[];
  loading: boolean;
  quote?: StockQuote | null;
  /** Use the condensed, mobile detail presentation without changing scoring. */
  compact?: boolean;
}) {
  const [styleId, setStyleId] = useState<SelectionStyleId>(() => {
    const stored = localStorage.getItem(SCORE_STYLE_KEY);
    return SELECTION_STYLE_OPTIONS.some((item) => item.value === stored)
      ? stored as SelectionStyleId
      : 'contrarian';
  });
  const [scoreContext, setScoreContext] = useState<SelectionScoreContext>({});
  const [contextCode, setContextCode] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const needsFundamentals = styleId === 'value' || styleId === 'growth';

  useEffect(() => {
    localStorage.setItem(SCORE_STYLE_KEY, styleId);
  }, [styleId]);

  useEffect(() => {
    if (!needsFundamentals) return;
    const cached = marketDataCache.scoreContexts[code];
    if (cached && Date.now() - cached.cachedAt < SCORE_CONTEXT_CACHE_MS) {
      setScoreContext(cached.data);
      setContextCode(code);
      setContextLoading(false);
      setContextError(null);
      return;
    }
    let cancelled = false;
    setContextLoading(true);
    setContextError(null);
    const priceQuery = quote?.price != null && quote.price > 0
      ? `?price=${encodeURIComponent(String(quote.price))}`
      : '';
    void apiFetch<SelectionScoreContext>(`/api/market-data/stocks/${code}/selection-score-context${priceQuery}`, {
      timeoutMs: 90000,
    }).then((next) => {
      if (cancelled) return;
      marketDataCache.scoreContexts[code] = { data: next, cachedAt: Date.now() };
      setScoreContext(next);
      setContextCode(code);
    }).catch((error) => {
      if (cancelled) return;
      setScoreContext({});
      setContextCode(code);
      setContextError(error instanceof Error ? error.message : '评分基础数据加载失败');
    }).finally(() => {
      if (!cancelled) setContextLoading(false);
    });
    return () => { cancelled = true; };
  }, [code, needsFundamentals, quote?.price]);

  const mergedScoreContext = useMemo<SelectionScoreContext>(() => ({
    ...scoreContext,
    peTtm: quote?.peTtm ?? scoreContext.peTtm,
    pb: quote?.pb ?? scoreContext.pb,
    marketCapYi: quote?.marketCapYi ?? scoreContext.marketCapYi,
    floatMarketCapYi: quote?.floatMarketCapYi ?? scoreContext.floatMarketCapYi,
    sources: [...new Set([...(scoreContext.sources ?? []), ...(quote?.source ?? [])])],
  }), [quote, scoreContext]);

  const result = useMemo(
    () => calculateSelectionScore(
      candles,
      benchmarkCandles,
      styleId,
      {
        ...(needsFundamentals && contextCode === code ? mergedScoreContext : {}),
        securityCode: code,
        securityName: quote?.name,
        listDate: quote?.listDate,
      },
    ),
    [benchmarkCandles, candles, code, contextCode, mergedScoreContext, needsFundamentals, styleId],
  );
  const [activeSections, setActiveSections] = useState<string[]>([]);
  const [activeDetails, setActiveDetails] = useState<string[]>([]);

  useEffect(() => {
    setActiveSections([]);
    setActiveDetails([]);
  }, [candles, styleId]);

  if ((loading && candles.length === 0) || (needsFundamentals && contextLoading && contextCode !== code)) {
    return (
      <section className={`stock-selection-score${compact ? ' stock-selection-score--compact' : ''}`} aria-label="选股评分">
        <Skeleton active paragraph={{ rows: 3 }} />
      </section>
    );
  }

  if (result.status === 'insufficient' || result.score == null || result.tier == null) {
    return (
      <section className={`stock-selection-score${compact ? ' stock-selection-score--compact' : ''}`} aria-label="选股评分">
        <Alert
          type="info"
          showIcon
          message={result.tierLabel === '新股预热' ? '新股评分预热中' : '选股评分暂不可用'}
          description={(
            <Space direction="vertical" size={4}>
              <span>{result.message}</span>
              {result.tradingDayNumber != null && (
                <Tag color="processing">
                  上市第 {result.tradingDayNumber} 个交易日
                  {result.lifecycle === 'early_listing' ? ' · 上市初期特殊交易阶段' : ''}
                </Tag>
              )}
            </Space>
          )}
        />
      </section>
    );
  }

  const tierColor = TIER_COLORS[result.tier];

  const scoreBreakdown = (
    <Collapse
      ghost
      className="stock-score-breakdown"
      activeKey={activeSections}
      onChange={(keys) => setActiveSections((Array.isArray(keys) ? keys : [keys]).map(String))}
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
                {!item.available
                  ? <InfoCircleOutlined aria-hidden />
                  : item.matched
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
  );

  if (compact) {
    return (
      <section className="stock-selection-score stock-selection-score--compact" aria-label="选股评分" aria-live="polite">
        <div className="stock-score-compact-summary">
          <div className="stock-score-compact-gauge">
            <Progress
              type="circle"
              percent={result.score}
              size={64}
              strokeWidth={8}
              strokeColor={COMPACT_SCORE_COLOR}
              railColor="var(--stock-score-compact-rail)"
              format={(value) => (
                <span className="stock-score-compact-number">
                  {value?.toFixed(1)}
                  <small>分</small>
                </span>
              )}
            />
          </div>
          <div className="stock-score-compact-copy">
            <div className="stock-score-compact-title-row">
              <Title level={5} style={{ margin: 0 }}>{result.styleLabel}评分</Title>
              <span className="stock-score-compact-tier">{result.tierLabel}</span>
              <span className="stock-score-compact-risk">{result.riskLabel}</span>
            </div>
            <Text className="stock-score-compact-description">{result.tierDescription}</Text>
            <div className="stock-score-compact-meta">
              <span>评分日期 {result.asOf ?? '—'}</span>
              <span>数据覆盖 {result.dataCoveragePct}%</span>
            </div>
          </div>
        </div>

        {contextError && (
          <Text type="warning" className="stock-score-compact-warning">
            <WarningOutlined /> 基础数据降级：{contextError}
          </Text>
        )}

        <Collapse
          className="stock-score-compact-settings"
          activeKey={activeDetails}
          onChange={(keys) => setActiveDetails((Array.isArray(keys) ? keys : [keys]).map(String))}
          items={[{
            key: 'settings',
            label: (
              <div className="stock-score-details-label">
                <span>评分设置与说明</span>
                <Tag>{result.sections.length} 类评分</Tag>
              </div>
            ),
            children: (
              <div className="stock-score-compact-settings-content">
                <div className="stock-score-compact-options">
                  <label htmlFor={`selection-score-style-${code}`}>评分风格</label>
                  <Select
                    id={`selection-score-style-${code}`}
                    size="small"
                    value={styleId}
                    aria-label="选择评分风格"
                    onChange={(value) => setStyleId(value)}
                    options={SELECTION_STYLE_OPTIONS.map((item) => ({
                      value: item.value,
                      label: `${item.label} · ${item.riskLabel}`,
                    }))}
                  />
                </div>
                <Space wrap size={[6, 6]} className="stock-score-compact-metadata">
                  <Tag color="cyan">本地数据优先</Tag>
                  {result.tradingDayNumber != null && (
                    <Tag color="processing">上市第 {result.tradingDayNumber} 个交易日</Tag>
                  )}
                  <Tag color="blue">{result.styleLabel}复合分 {result.rawPositiveScore}/100</Tag>
                  <Tag color={result.relativeStrength20d == null ? 'default' : result.relativeStrength20d >= 0 ? 'success' : 'error'}>
                    相对沪深300 {result.relativeStrength20d == null
                      ? '—'
                      : `${result.relativeStrength20d >= 0 ? '+' : ''}${(result.relativeStrength20d * 100).toFixed(2)}%`}
                  </Tag>
                  <Tag color={result.riskDeduction > 0 ? 'error' : 'success'}>
                    风控 -{result.riskDeduction}
                  </Tag>
                  {result.forcedCooling && <Tag color="error">流动性强制冷却</Tag>}
                  <Tag>
                    {result.asOf ?? '—'} · {result.sampleSize} 根有效日 K
                    {result.inputSampleSize !== result.sampleSize ? `（原始 ${result.inputSampleSize} 根）` : ''}
                  </Tag>
                </Space>
                {scoreBreakdown}
                <div className="stock-score-footnote">
                  <Tooltip title={result.assumptions.map((item) => <div key={item}>{item}</div>)}>
                    <Text type="secondary"><InfoCircleOutlined /> 评分口径与量化代理</Text>
                  </Tooltip>
                </div>
              </div>
            ),
          }]}
        />
      </section>
    );
  }

  return (
    <section className="stock-selection-score" aria-label="选股评分" aria-live="polite">
      <div className="stock-score-header">
        <div className="stock-score-gauge">
          <Progress
            type="circle"
            percent={result.score}
            size={104}
            strokeColor={tierColor}
            railColor="#e2e8f0"
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
            <Title level={4} style={{ margin: 0 }}>{result.styleLabel}评分</Title>
            <Tag color={tierColor}>{result.tierLabel}</Tag>
            <Tag>{result.riskLabel}</Tag>
          </Space>
          <Text>{result.tierDescription}</Text>
          <Space wrap size={[6, 6]} className="stock-score-meta">
            <Select
              size="small"
              value={styleId}
              aria-label="选择评分风格"
              onChange={(value) => setStyleId(value)}
              options={SELECTION_STYLE_OPTIONS.map((item) => ({
                value: item.value,
                label: `${item.label} · ${item.riskLabel}`,
              }))}
              style={{ minWidth: 190 }}
            />
            <Tag color="cyan">本地数据优先</Tag>
            {result.tradingDayNumber != null && (
              <Tag color="processing">上市第 {result.tradingDayNumber} 个交易日</Tag>
            )}
            <Tag color="blue">{result.styleLabel}复合分 {result.rawPositiveScore}/100</Tag>
            <Tag color={result.dataCoveragePct >= 80 ? 'success' : result.dataCoveragePct >= 60 ? 'warning' : 'error'}>
              数据覆盖 {result.dataCoveragePct}%
            </Tag>
            <Tag color={result.relativeStrength20d == null ? 'default' : result.relativeStrength20d >= 0 ? 'success' : 'error'}>
              相对沪深300 {result.relativeStrength20d == null
                ? '—'
                : `${result.relativeStrength20d >= 0 ? '+' : ''}${(result.relativeStrength20d * 100).toFixed(2)}%`}
            </Tag>
            <Tag color={result.riskDeduction > 0 ? 'error' : 'success'}>
              风控 -{result.riskDeduction}
            </Tag>
            {result.forcedCooling && <Tag color="error">流动性强制冷却</Tag>}
            <Tag>
              {result.asOf} · {result.sampleSize} 根有效日 K
              {result.inputSampleSize !== result.sampleSize ? `（原始 ${result.inputSampleSize} 根）` : ''}
            </Tag>
          </Space>
          {contextError && <Text type="warning">基础数据降级：{contextError}</Text>}
        </div>

        <div className="stock-score-scale" aria-label="评分档位">
          <span><b className="is-core">80–100</b> 核心优选</span>
          <span><b className="is-watch">60–79</b> 持有观察</span>
          <span><b className="is-weak">40–59</b> 中性观察</span>
          <span><b className="is-blocked">＜40</b> 回避冷却</span>
        </div>
      </div>

      <Collapse
        className="stock-score-details"
        activeKey={activeDetails}
        onChange={(keys) => setActiveDetails((Array.isArray(keys) ? keys : [keys]).map(String))}
        items={[{
          key: 'details',
          label: <div className="stock-score-details-label"><span>详细数据</span><Tag>{result.sections.length} 类评分</Tag></div>,
          children: <>
            {scoreBreakdown}
            <div className="stock-score-footnote">
              <Tooltip title={result.assumptions.map((item) => <div key={item}>{item}</div>)}>
                <Text type="secondary"><InfoCircleOutlined /> 评分口径与量化代理</Text>
              </Tooltip>
            </div>
          </>,
        }]}
      />
    </section>
  );
}
