import { TrophyOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import { WorkbenchPanel } from '@/components/WorkbenchPanel';
import StrategyIterationPanel from './StrategyIterationPanel';

const { Text, Title } = Typography;

export default function FactorStrategyPage() {
  return (
    <div className="factor-page factor-section-page">
      <header className="factor-page-head">
        <div>
          <Text type="secondary">策略治理 · 模拟盘观察</Text>
          <Title level={2}><TrophyOutlined /> 冠军 / 挑战者策略</Title>
        </div>
      </header>
      <section className="factor-panel factor-section-panel">
        <WorkbenchPanel
          title="冠军 / 挑战者策略"
          subtitle="版本化研究、双基准验收、模拟盘观察与人工晋级"
        >
          <StrategyIterationPanel />
        </WorkbenchPanel>
      </section>
    </div>
  );
}
