import { Modal, Form, Input, Alert } from 'antd';
import { useCandleStore } from '@/stores/useCandleStore';
import { saveDataset, computeChecksum, findDuplicateByChecksum } from '@/db/marketDataRepository';
import type { MarketDataset } from '@/models';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SaveDatasetModal({ open, onClose }: Props) {
  const [form] = Form.useForm();
  const importResult = useCandleStore((s) => s.importResult);
  const candles = useCandleStore((s) => s.candles);

  const handleOk = async () => {
    const values = await form.validateFields();
    const cs = computeChecksum(candles);
    const existing = await findDuplicateByChecksum(cs);

    if (existing) {
      Modal.confirm({
        title: '数据集已存在',
        content: `检测到相同数据已保存为"${existing.name}"。是否覆盖？`,
        onOk: async () => {
          await saveDataset(
            {
              id: existing.id,
              name: values.name,
              symbol: importResult!.symbol,
              timeframe: '1d',
              startTime: importResult!.dateRange.from,
              endTime: importResult!.dateRange.to,
              count: importResult!.validRows,
              sourceFileName: importResult!.fileName,
              checksum: cs,
              createdAt: existing.createdAt,
              updatedAt: new Date().toISOString(),
            },
            candles,
          );
          onClose();
        },
      });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const dataset: MarketDataset = {
      id,
      name: values.name,
      symbol: importResult!.symbol,
      timeframe: '1d',
      startTime: importResult!.dateRange.from,
      endTime: importResult!.dateRange.to,
      count: importResult!.validRows,
      sourceFileName: importResult!.fileName,
      checksum: cs,
      createdAt: now,
      updatedAt: now,
    };

    await saveDataset(dataset, candles);
    onClose();
  };

  return (
    <Modal
      title="保存行情数据集"
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      destroyOnHidden
    >
      {!importResult || candles.length === 0 ? (
        <Alert type="warning" message="请先导入行情数据" showIcon />
      ) : (
        <>
          <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
            <Form.Item
              label="数据集名称"
              name="name"
              initialValue={importResult.symbol}
              rules={[{ required: true, message: '请输入数据集名称' }]}
            >
              <Input />
            </Form.Item>
          </Form>
          <Alert
            type="info"
            message={`将保存 ${importResult.validRows} 条 ${importResult.symbol} 行情（${importResult.dateRange.from} ~ ${importResult.dateRange.to}）`}
            showIcon
          />
        </>
      )}
    </Modal>
  );
}
