import { useState } from 'react';
import { Button, Card, Checkbox, Space, Typography, Empty, Select } from 'antd';
import { PlusOutlined, SettingOutlined, DeleteOutlined, UndoOutlined } from '@ant-design/icons';
import { useIndicatorStore } from '@/stores/useIndicatorStore';
import { INDICATOR_REGISTRY } from '@/features/indicators/registry';
import IndicatorParamEditor from './IndicatorParamEditor';

const { Text, Title } = Typography;

export default function IndicatorPanel() {
  const actives = useIndicatorStore((s) => s.actives);
  const usedIds = useIndicatorStore((s) => s.usedIds);
  const availableIds = useIndicatorStore((s) => s.availableIds);
  const add = useIndicatorStore((s) => s.add);
  const remove = useIndicatorStore((s) => s.remove);
  const toggle = useIndicatorStore((s) => s.toggle);
  const resetParams = useIndicatorStore((s) => s.resetParams);

  const [editingIndicator, setEditingIndicator] = useState<string | null>(null);

  const unusedIds = availableIds.filter((id) => !usedIds.includes(id));
  const unusedOptions = unusedIds.map((id) => {
    const def = INDICATOR_REGISTRY.find((d) => d.id === id);
    return { label: def?.name ?? id, value: id };
  });

  return (
    <div>
      <Title level={5} style={{ marginTop: 0 }}>
        技术指标
      </Title>

      {/* Add indicator */}
      {unusedOptions.length > 0 && (
        <Select
          style={{ width: '100%', marginBottom: 12 }}
          placeholder="添加指标..."
          value={null}
          onChange={(val) => val && add(val)}
          options={unusedOptions}
          showSearch
          filterOption={(input, option) =>
            (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
          }
        />
      )}

      {/* Active indicators */}
      {actives.length === 0 ? (
        <Empty description="暂无指标" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }}>
          {actives.map((active) => (
            <Card
              key={active.id}
              size="small"
              title={
                <Checkbox
                  checked={active.visible}
                  onChange={() => toggle(active.id)}
                >
                  <Text strong>{active.definition.name}</Text>
                </Checkbox>
              }
              extra={
                <Space size={4}>
                  {active.definition.params.length > 0 && (
                    <Button
                      type="text"
                      size="small"
                      icon={<SettingOutlined />}
                      onClick={() => setEditingIndicator(active.id)}
                    />
                  )}
                  <Button
                    type="text"
                    size="small"
                    icon={<UndoOutlined />}
                    onClick={() => resetParams(active.id)}
                  />
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => remove(active.id)}
                  />
                </Space>
              }
              styles={{ body: { padding: '4px 12px' } }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
                {Object.entries(active.paramValues)
                  .filter(([name, value]) =>
                    !((active.id === 'sma' || active.id === 'ema')
                      && name.startsWith('period')
                      && value < 2),
                  )
                  .map(([name, value]) => {
                  const paramDef = active.definition.params.find(
                    (p) => p.name === name,
                  );
                  return (
                    <Text key={name} type="secondary" style={{ fontSize: 11 }}>
                      {paramDef?.label ?? name}: {value}
                    </Text>
                  );
                  })}
              </div>
            </Card>
          ))}
        </Space>
      )}

      {/* Parameter editor modal */}
      {editingIndicator && (
        <IndicatorParamEditor
          indicatorId={editingIndicator}
          onClose={() => setEditingIndicator(null)}
        />
      )}
    </div>
  );
}
