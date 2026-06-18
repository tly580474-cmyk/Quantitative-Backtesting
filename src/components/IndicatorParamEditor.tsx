import { useState } from 'react';
import { Button, Modal, Slider, InputNumber, Space, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useIndicatorStore } from '@/stores/useIndicatorStore';
import { getIndicatorById } from '@/features/indicators/registry';

const { Text } = Typography;

interface IndicatorParamEditorProps {
  indicatorId: string;
  onClose: () => void;
}

export default function IndicatorParamEditor({
  indicatorId,
  onClose,
}: IndicatorParamEditorProps) {
  const [newPeriod, setNewPeriod] = useState(120);
  const actives = useIndicatorStore((s) => s.actives);
  const updateParam = useIndicatorStore((s) => s.updateParam);

  const active = actives.find((item) => item.id === indicatorId);
  const definition = getIndicatorById(indicatorId);

  if (!active || !definition) return null;

  const isMovingAverage = indicatorId === 'sma' || indicatorId === 'ema';
  const periodParams = isMovingAverage
    ? definition.params.filter((param) => param.name.startsWith('period'))
    : [];
  const activePeriodParams = periodParams.filter(
    (param) => (active.paramValues[param.name] ?? param.defaultValue) >= 2,
  );
  const emptyPeriodParam = periodParams.find(
    (param) => (active.paramValues[param.name] ?? param.defaultValue) < 2,
  );
  const usedPeriods = activePeriodParams.map(
    (param) => active.paramValues[param.name] ?? param.defaultValue,
  );
  const canAddPeriod = emptyPeriodParam != null
    && newPeriod >= 2
    && newPeriod <= 500
    && !usedPeriods.includes(newPeriod);

  return (
    <Modal
      title={`${definition.name} - 参数设置`}
      open
      onCancel={onClose}
      footer={null}
      width={420}
    >
      <Space orientation="vertical" style={{ width: '100%' }} size="middle">
        {isMovingAverage ? (
          <>
            {activePeriodParams.map((param) => {
              const slotIndex = Number(param.name.replace('period', '')) - 1;
              const color = definition.display.series[slotIndex]?.color ?? '#1677FF';
              const currentValue = active.paramValues[param.name] ?? param.defaultValue;
              return (
                <div
                  key={param.name}
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <span
                    aria-hidden
                    style={{ width: 10, height: 10, borderRadius: '50%', background: color }}
                  />
                  <Text style={{ width: 42 }}>{indicatorId.toUpperCase()}</Text>
                  <InputNumber
                    aria-label={`${indicatorId.toUpperCase()} 周期`}
                    style={{ flex: 1 }}
                    min={2}
                    max={500}
                    step={1}
                    value={currentValue}
                    onChange={(value) => {
                      if (value != null) updateParam(indicatorId, param.name, value);
                    }}
                  />
                  <Button
                    aria-label={`删除 ${indicatorId.toUpperCase()}${currentValue}`}
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => updateParam(indicatorId, param.name, 0)}
                  />
                </div>
              );
            })}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <InputNumber
                aria-label={`新增 ${indicatorId.toUpperCase()} 周期`}
                style={{ flex: 1 }}
                min={2}
                max={500}
                step={1}
                value={newPeriod}
                onChange={(value) => value != null && setNewPeriod(value)}
              />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={!canAddPeriod}
                onClick={() => {
                  if (emptyPeriodParam && canAddPeriod) {
                    updateParam(indicatorId, emptyPeriodParam.name, newPeriod);
                  }
                }}
              >
                添加均线
              </Button>
            </div>
            {!emptyPeriodParam && <Text type="secondary">最多可添加 8 条均线</Text>}
            {usedPeriods.includes(newPeriod) && <Text type="warning">该周期已存在</Text>}
          </>
        ) : (
          definition.params.map((param) => {
            const currentValue = active.paramValues[param.name] ?? param.defaultValue;
            return (
              <div key={param.name}>
                <Text strong>{param.label}</Text>
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 4 }}
                >
                  <Slider
                    style={{ flex: 1 }}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={currentValue}
                    onChange={(value) => updateParam(indicatorId, param.name, value)}
                  />
                  <InputNumber
                    style={{ width: 80 }}
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={currentValue}
                    onChange={(value) => {
                      if (value != null) updateParam(indicatorId, param.name, value);
                    }}
                  />
                </div>
              </div>
            );
          })
        )}

        <Text type="secondary" style={{ fontSize: 11 }}>
          {isMovingAverage
            ? '周期范围为 2–500；删除后可继续添加新的均线周期'
            : '拖动滑块或直接输入数值调整参数'}
        </Text>
      </Space>
    </Modal>
  );
}
