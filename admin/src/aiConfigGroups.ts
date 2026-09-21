import type { AdminConfigItem } from './types';

const CORE_KEYS = ['AI_STRATEGY_ENABLED', 'AGENT_ENABLED', 'AGENT_PROVIDER'];
const PROVIDER_ORDER = [
  'ENABLED', 'MODEL', 'MODEL_PROVIDER', 'API_KEY', 'BASE_URL',
  'APPROVALS_ENABLED', 'TOOLS_ENABLED', 'SANDBOX_MODE', 'NETWORK_ENABLED',
  'EXTERNAL_DATA_SKILL_ENABLED', 'PATH', 'WORKING_DIRECTORY', 'HOME',
  'AGENT_DIRECTORY', 'MARKET_DATA_CLI', 'PYTHON_PATH', 'WINDOWS_SANDBOX', 'GIT_BASH_PATH',
];

export function groupAiConfig(items: AdminConfigItem[]) {
  const selectedProvider = items.find((item) => item.key === 'AGENT_PROVIDER')?.maskedValue?.trim().toLowerCase();
  const providers = ['claude', 'codex', 'pi'].sort((a, b) => Number(b === selectedProvider) - Number(a === selectedProvider));
  const definitions = [
    { id: 'core', title: '全局控制', description: '功能总开关与默认 Agent 选择', keys: CORE_KEYS,
      matches: (key: string) => CORE_KEYS.includes(key) },
    { id: 'openai', title: '通用模型 API · OpenAI 兼容', description: '策略生成、研报解读等功能使用的模型与连接凭证',
      keys: ['OPENAI_MODEL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'], matches: (key: string) => key.startsWith('OPENAI_') },
    ...providers.map((provider) => ({
      id: provider, title: `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Pi'} Provider`,
      description: provider === 'claude' ? '可执行文件、工作目录与 Git Bash 环境'
        : provider === 'codex' ? '启用开关、模型连接、执行权限与隔离环境'
          : '启用开关、模型来源与运行目录',
      keys: PROVIDER_ORDER.map((suffix) => `AGENT_${provider.toUpperCase()}_${suffix}`),
      matches: (key: string) => key.startsWith(`AGENT_${provider.toUpperCase()}_`),
    })),
    { id: 'reports', title: '市场观点与邮件推送', description: '推送开关、报告模型、收件人与发送计划',
      keys: ['MARKET_OPINION_PUSH_ENABLED', 'MARKET_OPINION_MODEL', 'MAIL_TO', 'SMTP_USER', 'SMTP_PASSWORD',
        'MARKET_OPINION_MORNING_TIME', 'MARKET_OPINION_MIDDAY_TIME', 'MARKET_OPINION_CLOSE_TIME'],
      matches: (key: string) => key.startsWith('MARKET_OPINION_') || key.startsWith('SMTP_') || key === 'MAIL_TO' },
    { id: 'attachments', title: '附件与容量限制', description: '上传数量、文件大小与存储目录',
      keys: ['AGENT_ATTACHMENT_MAX_FILE_MB', 'AGENT_ATTACHMENT_MAX_FILES', 'AGENT_ATTACHMENT_ROOT'],
      matches: (key: string) => key.startsWith('AGENT_ATTACHMENT_') },
    { id: 'other', title: '其他高级设置', description: '其他大模型运行参数', keys: [] as string[], matches: () => true },
  ];
  const remaining = new Set(items.filter((item) => item.category === 'ai'));
  return definitions.map((definition) => {
    const rank = (key: string) => {
      const index = definition.keys.indexOf(key);
      return index < 0 ? definition.keys.length : index;
    };
    const groupItems = [...remaining].filter((item) => definition.matches(item.key));
    groupItems.forEach((item) => remaining.delete(item));
    groupItems.sort((a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key));
    return { ...definition, isDefault: definition.id === selectedProvider, items: groupItems };
  }).filter((group) => group.items.length > 0);
}
