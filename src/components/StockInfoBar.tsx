import { useState } from 'react';
import {
  App,
  Button,
  Segmented,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { SaveOutlined, WarningOutlined } from '@ant-design/icons';
import type { ImportResult } from '@/models';
import {
  fetchHistoryCandles,
  type AdjustmentMode,
} from '@/features/dataLibrary/historyBar';
import { useCandleStore } from '@/stores/useCandleStore';

const { Text } = Typography;

interface StockInfoBarProps {
  result: ImportResult;
  onSaveToDb?: () => void;
  showAdjustmentControl?: boolean;
}

const MODE_LABELS: Record<AdjustmentMode, string> = {
  none: '不复权',
  qfq: '前复权',
  hfq: '后复权',
};

export default function StockInfoBar({
  result,
  onSaveToDb,
  showAdjustmentControl = false,
}: StockInfoBarProps) {
  const { message } = App.useApp();
  const [switchingMode, setSwitchingMode] = useState(false);
  const setCandles = useCandleStore((state) => state.setCandles);
  const setImportResult = useCandleStore((state) => state.setImportResult);
  const mode = result.adjustmentMode ?? 'none';

  const handleAdjustmentChange = async (value: string | number) => {
    const nextMode = value as AdjustmentMode;
    if (!result.instrumentId || nextMode === mode) return;
    setSwitchingMode(true);
    try {
      const { response, candles } = await fetchHistoryCandles(
        result.instrumentId,
        result.symbol,
        nextMode,
      );
      setCandles(candles);
      setImportResult({
        ...result,
        dateRange: {
          from: candles[0]?.time ?? result.dateRange.from,
          to: candles[candles.length - 1]?.time ?? result.dateRange.to,
        },
        totalRows: response.total,
        validRows: candles.length,
        candles,
        adjustmentMode: response.adjustmentMode,
        factorVersion: response.factorVersion,
        adjustmentQualityStatus: response.adjustmentQualityStatus,
        adjustmentWarnings: response.adjustmentWarnings,
      });
      if (response.adjustmentQualityStatus === 'warning') {
        message.warning(`${MODE_LABELS[nextMode]}已加载，但源数据交叉校验存在警告`);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '复权行情加载失败');
    } finally {
      setSwitchingMode(false);
    }
  };

  const adjustmentWarning = result.adjustmentQualityStatus === 'warning'
    && mode !== 'none';

  return (
    <Space className="stock-info-bar" size="middle" wrap>
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
      {showAdjustmentControl && result.instrumentId && (
        <div
          className="stock-adjustment-control"
          title={mode !== 'none' && result.factorVersion
            ? `因子版本：${result.factorVersion}`
            : undefined}
        >
          <Text type="secondary">价格口径</Text>
          <Segmented
            aria-label="价格复权方式"
            size="small"
            value={mode}
            disabled={switchingMode}
            options={[
              { label: '不复权', value: 'none' },
              { label: '前复权', value: 'qfq' },
              { label: '后复权', value: 'hfq' },
            ]}
            onChange={handleAdjustmentChange}
          />
          {switchingMode && <Spin size="small" aria-label="正在切换复权方式" />}
          {adjustmentWarning && (
            <Tooltip title={adjustmentWarningText(result)}>
              <Tag color="gold" icon={<WarningOutlined />}>
                复权校验警告
              </Tag>
            </Tooltip>
          )}
        </div>
      )}
      {onSaveToDb && (
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          onClick={onSaveToDb}
        >
          保存到数据库
        </Button>
      )}
    </Space>
  );
}

function adjustmentWarningText(result: ImportResult): string {
  const warnings = result.adjustmentWarnings ?? [];
  const labels = warnings.map((warning) => {
    if (warning.ruleCode === 'ADJUSTMENT_QFQ_RECONSTRUCTION') {
      return '前复权参数与源文件存在超出最小价位的偏差';
    }
    if (warning.ruleCode === 'ADJUSTMENT_HFQ_CROSSCHECK') {
      return '后复权源文件与推导结果不一致';
    }
    return warning.ruleCode;
  });
  return labels.length > 0
    ? labels.join('；')
    : '该复权口径存在源数据校验警告，请谨慎用于回测';
}
