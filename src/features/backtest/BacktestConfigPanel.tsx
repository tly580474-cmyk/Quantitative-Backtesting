import { Card, Form, InputNumber, Switch, Segmented, Select, Slider, Typography } from 'antd';
import { useBacktestStore, DEFAULT_BACKTEST_CONFIG } from '@/stores/useBacktestStore';

interface Props {
  maximumTradingDays?: number;
}

export default function BacktestConfigPanel({ maximumTradingDays = 0 }: Props) {
  const config = useBacktestStore((s) => s.config);
  const setConfig = useBacktestStore((s) => s.setConfig);
  const tradingDays = config.tradingDays === 0 ? maximumTradingDays : Math.min(config.tradingDays, maximumTradingDays);

  return (
    <Card size="small" title="回测参数">
      <Form layout="vertical" size="small">
        <Form.Item label="回测模式">
          <Segmented
            block
            value={config.backtestMode}
            options={[{ label: '策略回测', value: 'strategy' }, { label: '定投回测', value: 'dca' }]}
            onChange={(value) => setConfig({ backtestMode: value as 'strategy' | 'dca' })}
          />
        </Form.Item>

        {config.backtestMode === 'dca' && (
          <>
            <Form.Item label="每期定投金额">
              <InputNumber
                value={config.dca.amount}
                min={1}
                step={100}
                prefix="¥"
                style={{ width: '100%' }}
                onChange={(value) => value != null && setConfig({ dca: { ...config.dca, amount: value } })}
              />
            </Form.Item>
            <Form.Item label="定投频率">
              <Select
                value={config.dca.frequency}
                options={[{ label: '每个交易日', value: 'daily' }, { label: '每周首个交易日', value: 'weekly' }, { label: '每月首个交易日', value: 'monthly' }]}
                onChange={(frequency) => setConfig({ dca: { ...config.dca, frequency } })}
              />
            </Form.Item>
          </>
        )}

        <Form.Item label="交易天数" extra={maximumTradingDays > 0 ? `使用最近 ${tradingDays} 个交易日` : '选择数据集后可调整'}>
          <Slider
            min={Math.min(2, maximumTradingDays)}
            max={Math.max(2, maximumTradingDays)}
            value={Math.max(2, tradingDays || 2)}
            disabled={maximumTradingDays < 2}
            onChange={(value) => setConfig({ tradingDays: value === maximumTradingDays ? 0 : value })}
            tooltip={{ formatter: (value) => `${value} 天` }}
          />
        </Form.Item>
        <Form.Item
          label={config.backtestMode === 'dca' ? '首日买入金额' : '初始资金'}
          extra={config.backtestMode === 'dca' ? '首个定投日投入；后续定投自动模拟外部入金，不受账户余额限制' : undefined}
        >
          <InputNumber
            value={config.initialCapital}
            onChange={(v) => v != null && setConfig({ initialCapital: v })}
            min={1}
            step={config.backtestMode === 'dca' ? 100 : 10000}
            style={{ width: '100%' }}
            formatter={(v) => `¥ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            parser={(v) => v?.replace(/[^\d.]/g, '') as unknown as number}
          />
        </Form.Item>

        {config.backtestMode === 'strategy' && (
          <>
            <Form.Item label="买卖方式">
              <Segmented
                block
                value={config.positionSizing.value < 1 ? 'gradual' : 'all'}
                options={[
                  { label: '全仓买卖', value: 'all' },
                  { label: '按资金比例逐步加减仓', value: 'gradual' },
                ]}
                onChange={(value) => setConfig({
                  positionSizing: {
                    type: 'percent',
                    value: value === 'all'
                      ? 1
                      : config.positionSizing.value < 1 ? config.positionSizing.value : 0.25,
                  },
                })}
              />
            </Form.Item>
            {config.positionSizing.value < 1 && (
              <Form.Item
                label="单次调仓比例"
                extra="买入按剩余可用资金、卖出按当前持仓计算；尾仓不足最小交易单位时自动清仓"
              >
                <InputNumber
                  value={config.positionSizing.value}
                  onChange={(v) =>
                    v != null && setConfig({ positionSizing: { type: 'percent', value: v } })
                  }
                  min={0.01}
                  max={0.99}
                  step={0.05}
                  style={{ width: '100%' }}
                  formatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
                  parser={(v) => Number(v?.replace('%', '')) / 100}
                />
              </Form.Item>
            )}
          </>
        )}

        <Form.Item label="手续费率">
          <InputNumber
            value={config.commissionRate}
            onChange={(v) => v != null && setConfig({ commissionRate: v })}
            min={0}
            max={0.1}
            step={0.0001}
            style={{ width: '100%' }}
            formatter={(v) => `${(Number(v) * 100).toFixed(2)}%`}
            parser={(v) => Number(v?.replace('%', '')) / 100}
          />
        </Form.Item>

        <Form.Item label="最低手续费">
          <InputNumber
            value={config.minimumCommission}
            onChange={(v) => v != null && setConfig({ minimumCommission: v })}
            min={0}
            step={1}
            style={{ width: '100%' }}
            prefix="¥"
          />
        </Form.Item>

        {config.backtestMode === 'strategy' && (
          <>
            <Form.Item label="卖出印花税率">
              <InputNumber
                value={config.sellTaxRate}
                onChange={(v) => v != null && setConfig({ sellTaxRate: v })}
                min={0}
                max={0.1}
                step={0.001}
                style={{ width: '100%' }}
                formatter={(v) => `${(Number(v) * 100).toFixed(1)}%`}
                parser={(v) => Number(v?.replace('%', '')) / 100}
              />
            </Form.Item>

            <Form.Item label="滑点 (BPS)">
              <InputNumber
                value={config.slippageBps}
                onChange={(v) => v != null && setConfig({ slippageBps: v })}
                min={0}
                max={100}
                step={1}
                style={{ width: '100%' }}
              />
            </Form.Item>
          </>
        )}

        <Form.Item label="最小交易单位">
          <Segmented
            block
            value={config.tradingUnitMode}
            options={[{ label: '个股模式', value: 'stock' }, { label: '指数模式', value: 'index' }]}
            onChange={(value) => setConfig({
              tradingUnitMode: value as 'stock' | 'index',
              minimumTradeAmount: value === 'index' ? 1 : DEFAULT_BACKTEST_CONFIG.minimumTradeAmount,
            })}
          />
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6, fontSize: 12 }}>
            {config.tradingUnitMode === 'stock' ? '按一手 100 股取整成交' : '按 1 元金额步长成交，可持有小数份额'}
          </Typography.Text>
        </Form.Item>

        {config.backtestMode === 'strategy' && (
          <Form.Item label="期末强制平仓">
            <Switch
              checked={config.forceCloseAtEnd}
              onChange={(v) => setConfig({ forceCloseAtEnd: v })}
            />
          </Form.Item>
        )}
      </Form>
    </Card>
  );
}
