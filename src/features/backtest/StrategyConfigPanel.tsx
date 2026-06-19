import { useEffect, useState } from 'react';
import { Card, Select, Form, InputNumber, Button, Space, Switch, Typography, Divider } from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import { useStrategyStore } from '@/stores/useStrategyStore';
import { useBacktestStore } from '@/stores/useBacktestStore';
import { getAllStrategies } from '@/features/strategies/registry';
import { getAllVisualStrategies } from '@/db/visualStrategyRepository';
import { validateDocument } from '@/features/visualStrategies/validator';
import type { StrategyParamDef } from '@/models';
import type { StoredVisualStrategy, VisualStrategyDocument } from '@/features/visualStrategies/types';

const { Text, Paragraph } = Typography;

export default function StrategyConfigPanel() {
  const activeId = useStrategyStore((s) => s.activeStrategyId);
  const activeParams = useStrategyStore((s) => s.activeParams);
  const selectStrategy = useStrategyStore((s) => s.selectStrategy);
  const setParam = useStrategyStore((s) => s.setParam);
  const resetParams = useStrategyStore((s) => s.resetParams);
  // Track visual strategy document for backtest
  const setStrategySource = useBacktestStore((s) => s.setStrategySource);
  const setVisualStrategyDocument = useBacktestStore((s) => s.setVisualStrategyDocument);

  const [visualStrategies, setVisualStrategies] = useState<StoredVisualStrategy[]>([]);

  useEffect(() => {
    getAllVisualStrategies().then((list) => {
      setVisualStrategies(list.filter((strategy) => validateDocument(strategy.document).valid));
    });
  }, []);

  const strategies = getAllStrategies();
  const builtinStrategy = strategies.find((s) => s.id === activeId);
  const visualStrategy = visualStrategies.find((s) => s.id === activeId);

  // Initialize on first render
  useEffect(() => {
    if (builtinStrategy && Object.keys(activeParams).length === 0) {
      resetParams();
    }
  }, [activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectStrategy = (id: string) => {
    // Check if it's a visual strategy
    const visual = visualStrategies.find((s) => s.id === id);
    if (visual) {
      const defaultParams = Object.fromEntries(
        visual.document.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
      );
      setStrategySource('visual');
      setVisualStrategyDocument(visual.document);
      selectStrategy(id, defaultParams);
    } else {
      setStrategySource('builtin');
      setVisualStrategyDocument(null);
      selectStrategy(id);
    }
  };

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

    if (def.type === 'boolean') {
      return (
        <Form.Item key={def.name} label={def.label} help={def.description}>
          <Switch
            checked={Boolean(value)}
            onChange={(checked) => setParam(def.name, checked)}
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
            onChange={handleSelectStrategy}
            options={[
              {
                label: '内置策略',
                options: strategies.map((s) => ({
                  label: s.name,
                  value: s.id,
                })),
              },
              ...(visualStrategies.length > 0
                ? [{
                    label: '自定义策略（可视化）',
                    options: visualStrategies.map((s) => ({
                      label: `${s.name}（${s.status === 'published' ? '已发布' : '草稿'}）`,
                      value: s.id,
                    })),
                  }]
                : []),
            ]}
          />
        </Form.Item>
      </Form>

      {builtinStrategy && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {builtinStrategy.description}
          </Paragraph>
          <Text type="secondary" style={{ fontSize: 11 }}>
            预热期: {builtinStrategy.warmupBars(activeParams)} 根 K 线
          </Text>

          <Form layout="vertical" size="small" style={{ marginTop: 12 }}>
            {builtinStrategy.paramsSchema.map(renderParamInput)}
          </Form>

          <Space style={{ marginTop: 8 }}>
            <Button size="small" icon={<UndoOutlined />} onClick={resetParams}>
              恢复默认
            </Button>
          </Space>
        </>
      )}

      {visualStrategy && !builtinStrategy && (
        <>
          <Divider style={{ margin: '8px 0' }} />
          <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
            {visualStrategy.document.description || '可视化自定义策略'}
          </Paragraph>
          <Text type="secondary" style={{ fontSize: 11 }}>
            版本: {visualStrategy.document.strategyVersion} · {visualStrategy.status === 'published' ? '已发布' : '草稿'}
          </Text>
          {visualStrategy.document.parameters.length > 0 && (
            <Form layout="vertical" size="small" style={{ marginTop: 12 }}>
              {visualStrategy.document.parameters.map(renderParamInput)}
            </Form>
          )}
          <Space style={{ marginTop: 8 }}>
            <Button
              size="small"
              icon={<UndoOutlined />}
              onClick={() => selectStrategy(
                visualStrategy.id,
                Object.fromEntries(
                  visualStrategy.document.parameters.map((parameter) => [parameter.name, parameter.defaultValue]),
                ),
              )}
            >
              恢复默认
            </Button>
          </Space>
        </>
      )}
    </Card>
  );
}
