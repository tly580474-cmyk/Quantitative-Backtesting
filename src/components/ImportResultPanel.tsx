import { Alert, Table, Typography } from 'antd';
import type { ImportResult } from '@/models';

const { Text } = Typography;

interface ImportResultPanelProps {
  result: ImportResult;
}

export default function ImportResultPanel({ result }: ImportResultPanelProps) {
  if (result.errors.length === 0 && result.warnings.length === 0) return null;

  const warningData = result.warnings.map((w, i) => ({
    key: `w-${i}`,
    row: w.row,
    message: w.message,
    type: 'warning',
  }));

  const errorData = result.errors.map((e, i) => ({
    key: `e-${i}`,
    row: e.row,
    message: e.message,
    type: 'error',
  }));

  const dataSource = [...errorData, ...warningData];

  const columns = [
    { title: '行号', dataIndex: 'row', key: 'row', width: 80 },
    { title: '信息', dataIndex: 'message', key: 'message' },
  ];

  return (
    <div style={{ minHeight: '100%', padding: '8px 12px' }}>
      {result.errors.length > 0 && (
        <Alert
          type="error"
          title={`${result.errors.length} 个错误`}
          style={{ marginBottom: 8 }}
          showIcon
        />
      )}
      {result.warnings.length > 0 && (
        <Alert
          type="warning"
          title={`${result.warnings.length} 个警告`}
          style={{ marginBottom: 8 }}
          showIcon
        />
      )}
      <Table
        dataSource={dataSource}
        columns={columns}
        size="small"
        pagination={false}
      />
    </div>
  );
}
