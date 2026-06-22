import { useState } from 'react';
import { Modal, Form, Input, DatePicker, Checkbox } from 'antd';

const { RangePicker } = DatePicker;

interface DataQualityModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { instrumentId?: string; startDate?: string; endDate?: string }) => void;
}

export default function DataQualityModal({ open, onClose, onSubmit }: DataQualityModalProps) {
  const [form] = Form.useForm();
  const [recheckAll, setRecheckAll] = useState(false);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const payload: { instrumentId?: string; startDate?: string; endDate?: string } = {};

      if (recheckAll) {
        // Recheck all, no specific instrument or date range
      } else {
        if (values.instrumentId) payload.instrumentId = values.instrumentId.trim();
        if (values.dateRange && values.dateRange.length === 2) {
          payload.startDate = values.dateRange[0].format('YYYY-MM-DD');
          payload.endDate = values.dateRange[1].format('YYYY-MM-DD');
        }
      }

      onSubmit(payload);
      form.resetFields();
      setRecheckAll(false);
      onClose();
    } catch {
      // Validation failed
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setRecheckAll(false);
    onClose();
  };

  return (
    <Modal
      title="重新检查数据质量"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="开始检查"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={form} layout="vertical">
        <Form.Item>
          <Checkbox
            checked={recheckAll}
            onChange={(e) => setRecheckAll(e.target.checked)}
          >
            全量重检（检查所有证券的全部数据）
          </Checkbox>
        </Form.Item>

        <Form.Item
          name="instrumentId"
          label="证券ID"
          rules={recheckAll ? [] : [{ required: false }]}
        >
          <Input placeholder="留空表示检查所有证券" disabled={recheckAll} />
        </Form.Item>

        <Form.Item name="dateRange" label="日期范围">
          <RangePicker style={{ width: '100%' }} disabled={recheckAll} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
