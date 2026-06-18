import { Tag, Space, Typography } from 'antd';
import type { ImportResult } from '@/models';

const { Text } = Typography;

interface StockInfoBarProps {
  result: ImportResult;
}

export default function StockInfoBar({ result }: StockInfoBarProps) {
  return (
    <Space size="middle" wrap>
      <Text code>{result.fileName}</Text>
      <Tag color="blue">{result.symbol}</Tag>
      <Text type="secondary">
        {result.dateRange.from} ~ {result.dateRange.to}
      </Text>
      <Tag>{result.validRows} 条</Tag>
      {result.warnings.length > 0 && (
        <Tag color="orange">{result.warnings.length} 个警告</Tag>
      )}
      {result.errors.length > 0 && (
        <Tag color="red">{result.errors.length} 个错误</Tag>
      )}
    </Space>
  );
}
