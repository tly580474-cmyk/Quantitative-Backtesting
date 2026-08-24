import { copyFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAiModelListValidationError } from '../services/aiModelList.js';

export interface AdminConfigDefinition {
  key: string;
  label: string;
  category: 'access' | 'database' | 'ai' | 'market' | 'runtime';
  description: string;
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  inputType?: 'text' | 'time' | 'boolean' | 'number';
  defaultValue?: string;
  /**
   * 重启影响范围标签（见 §4.3）：
   * - db：需后端全量重启
   * - ai：需重启 AI Provider + 后端
   * - runtime：需重启后端
   * - market：部分即时、部分重启
   * - access：需重启后端
   */
  restartScope: 'db' | 'ai' | 'runtime' | 'market' | 'access';
}

export const ADMIN_CONFIG_DEFINITIONS: AdminConfigDefinition[] = [
  {
    key: 'ADMIN_API_TOKEN',
    label: '管理台访问令牌',
    category: 'access',
    description: '保护全部管理 API。为避免当前会话失效，只允许在 server/.env 中手动修改。',
    secret: true,
    editable: false,
    restartRequired: true,
    restartScope: 'access',
  },
  {
    key: 'DB_HOST',
    label: 'MySQL 地址',
    category: 'database',
    description: 'MySQL 服务主机名或 IP 地址。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'db',
  },
  {
    key: 'DB_PORT',
    label: 'MySQL 端口',
    category: 'database',
    description: 'MySQL 服务监听端口。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'db',
  },
  {
    key: 'DB_USER',
    label: 'MySQL 用户',
    category: 'database',
    description: '业务数据库连接用户。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'db',
  },
  {
    key: 'DB_PASSWORD',
    label: 'MySQL 密码',
    category: 'database',
    description: '业务数据库连接密码。',
    secret: true,
    editable: true,
    restartRequired: true,
    restartScope: 'db',
  },
  {
    key: 'DB_NAME',
    label: 'MySQL 数据库',
    category: 'database',
    description: '量化平台使用的数据库名称。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'db',
  },
  {
    key: 'AI_STRATEGY_ENABLED',
    label: 'AI 功能开关',
    category: 'ai',
    description: '控制策略生成、研究解读等大模型能力。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
    inputType: 'boolean',
    defaultValue: 'false',
  },
  {
    key: 'OPENAI_API_KEY',
    label: '大模型 API Key',
    category: 'ai',
    description: 'OpenAI 或兼容服务的访问密钥。',
    secret: true,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'OPENAI_BASE_URL',
    label: '大模型 API 地址',
    category: 'ai',
    description: 'OpenAI Chat Completions 兼容服务地址。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'OPENAI_MODEL',
    label: '大模型列表',
    category: 'ai',
    description: '模型之间使用英文分号分隔，例如：模型1;模型2;模型3。第一项作为默认模型。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'MARKET_OPINION_PUSH_ENABLED',
    label: '市场观点邮件推送',
    category: 'ai',
    description: '启用 09:00、12:00、16:00 三个时点的智能分析邮件。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
    inputType: 'boolean',
    defaultValue: 'false',
  },
  {
    key: 'MARKET_OPINION_MODEL',
    label: '市场观点邮件模型',
    category: 'ai',
    description: '仅用于早报、午报和盘后总结；留空时使用大模型列表的第一项。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'AGENT_ENABLED', label: 'Agent 系统开关', category: 'ai',
    description: '启用项目内 Agent API；不会改变全局 Codex 登录状态。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'false',
  },
  {
    key: 'AGENT_PROVIDER', label: '默认 Agent Provider', category: 'ai',
    description: '默认使用 claude 或 codex；已有对话始终保持原 Provider。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: 'claude',
  },
  {
    key: 'AGENT_CLAUDE_PATH', label: 'Claude 可执行文件', category: 'ai',
    description: 'Windows 原生 Claude Code 可执行文件或命令名。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: 'claude',
  },
  {
    key: 'AGENT_CLAUDE_WORKING_DIRECTORY', label: 'Claude 工作目录', category: 'ai',
    description: 'Claude Code 可操作的 Windows 项目工作区。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CLAUDE_GIT_BASH_PATH', label: 'Claude Git Bash', category: 'ai',
    description: 'Git for Windows 的 bash.exe 路径。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_ENABLED', label: 'Codex Provider 开关', category: 'ai',
    description: '仅控制本项目 Codex Harness。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'false',
  },
  {
    key: 'AGENT_CODEX_API_KEY', label: 'Codex 项目 API Key', category: 'ai',
    description: '仅注入隔离的 Codex App Server 子进程，不读取全局登录凭据。', secret: true, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_MODEL', label: 'Codex 模型', category: 'ai',
    description: '项目 Harness 使用的模型标识。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_MODEL_PROVIDER', label: 'Codex API Provider', category: 'ai',
    description: '自定义 Provider ID；与 API 地址配套配置。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_BASE_URL', label: 'Codex API 地址', category: 'ai',
    description: '项目专用 API 基址，不影响其他 AI 功能。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_HOME', label: 'Codex 隔离状态目录', category: 'ai',
    description: '必须指向项目专用目录，避免使用全局 Codex 登录状态。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_WORKING_DIRECTORY', label: 'Codex 工作目录', category: 'ai',
    description: '限制 Harness 的项目工作区。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_APPROVALS_ENABLED', label: 'Codex 人工审批', category: 'ai',
    description: '命令、文件修改和网络升级请求需经界面批准。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'true',
  },
  {
    key: 'AGENT_CODEX_TOOLS_ENABLED', label: 'Codex 工具调用', category: 'ai',
    description: '允许隔离工作区内的工具调用；越权操作仍受审批策略约束。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'true',
  },
  {
    key: 'AGENT_CODEX_SANDBOX_MODE', label: 'Codex 沙箱模式', category: 'ai',
    description: 'workspace-write 允许 Codex 在项目工作区内自主读写和执行；不会授予工作区外写权限。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: 'read-only',
  },
  {
    key: 'AGENT_CODEX_WINDOWS_SANDBOX', label: 'Codex Windows 沙箱', category: 'ai',
    description: 'unelevated 使用无需管理员初始化的受限令牌沙箱；已完成官方 elevated setup 后可切换。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: 'unelevated',
  },
  {
    key: 'AGENT_CODEX_NETWORK_ENABLED', label: 'Codex 工作区网络', category: 'ai',
    description: '允许 workspace-write 沙箱中的命令访问本机接口和外部数据源。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'false',
  },
  {
    key: 'AGENT_CODEX_MARKET_DATA_CLI', label: 'Codex 行情只读入口', category: 'ai',
    description: '项目内只读行情 CLI 的绝对路径，只调用本机后端 GET 接口。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_CODEX_EXTERNAL_DATA_SKILL_ENABLED', label: 'A股外部补缺技能', category: 'ai',
    description: '本地接口缺失或过期时，允许 a-stock-data 在工作区网络边界内自主补缺。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', inputType: 'boolean', defaultValue: 'false',
  },
  {
    key: 'AGENT_CODEX_PYTHON_PATH', label: 'Codex 隔离 Python', category: 'ai',
    description: 'a-stock-data 专属虚拟环境 Python，不使用全局 Python 包环境。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai',
  },
  {
    key: 'AGENT_ATTACHMENT_ROOT', label: '智能体附件目录', category: 'ai',
    description: '保存附件原文件和本地转换结果的项目数据目录。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: 'tmp_output/.agent-attachments',
  },
  {
    key: 'AGENT_ATTACHMENT_MAX_FILE_MB', label: '附件单文件上限', category: 'ai',
    description: '单个附件允许的最大 MB 数。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: '20', inputType: 'number',
  },
  {
    key: 'AGENT_ATTACHMENT_MAX_FILES', label: '单轮附件数量', category: 'ai',
    description: '每轮消息最多绑定的附件数量。', secret: false, editable: true,
    restartRequired: true, restartScope: 'ai', defaultValue: '8', inputType: 'number',
  },
  {
    key: 'MARKET_OPINION_MORNING_TIME',
    label: '观点早报推送时间',
    category: 'ai',
    description: '交易日早报的触发时间（上海时间）。若设置在 09:15 之后，报告会把实时盘面明确标记为当日竞价或盘中数据。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
    inputType: 'time',
  },
  {
    key: 'MARKET_OPINION_MIDDAY_TIME',
    label: '观点午报推送时间',
    category: 'ai',
    description: '交易日午间观点报告的触发时间（上海时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
    inputType: 'time',
  },
  {
    key: 'MARKET_OPINION_CLOSE_TIME',
    label: '观点盘后总结时间',
    category: 'ai',
    description: '交易日盘后总结报告的触发时间（上海时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
    inputType: 'time',
  },
  {
    key: 'SMTP_USER',
    label: 'SMTP 账号',
    category: 'ai',
    description: '用于发送市场观点报告的邮箱账号。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'SMTP_PASSWORD',
    label: 'SMTP 授权码',
    category: 'ai',
    description: '邮件服务商生成的 SMTP 授权码，不是网页登录密码。',
    secret: true,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'MAIL_TO',
    label: '报告收件人',
    category: 'ai',
    description: '多个收件地址使用英文逗号分隔。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'ai',
  },
  {
    key: 'MARKET_DATA_API_KEY',
    label: '行情源 API Key',
    category: 'market',
    description: '需要鉴权的扩展行情数据源密钥。',
    secret: true,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
  },
  {
    key: 'TUSHARE_TOKEN',
    label: 'Tushare Token',
    category: 'market',
    description: '历史分钟数据备用更新器访问令牌。',
    secret: true,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
  },
  {
    key: 'TINYSHARE_TOKEN',
    label: 'Tinyshare 授权码',
    category: 'market',
    description: '用于回补 2010 年以来个股资金流历史；管理台仅展示末四位。',
    secret: true,
    editable: true,
    restartRequired: false,
    restartScope: 'market',
  },
  {
    key: 'FUND_FLOW_UPDATE_TIME',
    label: '资金流每日更新时间',
    category: 'market',
    description: '交易日盘后通过 AKShare 更新主力、超大单、大单、中单和小单资金流（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'market',
    inputType: 'time',
    defaultValue: '16:20',
  },
  {
    key: 'FUND_FLOW_RETRY_TIME',
    label: '资金流失败重试时间',
    category: 'market',
    description: '首次盘后更新失败或数据覆盖不足时的自动重试时间（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'market',
    inputType: 'time',
    defaultValue: '17:20',
  },
  {
    key: 'INSTRUMENT_SYNC_ENABLED',
    label: '证券主表自动更新',
    category: 'market',
    description: '使用 Tushare 全市场证券名单自动发现待上市、新上市和退市证券；不会使用东方财富。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'boolean',
    defaultValue: 'true',
  },
  {
    key: 'INSTRUMENT_SYNC_TIME',
    label: '证券主表更新时间',
    category: 'market',
    description: '交易日收盘后刷新沪深北证券主表的触发时间（北京时间），默认先于股票日线更新执行。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'time',
    defaultValue: '15:20',
  },
  {
    key: 'FINANCIAL_DATA_ENABLED',
    label: '财务报表自动更新',
    category: 'market',
    description: '启用后优先使用已配置的 Tushare，并以新浪财经财务报表作为免 Token 备用源，更新 ROE、营收、净利润、现金流和财务质量指标。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'boolean',
    defaultValue: 'true',
  },
  {
    key: 'FINANCIAL_DATA_UPDATE_TIME',
    label: '财务报表更新时间',
    category: 'market',
    description: '财务报表与财务指标每日增量更新的触发时间（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'time',
    defaultValue: '19:00',
  },
  {
    key: 'FINANCIAL_DATA_LOOKBACK_DAYS',
    label: '财务公告回看天数',
    category: 'market',
    description: '每次自动更新重新检查最近若干天公告，用于吸收延迟披露与修订数据。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    defaultValue: '21',
  },
  {
    key: 'SCHEDULE_SKIP_NON_TRADING_PERIODS',
    label: '跳过非交易时段',
    category: 'market',
    description: '开启后，自动行情、指数、分钟数据湖和研究快照任务会跳过对应市场的周末及交易日历已标记的休市日；交易日盘后任务和手动更新不受影响。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'market',
    inputType: 'boolean',
    defaultValue: 'true',
  },
  {
    key: 'MARKET_DATA_SYNC_TIME',
    label: 'MySQL 股票日线更新时间',
    category: 'market',
    description: '交易日收盘后写入 MySQL 日线的触发时间（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'time',
  },
  {
    key: 'MARKET_CN_INDEX_UPDATE_TIME',
    label: 'A 股指数更新时间',
    category: 'market',
    description: 'A 股指数数据自动更新的触发时间（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'time',
  },
  {
    key: 'MARKET_US_INDEX_UPDATE_TIME',
    label: '美股指数更新时间',
    category: 'market',
    description: '美股指数数据自动更新的触发时间（北京时间）。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'market',
    inputType: 'time',
  },
  {
    key: 'RESEARCH_SNAPSHOT_UPDATE_TIME',
    label: 'DuckDB 研究快照主更新时间',
    category: 'runtime',
    description: '从 MySQL 构建并发布 Parquet/DuckDB 研究快照的主触发时间（北京时间）。保存后自动更新 Windows 计划任务。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'runtime',
    inputType: 'time',
  },
  {
    key: 'RESEARCH_SNAPSHOT_RETRY_TIME',
    label: 'DuckDB 研究快照晚间重试时间',
    category: 'runtime',
    description: '研究快照晚间补偿重试的触发时间（北京时间）。保存后自动更新 Windows 计划任务。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'runtime',
    inputType: 'time',
  },
  {
    key: 'RESEARCH_SNAPSHOT_MORNING_RETRY_TIME',
    label: 'DuckDB 研究快照次晨重试时间',
    category: 'runtime',
    description: '研究快照次日早晨补偿重试的触发时间（北京时间）。保存后自动更新 Windows 计划任务。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'runtime',
    inputType: 'time',
  },
  {
    key: 'RESEARCH_SNAPSHOT_RETENTION_ENABLED',
    label: '研究快照自动清理',
    category: 'runtime',
    description: '每次自动或手动更新完成后清理超出保留期的研究快照。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'runtime',
    inputType: 'boolean',
    defaultValue: 'true',
  },
  {
    key: 'RESEARCH_SNAPSHOT_RETENTION_DAYS',
    label: '研究快照保留天数',
    category: 'runtime',
    description: '保留最近若干个 24 小时内生成的全部快照；当前有效快照始终受保护。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'runtime',
    inputType: 'number',
    defaultValue: '5',
  },
  {
    key: 'MINUTE_DATA_UPDATE_TIME',
    label: '分钟数据湖主更新时间',
    category: 'runtime',
    description: '分钟 Parquet 数据湖盘后更新的主触发时间（北京时间）。保存后自动更新 Windows 计划任务。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'runtime',
    inputType: 'time',
  },
  {
    key: 'MINUTE_DATA_RETRY_TIME',
    label: '分钟数据湖重试时间',
    category: 'runtime',
    description: '分钟 Parquet 数据湖盘后补偿重试的触发时间（北京时间）。保存后自动更新 Windows 计划任务。',
    secret: false,
    editable: true,
    restartRequired: false,
    restartScope: 'runtime',
    inputType: 'time',
  },
  {
    key: 'DUCKDB_MAX_CONCURRENT',
    label: 'DuckDB 并发上限',
    category: 'runtime',
    description: '同时运行的 DuckDB 重型研究会话数量。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'runtime',
  },
  {
    key: 'DUCKDB_MAX_QUEUED',
    label: 'DuckDB 等待队列上限',
    category: 'runtime',
    description: '超过并发上限后允许排队的 DuckDB 任务数量。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'runtime',
  },
  {
    key: 'DUCKDB_MAX_TEMP_SIZE',
    label: 'DuckDB 临时空间上限',
    category: 'runtime',
    description: '单机 DuckDB 临时目录允许使用的最大空间。',
    secret: false,
    editable: true,
    restartRequired: true,
    restartScope: 'runtime',
  },
];

