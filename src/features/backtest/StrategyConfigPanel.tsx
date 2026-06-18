import { useEffect } from 'react';
import { Card, Select, Form, InputNumber, Button, Space, Typography, Divider } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import { useStrategyStore } from '@/stores/useStrategyStore';
import { getAllStrategies } from '@/features/strategies/registry';
import type { StrategyParamDef } from '@/models';

const { Text, Paragraph } = Typography;

export default function StrategyConfigPanel() {
  const activeId = useStrategyStore((s) => s.activeStrategyId);
  const activeParams = useStrategyStore((s) => s.activeParams);
  const selectStrategy = useStrategyStore((s) => s.selectStrategy);
  const setParam = useStrategyStore((s) => s.setParam);
  const resetParams = useStrategyStore((s) => s.resetParams);

  const strategies = getAllStrategies();
  const strategy = strategies.find((s) => s.id === activeId);

  // Initialize on first render
  useEffect(() => {
    if (strategy && Object.keys(activeParams).length === 0) {
      resetParams();
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const renderParamInput = (def: StrategyParamDef) => {
    const value = activeParams[def.name] ?? def.defaultValue;

    if (def.type === 'select' && def.options) {
      return (
        <Form.Item key={def.name} label={def.label} help={def.description}>
          <Select
            value={value}
            onChange={(v) => setParam(def.name, v)}
            options={def.options.map((o) => ({ label: o.label, value: o.value }))}
          />
        </Form.Item>
      );
    }

    return (
      <Form.Item key={def.name} label={def.label} help={def.description}>
        <InputNumber
          value={value as number}
          onChange={(v) => v != null && setParam(def.name, v)}
          min={def.min}
          max={def.max}
          step={def.step ?? 1}
          style={{ width: '100%' }}
        />
      </Form.Item>
    );
  };

  return (
    <Card size="small" title="策略配置">
      <Form layout="vertical" size="small">
        <Form.Item label="选择策略">
          <Select
            value={activeId}
            onChange={selectStrategy}
            options={strategies.map((s) => ({
              label: s.name,
              value: s.id,
            }))}
          />
        </Form.Item>
      </Form>

      {strategy && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {strategy.description}
          </Paragraph>
          <Text type="secondary" style={{ fontSize: 11 }}>
            预热期: {strategy.warmupBars(activeParams)} 根 K 线
          </Text>

          <Form layout="vertical" size="small" style={{ marginTop: 12 }}>
            {strategy.paramsSchema.map(renderParamInput)}
          </Form>

          <Space style={{ marginTop: 8 }}>
            <Button size="small" icon={<UndoOutlined />} onClick={resetParams}>
              恢复默认
            </Button>
          </Space>
        </>
      )}
    </Card>
  );
}
