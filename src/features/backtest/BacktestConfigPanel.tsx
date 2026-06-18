import { Card, Form, InputNumber, Switch } from 'antd';
import { useBacktestStore, DEFAULT_BACKTEST_CONFIG } from '@/stores/useBacktestStore';

export default function BacktestConfigPanel() {
  const config = useBacktestStore((s) => s.config);
  const setConfig = useBacktestStore((s) => s.setConfig);

  return (
    <Card size="small" title="回测参数">
      <Form layout="vertical" size="small">
        <Form.Item label="初始资金">
          <InputNumber
            value={config.initialCapital}
            onChange={(v) => v != null && setConfig({ initialCapital: v })}
            min={1000}
            step={10000}
            style={{ width: '100%' }}
            formatter={(v) => `¥ ${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
            parser={(v) => v?.replace(/[^\d.]/g, '') as unknown as number}
          />
        </Form.Item>

        <Form.Item label="仓位比例">
          <InputNumber
            value={config.positionSizing.value}
            onChange={(v) =>
              v != null && setConfig({ positionSizing: { type: 'percent', value: v } })
            }
            min={0.01}
            max={1}
            step={0.1}
            style={{ width: '100%' }}
            formatter={(v) => `${(Number(v) * 100).toFixed(0)}%`}
            parser={(v) => Number(v?.replace('%', '')) / 100}
          />
        </Form.Item>

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

        <Form.Item label="每手股数">
          <InputNumber
            value={config.lotSize}
            onChange={(v) => v != null && setConfig({ lotSize: v })}
            min={1}
            max={10000}
            step={100}
            style={{ width: '100%' }}
          />
        </Form.Item>

        <Form.Item label="期末强制平仓">
          <Switch
            checked={config.forceCloseAtEnd}
            onChange={(v) => setConfig({ forceCloseAtEnd: v })}
          />
        </Form.Item>
      </Form>
    </Card>
  );
}