const editableKeys = new Set(
  ADMIN_CONFIG_DEFINITIONS.filter((item) => item.editable).map((item) => item.key),
);
const booleanKeys = new Set(
  ADMIN_CONFIG_DEFINITIONS.filter((item) => item.inputType === 'boolean').map((item) => item.key),
);

export function maskConfigValue(value: string, secret: boolean): string | null {
  if (!value) return null;
  if (!secret) return value;
  const suffix = value.slice(-4);
  return `••••${suffix}`;
}

export function listAdminConfig(values: NodeJS.ProcessEnv = process.env) {
  return ADMIN_CONFIG_DEFINITIONS.map((definition) => {
    const value = (values[definition.key] ?? definition.defaultValue ?? '').trim();
    return {
      ...definition,
      configured: value.length > 0,
      maskedValue: maskConfigValue(value, definition.secret),
    };
  });
}

export async function updateEnvFile(
  envFilePath: string | URL,
  updates: Record<string, string>,
): Promise<string[]> {
  const entries = Object.entries(updates);
  if (entries.length === 0) throw new Error('没有需要更新的配置');
  for (const [key] of entries) {
    if (!editableKeys.has(key)) throw new Error(`配置项 ${key} 不允许通过管理台修改`);
    validateEnvValue(key, updates[key]);
  }

  const path = resolve(envFilePath instanceof URL ? fileURLToPath(envFilePath) : envFilePath);
  let source = '';
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const pending = new Map(entries);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    lines.push(`${key}=${serializeEnvValue(pending.get(key) ?? '')}`);
    seen.add(key);
  }
  for (const [key, value] of pending) {
    if (!seen.has(key)) lines.push(`${key}=${serializeEnvValue(value)}`);
  }

  const content = `${lines.join('\n').replace(/\n+$/, '')}\n`;
  const temporary = resolve(dirname(path), `.${Date.now()}-${process.pid}.env.tmp`);
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await copyFile(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  for (const [key, value] of entries) process.env[key] = value;
  return entries.map(([key]) => key);
}

function serializeEnvValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function validateEnvValue(key: string, value: string): void {
  if (key.endsWith('_TIME') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`${key} 必须使用 HH:mm 格式，例如 18:30`);
  }
  if (['DB_HOST', 'DB_USER', 'DB_NAME', 'OPENAI_MODEL'].includes(key) && !value.trim()) {
    throw new Error(`${key} 不能为空`);
  }
  if (key === 'OPENAI_MODEL') {
    const modelError = getAiModelListValidationError(value);
    if (modelError) throw new Error(modelError);
  }
  if (key === 'DB_PORT') {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('DB_PORT 必须是 1 到 65535 的整数');
    }
  }
  if (booleanKeys.has(key) && !['true', 'false'].includes(value)) {
    throw new Error(`${key} 只能是 true 或 false`);
  }
  if (key === 'FINANCIAL_DATA_LOOKBACK_DAYS') {
    const days = Number(value);
    if (!Number.isInteger(days) || days < 7 || days > 365) {
      throw new Error('FINANCIAL_DATA_LOOKBACK_DAYS 必须是 7 到 365 的整数');
    }
  }
  if (key === 'DUCKDB_MAX_CONCURRENT') {
    const concurrency = Number(value);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
      throw new Error('DUCKDB_MAX_CONCURRENT 必须是 1 到 8 的整数');
    }
  }
  if (key === 'DUCKDB_MAX_QUEUED') {
    const queued = Number(value);
    if (!Number.isInteger(queued) || queued < 0 || queued > 100) {
      throw new Error('DUCKDB_MAX_QUEUED 必须是 0 到 100 的整数');
    }
  }
  if (key === 'DUCKDB_MAX_TEMP_SIZE' && !/^\d+(?:\.\d+)?(?:KB|MB|GB|TB)$/i.test(value)) {
    throw new Error('DUCKDB_MAX_TEMP_SIZE 必须使用容量格式，例如 50GB');
  }
  if (key === 'OPENAI_BASE_URL' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error('OPENAI_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址');
    }
  }
  if (key === 'AGENT_PROVIDER' && !['claude', 'codex'].includes(value)) {
    throw new Error('AGENT_PROVIDER 只能是 claude 或 codex');
  }
  if (key === 'AGENT_CODEX_BASE_URL' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      throw new Error('AGENT_CODEX_BASE_URL 必须是有效的 HTTP 或 HTTPS 地址');
    }
  }
}
