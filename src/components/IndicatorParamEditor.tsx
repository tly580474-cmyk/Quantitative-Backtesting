import { Modal, Slider, InputNumber, Space, Typography } from 'antd';
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
  const actives = useIndicatorStore((s) => s.actives);
  const updateParam = useIndicatorStore((s) => s.updateParam);

  const active = actives.find((a) => a.id === indicatorId);
  const def = getIndicatorById(indicatorId);

  if (!active || !def) {
    onClose();
    return null;
  }

  return (
    <Modal
      title={`${def.name} - 参数设置`}
      open
      onCancel={onClose}
      footer={null}
      width={400}
    >
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        {def.params.map((param) => {
          const currentValue = active.paramValues[param.name] ?? param.defaultValue;
          return (
            <div key={param.name}>
              <Text strong>{param.label}</Text>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginTop: 4,
                }}
              >
                <Slider
                  style={{ flex: 1 }}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={currentValue}
                  onChange={(val) =>
                    updateParam(indicatorId, param.name, val)
                  }
                />
                <InputNumber
                  style={{ width: 80 }}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={currentValue}
                  onChange={(val) => {
                    if (val != null) updateParam(indicatorId, param.name, val);
                  }}
                />
              </div>
            </div>
          );
        })}
        <div>
          <Text type="secondary" style={{ fontSize: 11, cursor: 'pointer' }}>
            拖动滑块或直接输入数值调整参数
          </Text>
        </div>
      </Space>
    </Modal>
  );
}
