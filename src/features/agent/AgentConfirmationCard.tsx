import { useMemo, useState } from 'react';
import { CheckCircleOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import { Button, Input, Radio } from 'antd';
import { useAgentTheme } from '@/theme';

interface ConfirmationOption { label: string; value: string; description?: string; }
interface ConfirmationQuestion {
  id: string; question: string; options: ConfirmationOption[]; allowCustom: boolean;
}
interface ConfirmationRequest { questions: ConfirmationQuestion[]; }

export function parseConfirmationRequest(content: string): ConfirmationRequest | null {
  try {
    const parsed = JSON.parse(content) as ConfirmationRequest;
    if (!Array.isArray(parsed.questions) || !parsed.questions.length) return null;
    return parsed;
  } catch { return null; }
}

export function AgentConfirmationCard({ content, onSubmit, disabled = false, answered = false }: {
  content: string; onSubmit?: (response: string) => void; disabled?: boolean; answered?: boolean;
}) {
  const theme = useAgentTheme();
  const request = useMemo(() => parseConfirmationRequest(content), [content]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  if (!request) return null;

  const answers = request.questions.map(question => {
    const selected = selections[question.id];
    return selected === '__custom__' ? custom[question.id]?.trim() : selected;
  });
  const complete = answers.every(Boolean);
  const submit = () => {
    if (!complete || disabled || answered) return;
    const response = ['以下是我的确认结果：', ...request.questions.flatMap((question, index) => [
      `${index + 1}. ${question.question}`,
      `答复：${answers[index]}`,
    ])].join('\n');
    onSubmit?.(response);
  };

  return <section aria-label="等待用户确认" style={{ marginTop: 16, padding: '18px 20px', borderRadius: 13,
    border: `1px solid ${theme.border}`, background: theme.bgCard }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14, color: theme.text, fontWeight: 600 }}>
      {answered ? <CheckCircleOutlined style={{ color: '#10b981' }} /> : <QuestionCircleOutlined style={{ color: '#1a73e8' }} />}
      <span>{answered ? '确认结果已提交' : '需要你的确认'}</span>
    </div>
    {request.questions.map((question, index) => <fieldset key={question.id} disabled={disabled || answered}
      style={{ margin: index ? '18px 0 0' : 0, padding: 0, border: 0 }}>
      <legend style={{ marginBottom: 9, color: theme.text, fontSize: 14, fontWeight: 500 }}>
        {index + 1}. {question.question}
      </legend>
      <Radio.Group value={selections[question.id]} onChange={event =>
        setSelections(previous => ({ ...previous, [question.id]: event.target.value }))}
        style={{ display: 'grid', gap: 8, width: '100%' }}>
        {question.options.map(option => <Radio key={option.value} value={option.value}
          style={{ margin: 0, padding: '9px 11px', borderRadius: 8, border: `1px solid ${theme.borderSubtle}` }}>
          <span style={{ color: theme.text }}>{option.label}</span>
          {option.description && <span style={{ display: 'block', marginTop: 2, color: theme.textSecondary, fontSize: 12 }}>
            {option.description}
          </span>}
        </Radio>)}
        {question.allowCustom && <Radio value="__custom__"
          style={{ margin: 0, padding: '9px 11px', borderRadius: 8, border: `1px solid ${theme.borderSubtle}` }}>
          <span style={{ color: theme.text }}>自定义答复</span>
        </Radio>}
      </Radio.Group>
      {question.allowCustom && selections[question.id] === '__custom__' && <Input.TextArea
        aria-label={`${question.question}的自定义答复`} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={1000}
        value={custom[question.id] ?? ''} onChange={event =>
          setCustom(previous => ({ ...previous, [question.id]: event.target.value }))}
        placeholder="请输入你的决定或补充条件" style={{ marginTop: 9 }} />}
    </fieldset>)}
    <Button type="primary" onClick={submit} disabled={!complete || disabled || answered} style={{ marginTop: 18 }}>
      {answered ? '已提交' : '确认并继续'}
    </Button>
  </section>;
}
