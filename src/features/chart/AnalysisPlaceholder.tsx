import { Button, Skeleton, Space } from 'antd';
import { DatabaseOutlined, LineChartOutlined } from '@ant-design/icons';
import { WorkbenchEmpty } from '@/components/WorkspacePrimitives';

interface Props {
  loading: boolean;
  minuteMode: boolean;
  hasSource: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenData: () => void;
  onOpenMarket: () => void;
}

export default function AnalysisPlaceholder({ loading, minuteMode, hasSource, error, onRetry, onOpenData, onOpenMarket }: Props) {
  if (loading) return <div className="analysis-placeholder" role="status" aria-busy="true" aria-label="正在加载分钟行情">
    <div className="analysis-loading-content"><p>正在读取分钟行情…</p><Skeleton active paragraph={{ rows: 4 }} /></div>
  </div>;

  if (error) return <div className="analysis-placeholder" role="alert">
    <WorkbenchEmpty title="分钟行情加载失败" description={error}
      action={onRetry && <Button onClick={onRetry}>重新加载分钟行情</Button>} />
  </div>;

  const needsMinuteData = minuteMode && hasSource;
  return <div className="analysis-placeholder">
    <WorkbenchEmpty title={needsMinuteData ? '当前范围暂无分钟行情' : '从一份行情数据开始'}
      description={needsMinuteData
        ? '可调整上方日期后重新加载，或切回日 K 查看已打开的行情。'
        : '从数据管理打开已有数据集，或到市场数据选择证券，即可查看 K 线和分析图层。'}
      action={!needsMinuteData && <Space wrap>
        <Button type="primary" icon={<DatabaseOutlined />} onClick={onOpenData}>打开数据管理</Button>
        <Button icon={<LineChartOutlined />} onClick={onOpenMarket}>浏览市场行情</Button>
      </Space>} />
  </div>;
}
