import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Drawer, Input, Select } from 'antd';
import { RightOutlined, SettingOutlined } from '@ant-design/icons';

export default function MobileAnalysisSetup({ styles, selectedStyles, question, onQuestionChange,
  model, models, onModelChange, configured, children }: {
  styles: ReactNode; selectedStyles: string[]; question: string; onQuestionChange: (value: string) => void;
  model?: string; models: string[]; onModelChange: (value: string) => void; configured: boolean;
  children: ReactNode;
}) {
  const [sheet, setSheet] = useState<'styles' | 'settings' | null>(null);
  return <div className="mobile-analysis-setup">
    <p>选择分析风格，结合行情、消息与个股数据生成研究报告。</p>
    <Button className="mobile-analysis-style-trigger" onClick={() => setSheet('styles')}>
      <span><small>分析风格 · {selectedStyles.length}/3</small><strong>{selectedStyles.join('、') || '请选择分析风格'}</strong></span>
      <RightOutlined />
    </Button>
    <div className="mobile-analysis-model-line">
      <span>{configured ? model || '使用默认模型' : '模型尚未配置'}</span>
      <Button type="text" icon={<SettingOutlined />} onClick={() => setSheet('settings')}>分析设置</Button>
    </div>
    {children}
    <Drawer title="选择分析风格" placement="bottom" size="75dvh" open={sheet === 'styles'}
      onClose={() => setSheet(null)} rootClassName="mobile-detail-sheet"
      footer={<Button block type="primary" disabled={selectedStyles.length === 0} onClick={() => setSheet(null)}>完成选择</Button>}>
      {styles}
    </Drawer>
    <Drawer title="分析设置" placement="bottom" size="auto" open={sheet === 'settings'}
      onClose={() => setSheet(null)} rootClassName="mobile-detail-sheet"
      footer={<Button block type="primary" onClick={() => setSheet(null)}>完成</Button>}>
      <div className="mobile-analysis-settings">
        <label htmlFor="mobile-agent-question">重点关注的问题</label>
        <Input.TextArea id="mobile-agent-question" rows={4} value={question} maxLength={1000}
          onChange={event => onQuestionChange(event.target.value)} placeholder="例如：重点分析估值和近期风险" />
        <label htmlFor="mobile-agent-model">分析模型</label>
        <Select id="mobile-agent-model" aria-label="分析模型" value={model} onChange={onModelChange}
          options={models.map(value => ({ value, label: value }))} />
      </div>
    </Drawer>
  </div>;
}
