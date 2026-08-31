import { ExperimentOutlined } from '@ant-design/icons';
import { Typography } from 'antd';
import { WorkbenchPanel } from '@/components/WorkbenchPanel';
import { useMobileLayout } from '@/components/mobile/useMobileLayout';
import AutomatedMiningPanel from './AutomatedMiningPanel';
import './mobile.css';

const { Text, Title } = Typography;

export default function AutomatedFactorMiningPage() {
  const isMobileLayout = useMobileLayout();

  if (isMobileLayout) {
    return (
      <div className="factor-mobile-page factor-mobile-mining-page">
        <header className="factor-mobile-header">
          <div>
            <Text type="secondary">因子智能 · 候选发现</Text>
            <Title level={2}><ExperimentOutlined /> 自动因子挖掘</Title>
          </div>
        </header>
        <AutomatedMiningPanel />
      </div>
    );
  }

  return (
    <div className="factor-page factor-section-page">
      <header className="factor-page-head">
        <div>
          <Text type="secondary">因子智能 · 候选发现</Text>
          <Title level={2}><ExperimentOutlined /> 自动因子挖掘</Title>
        </div>
      </header>
      <section className="factor-panel factor-section-panel">
        <WorkbenchPanel
          title="候选发现工作区"
          subtitle="训练验证、锁定测试、人工批准与显式发布"
        >
          <AutomatedMiningPanel />
        </WorkbenchPanel>
      </section>
    </div>
  );
}
