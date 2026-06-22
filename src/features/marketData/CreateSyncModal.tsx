import { useState, useEffect } from 'react';
import { Modal, Form, Select, DatePicker, Input, App, Spin } from 'antd';
import { apiFetch } from '../../api/client';

const { TextArea } = Input;
const { RangePicker } = DatePicker;

interface Provider {
  id: string;
  name: string;
  type: string;
}

interface CreateSyncModalProps {
  open: boolean;
  jobType: 'instruments' | 'calendars' | 'history' | 'incremental';
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}

const MARKET_OPTIONS = [
  { label: '全部', value: '' },
  { label: '沪市 (SH)', value: 'SH' },
  { label: '深市 (SZ)', value: 'SZ' },
  { label: '京市 (BJ)', value: 'BJ' },
];

const LABEL_BY_TYPE: Record<string, string> = {
  instruments: '同步证券列表',
  calendars: '同步交易日历',
  history: '历史回补',
  incremental: '增量更新',
};

export default function CreateSyncModal({ open, jobType, onClose, onSubmit }: CreateSyncModalProps) {
  const [form] = Form.useForm();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const { message } = App.useApp();

  useEffect(() => {
    if (open) {
      form.resetFields();
      setProvidersLoading(true);
      apiFetch<Provider[]>('/api/market-data/providers')
        .then(setProviders)
        .catch(() => message.error('获取数据源列表失败'))
        .finally(() => setProvidersLoading(false));
    }
  }, [open, form, message]);

  const providerOptions = providers.map((p) => ({
    label: `${p.name} (${p.type})`,
    value: p.id,
  }));

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const payload: Record<string, unknown> = {
        providerId: values.providerId || undefined,
      };

      switch (jobType) {
        case 'instruments':
          if (values.market) payload.market = values.market;
          break;
        case 'calendars':
          payload.market = values.market;
          if (values.dateRange && values.dateRange.length === 2) {
            payload.startDate = values.dateRange[0].format('YYYY-MM-DD');
            payload.endDate = values.dateRange[1].format('YYYY-MM-DD');
          }
          break;
        case 'history':
          if (values.symbols) {
            payload.symbols = values.symbols
              .split(/[,\n\s]+/)
              .map((s: string) => s.trim())
              .filter(Boolean);
          }
          if (values.dateRange && values.dateRange.length === 2) {
            payload.startDate = values.dateRange[0].format('YYYY-MM-DD');
            payload.endDate = values.dateRange[1].format('YYYY-MM-DD');
          }
          break;
        case 'incremental':
          if (values.market) payload.market = values.market;
          break;
      }

      onSubmit(payload);
      onClose();
    } catch {
      // Validation failed, do nothing
    }
  };

  const renderFormFields = () => {
    return (
      <Spin spinning={providersLoading}>
        <Form form={form} layout="vertical">
          {(jobType === 'instruments' || jobType === 'calendars' || jobType === 'incremental') && (
            <Form.Item name="market" label="市场" initialValue="">
              <Select options={MARKET_OPTIONS} allowClear />
            </Form.Item>
          )}

          {(jobType === 'calendars' || jobType === 'history') && (
            <Form.Item
              name="dateRange"
              label="日期范围"
              rules={
                jobType === 'calendars'
                  ? [{ required: true, message: '请选择日期范围' }]
                  : jobType === 'history'
                    ? [{ required: true, message: '请选择日期范围' }]
                    : undefined
              }
            >
              <RangePicker style={{ width: '100%' }} />
            </Form.Item>
          )}

          {jobType === 'history' && (
            <Form.Item
              name="symbols"
              label="证券代码（多个用逗号、换行或空格分隔）"
              rules={[{ required: true, message: '请输入证券代码' }]}
            >
              <TextArea
                rows={4}
                placeholder="例如: 000001, 600519, 000300"
              />
            </Form.Item>
          )}

          <Form.Item name="providerId" label="数据源">
            <Select
              options={providerOptions}
              allowClear
              placeholder="默认数据源"
            />
          </Form.Item>
        </Form>
      </Spin>
    );
  };

  return (
    <Modal
      title={LABEL_BY_TYPE[jobType]}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="确认提交"
      cancelText="取消"
      destroyOnHidden
    >
      {renderFormFields()}
    </Modal>
  );
}
