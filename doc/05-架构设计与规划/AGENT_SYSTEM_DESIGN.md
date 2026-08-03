# 策略研究智能体系统设计文档

## 1. 定位

本系统允许用户在浏览器前端输入策略研究需求（自然语言），由后端编排一个运行在
WSL Ubuntu 中的 Claude Code 智能体自动完成全部研究步骤——数据查询、因子计算、
回测验证、报告撰写——并将实时思考过程和工作步骤流式推送到前端渲染。

核心理念：

- **Claude Code 作为执行引擎** — 不是调用 API 生成文本，而是让 Claude Code 在 WSL
  中拥有完整的项目代码和数据库访问权限，自主编写和运行代码完成任务
- **实时可观测** — 用户能在前端看到 agent 的每一步思考、工具调用、代码执行和输出
- **沙箱隔离** — 所有执行在 WSL 虚拟机内，`--dangerously-skip-permissions` 免确认，
  不影响 Windows 宿主机
- **交互式 HTML 报告** — 最终输出不局限于 Markdown，而是完整的自包含 HTML 文件，
  内嵌 CSS/JS，支持图表交互、表格排序、Tab 切换、动画效果，用户可直接在浏览器中
  打开或下载独立文件

## 2. 系统架构

```text
浏览器 (React 5558)              Fastify 后端 (3001)                WSL Ubuntu
┌────────────────────┐         ┌────────────────────────┐         ┌──────────────────────┐
│  策略输入框         │         │  Agent Route            │         │  Claude Code CLI     │
│  ├ SSE 连接         │◀──SSE──│  ├ 任务队列             │──spawn──│  (claude --danger..) │
│  ├ 实时思考渲染     │  事件流  │  ├ 进程管理             │         │  ├ MySQL 查询         │
│  ├ 步骤时间线       │         │  ├ 输出解析             │◀─stdout│  ├ DuckDB 查询       │
│  └ HTML 报告渲染   │         │  └ 报告持久化           │         │  ├ 因子/回测脚本      │
│    ├ iframe 预览   │         │                        │         │  └ 生成交互式 HTML   │
│    └ 下载 .html    │         │                        │         │    (内嵌 CSS/JS/图表) │
└────────────────────┘         └────────────────────────┘         └──────────────────────┘
                                          │
                                          ▼
                                 ┌──────────────────┐
                                 │  MySQL (3306)    │
                                 │  DuckDB 快照      │
                                 │  Parquet 文件    │
                                 └──────────────────┘
```

### 2.1 数据流

1. 用户在前端输入策略研究需求，点击"启动 Agent"
2. 前端建立 SSE 连接到 `/api/agent/runs/:runId/stream`
3. 后端创建任务记录，`spawn('wsl', ['claude', ...])` 启动 Claude Code 子进程
4. 子进程 stdout/stderr 被逐行捕获，解析为结构化事件推送到前端
5. 前端实时渲染思考过程、工具调用、代码片段
6. Claude Code 完成后，将生成的自包含 HTML 报告写入文件系统，并将路径和
   摘要保存到 MySQL，SSE 连接关闭
7. 前端通过 `iframe` 加载 HTML 报告进行预览，支持下载独立 `.html` 文件

## 3. 技术选型

### 3.1 实时推送：SSE（Server-Sent Events）

选择 SSE 而非 WebSocket 的理由：

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 单向推送适配度 | 完美匹配（后端→前端） | 过度设计 |
| Fastify 支持 | 原生 `reply.raw` 即可实现 | 需引入 `@fastify/websocket` |
| 浏览器原生支持 | `EventSource` 内置，自动重连 | 需手写重连逻辑 |
| HTTP/2 多路复用 | 天然支持 | 需额外处理 |
| 代理/防火墙穿透 | 普通 HTTP | 可能有兼容问题 |

前端通过 `EventSource` API 连接，断线自动重连，无需额外依赖。

### 3.2 Claude Code 调用方式

```bash
wsl claude --dangerously-skip-permissions \
  -p "$(cat /tmp/agent_prompt.txt)" \
  --output-format stream-json \
  --max-turns 50
```

关键参数：

- `--dangerously-skip-permissions` — 跳过所有权限确认，适合 WSL 隔离环境
- `-p` — 非交互模式，传入 prompt 后自动执行
- `--output-format stream-json` — 输出结构化 JSON 流，每行一个事件对象
  （含 `type` 字段区分 `assistant`/`tool_use`/`tool_result` 等）
- `--max-turns` — 限制最大交互轮数，防止无限循环

### 3.3 为什么用 `--dangerously-skip-permissions`

- **WSL 是隔离环境** — 文件系统隔离在 Ubuntu 内，不影响 Windows 宿主机
- **数据库权限受控** — MySQL 通过用户名/密码限制，Claude 无法修改表结构
- **项目是 Git 仓库** — 代码变更可通过 `git checkout` 回滚
- **自动化与人工确认矛盾** — 每步都需确认则无法实现自动化目标

### 3.4 WSL 中项目部署

Claude Code 需要直接访问项目代码和数据库。推荐在 WSL 内维护一份项目 clone：

```bash
# WSL 内
cd /home/yourname/
git clone /mnt/d/github_public_repo/量化回测 quant-agent
cd quant-agent
npm install  # 安装依赖
```

数据库连接：WSL 通过 `host.docker.internal` 或 Windows 宿主 IP 访问 Windows 上的
MySQL（3306 端口）。DuckDB 快照的 Parquet 文件在 Windows 文件系统上，WSL 通过
`/mnt/d/...` 路径访问，或将快照目录软链接到 WSL 内部。

## 4. 后端设计

### 4.1 目录结构

```text
server/src/
  agent/
    orchestrator.ts      # Agent 编排器：进程管理、输出解析、事件推送
    types.ts             # 类型定义：AgentRun, AgentEvent, AgentStatus
    promptBuilder.ts     # 构建发送给 Claude Code 的 prompt
    outputParser.ts      # 解析 Claude Code 的 stream-json 输出
    repository.ts        # MySQL 持久化：任务 CRUD、报告存储
  routes/
    agent.ts             # Fastify route：启动、查询、流式连接、取消
```

### 4.2 数据模型

MySQL 新增表（`server/src/db/schema.ts` 中定义，新增 migration）：

```sql
-- agent_runs: 智能体运行记录
CREATE TABLE agent_runs (
  id              VARCHAR(36) PRIMARY KEY,         -- UUID
  prompt          TEXT NOT NULL,                   -- 用户输入的策略研究需求
  status          ENUM('queued','running','completed','failed','canceled') NOT NULL DEFAULT 'queued',
  pid             INT NULL,                        -- WSL 子进程 PID
  started_at     DATETIME NULL,
  completed_at    DATETIME NULL,
  exit_code      INT NULL,
  error_message   TEXT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status (status),
  INDEX idx_created (created_at)
);

-- agent_events: 智能体事件流水（用于回放和持久化）
CREATE TABLE agent_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id          VARCHAR(36) NOT NULL,
  seq             INT NOT NULL,                    -- 事件序号（从 0 递增）
  event_type      VARCHAR(32) NOT NULL,            -- thought/tool_use/tool_result/text/error/done
  content         TEXT NOT NULL,                   -- JSON 序列化的事件内容
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uk_run_seq (run_id, seq),
  INDEX idx_run (run_id)
);

-- agent_reports: 智能体最终报告（自包含 HTML 文件）
CREATE TABLE agent_reports (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id          VARCHAR(36) NOT NULL UNIQUE,
  title           VARCHAR(255) NOT NULL,
  html_path       VARCHAR(512) NOT NULL,             -- HTML 文件在文件系统中的路径
  file_size       INT NULL,                          -- 文件大小（字节）
  summary         TEXT NULL,                          -- 摘要（纯文本，用于列表展示）
  tags            JSON NULL,                         -- 标签（如 ["动量","回测","IC分析"]）
  charts_count    INT DEFAULT 0,                     -- 报告中图表数量
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at),
  FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
);
```

### 4.3 核心模块

#### 4.3.1 编排器 `orchestrator.ts`

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import type { FastifyReply } from 'fastify';

export interface AgentRunOptions {
  runId: string;
  prompt: string;
  wslProjectPath: string;     // WSL 内项目路径
  maxTurns: number;           // 默认 50
  timeoutMs: number;          // 默认 30 分钟
}

export class AgentOrchestrator {
  private active = new Map<string, { child: ChildProcess; canceled: boolean }>();

  /** 启动 agent 并将事件流推送到 SSE reply */
  async start(options: AgentRunOptions, reply: FastifyReply): Promise<void> {
    const { runId, prompt, wslProjectPath } = options;

    // 构建 prompt 文件
    const fullPrompt = buildPrompt(prompt, wslProjectPath);

    // 启动 Claude Code 子进程
    const child = spawn('wsl', [
      'bash', '-c',
      `cd ${wslProjectPath} && claude --dangerously-skip-permissions -p '${escapeShell(fullPrompt)}' --output-format stream-json --max-turns ${options.maxTurns}`
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    // ... 注册到 active map，设置超时 ...
    this.active.set(runId, { child, canceled: false });

    let seq = 0;

    // stdout: stream-json 逐行输出
    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        const event = this.parseEvent(line);  // 解析 stream-json 行
        if (event) {
          reply.sse({ id: seq, event: event.type, data: JSON.stringify(event) });
          seq++;
        }
      }
    });

    // stderr: 错误输出
    child.stderr.on('data', (chunk) => {
      reply.sse({ id: seq, event: 'error', data: chunk.toString() });
      seq++;
    });

    // 进程结束
    child.on('close', (code) => {
      reply.sse({ id: seq, event: 'done', data: JSON.stringify({ exitCode: code }) });
      this.finalize(runId, code);
      this.active.delete(runId);
    });
  }

  /** 取消运行中的 agent */
  cancel(runId: string): boolean {
    const active = this.active.get(runId);
    if (!active) return false;
    active.canceled = true;
    active.child.kill('SIGTERM');
    return true;
  }
}
```

#### 4.3.2 输出解析器 `outputParser.ts`

Claude Code 的 `--output-format stream-json` 每行输出一个 JSON 对象。解析器
负责将其映射为前端可消费的结构化事件：

```typescript
export interface AgentEvent {
  type: 'thought' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'done';
  content: string;
  metadata?: {
    toolName?: string;        // 工具名称（如 Bash, Read, Write）
    toolInput?: unknown;      // 工具调用参数
    durationMs?: number;      // 工具执行耗时
  };
}

export function parseStreamJsonLine(line: string): AgentEvent | null {
  try {
    const obj = JSON.parse(line);
    switch (obj.type) {
      case 'assistant':
        // Claude 的思考内容
        return { type: 'thought', content: obj.message?.content ?? '' };
      case 'tool_use':
        // 工具调用开始
        return {
          type: 'tool_use',
          content: `调用工具: ${obj.name}`,
          metadata: { toolName: obj.name, toolInput: obj.input }
        };
      case 'tool_result':
        // 工具执行结果
        return {
          type: 'tool_result',
          content: typeof obj.content === 'string'
            ? obj.content.slice(0, 2000)  // 截断过长输出
            : JSON.stringify(obj.content).slice(0, 2000),
          metadata: { toolName: obj.tool_use_name }
        };
      case 'result':
        // 最终输出
        return { type: 'text', content: obj.result };
      default:
        return null;
    }
  } catch {
    return null;
  }
}
```

#### 4.3.3 Prompt 构建器 `promptBuilder.ts`

构建发送给 Claude Code 的系统 prompt，注入项目上下文和 HTML 报告规范：

```typescript
export function buildPrompt(userPrompt: string, projectPath: string): string {
  return `你是一个量化策略研究智能体，运行在 ${projectPath} 项目环境中。

## 项目能力

你可以使用以下工具完成策略研究：

### 1. MySQL 数据库

项目有 MySQL 数据库（连接配置见 \`server/.env\`），你可以用 Python（\`mysql-connector-python\`
或 \`pymysql\`）或 TypeScript（\`npx tsx -e "..."\`）执行 SQL 查询。

**可查询的主要表和数据范围**：

| 表名 | 内容 | 说明 |
|------|------|------|
| \`daily_candles\` | 日线 OHLCV 行情 | A 股个股日线，含开高低收、成交量、成交额 |
| \`daily_bars_v2\` | v2 历史 K 线 | 含复权因子、来源标记 |
| \`daily_stock_metrics\` | 日度股票指标 | PE_TTM、PB、PS_TTM、换手率、流通市值等 |
| \`instruments\` | 股票主数据 | 代码、名称、市场、行业、上市/退市日期、状态 |
| \`adjustment_factors\` / \`adjustment_factors_v2\` | 复权因子 | 前/后复权计算 |
| \`trading_calendar\` | 交易日历 | 判断交易日、排除非交易日 |
| \`factor_definitions\` + \`factor_versions\` | 因子定义 | 内置因子目录和版本 |
| \`factor_runs\` + \`factor_reports\` | 因子研究记录 | IC、ICIR、分层收益等历史结果 |
| \`factor_candidates\` | 候选因子 | 状态机管理（draft→tested→published） |
| \`market_datasets\` | 数据集 | 已导入的数据集元信息 |
| \`index_constituent_members\` | 指数成分股 | 沪深 300、中证 500 等成分股快照 |
| \`dividend_events\` | 分红事件 | 除权除息记录 |
| \`sw_industry_definitions\` + \`sw_industry_memberships\` | 申万行业 | 行业分类和成员关系 |

> ⚠️ 因子库中的数据暂不完整，部分因子可能只有定义但没有计算结果。
> 如需使用未计算的因子，请自行编写 Python 脚本定义和计算因子值。

### 2. DuckDB 研究快照

Parquet 快照在 \`server/data/snapshots/\` 下，用 DuckDB CLI 高效查询：

\`\`\`bash
cd server && npm run duckdb
\`\`\`

**DuckDB 使用教程**：完整教程请参考 \`doc/02-因子研究与查询/LOCAL_DUCKDB_CLI_GUIDE.md\`，
该文档包含 DuckDB CLI 安装、连接 Parquet 快照、常用查询语法、以及与 MySQL 数据
联表的示例。

DuckDB 快照包含 K 线字段及派生指标（PE_TTM、PB、PS_TTM、量比等），适合大批量
分析查询，性能远优于直接查 MySQL。

### 3. 外部数据获取

**允许使用外部数据源**。你可以参考项目中的 \`a-stock-data\` 技能（Skill）获取
A 股实时行情、财务数据、研报等。可用外部数据源包括：

- **akshare**（Python）：A 股行情、财务、资金流、龙虎榜、北向资金等
- **mootdx / 通达信**：实时行情和 K 线
- **东方财富 / 同花顺**：研报、财务三表、资金流
- **巨潮资讯**：公告数据

使用外部数据时，请先安装所需 Python 包（\`pip install akshare\` 等），并在报告中
注明数据来源。

### 4. 回测

**回测通过编写 Python 脚本完成**。项目中前端有完整的回测引擎（TypeScript），
但后端 CLI 暂不开放。请在 WSL 中编写 Python 回测脚本，自行实现：

- 信号生成（T 日产生信号，T+1 日开盘执行，避免前视偏差）
- 买卖滑点和佣金计算（买入：开盘价 × (1 + 滑点)；卖出：开盘价 × (1 - 滑点)）
- 佣金率参考：买入和卖出均收佣金，卖出额外收印花税
- 组合管理和净值曲线
- 绩效指标计算（年化收益、最大回撤、夏普比率、胜率等）

也可参考项目中的回测规则文档 \`CLAUDE.md\` 中的"Backtest Engine Rules"部分。

### 5. 因子研究

可运行项目内置因子分析：
\`\`\`bash
cd server && npm run factor:run -- --factor momentum_20 --start 2026-05-01 --end 2026-06-30
\`\`\`

如需自定义因子，编写 Python 脚本计算因子值并存入 MySQL，或直接在回测脚本中
内联计算。

### 6. 报告生成

最终输出一份自包含的 HTML 研究报告文件。详见下方"报告输出规范"。

## 用户需求

${userPrompt}

## 报告输出规范

1. 研究过程中，逐步展示你的思考和执行步骤
2. 最终输出一份**完整的自包含 HTML 文件**，写入到 \`reports/<runId>.html\` 路径

### HTML 报告要求

- **自包含**：所有 CSS、JS 必须内联在 HTML 文件中，不引用任何外部资源
  （字体可用系统字体，图表用内联 SVG 或 Canvas 绘制，禁止引用 CDN）
- **交互性**：必须包含可交互元素，如：
  - 可排序/筛选的数据表格（点击表头排序）
  - Tab 切换展示不同分析维度
  - 图表 hover 显示详细数据（用 SVG 或 Canvas 实现）
  - 折叠/展开的详细分析区块
  - 关键指标卡片的动画效果
- **视觉设计**：
  - 使用金融蓝（#1a73e8）为主色调，配合浅色背景和深色文字
  - 多层阴影营造视觉层次感（box-shadow 组合）
  - 响应式布局，适配不同屏幕宽度
  - 中文排版优化（行高 1.8，字体大小 14-16px）
- **报告结构**：
  - 报告标题和元信息（研究日期、数据范围、作者）
  - 研究目标和假设
  - 数据说明（数据来源、时间范围、样本数）
  - 分析方法和过程
  - 结果展示（交互式图表、可排序表格、关键指标卡片）
  - 结论和建议
  - 风险提示
- **图表实现**：使用内联 SVG 或 Canvas API 绘制，不依赖任何 JS 图表库。
  常见图表类型：折线图、柱状图、散点图、热力图
- **文件标记**：HTML 文件中 \`<title>\` 标签内容以"研究报告："开头

### 报告模板参考

项目提供了 4 种风格的 HTML 报告模板，位于
\`doc/05-架构设计与规划/agent-report-templates/\` 目录下：

| 模板文件 | 风格 | 适用场景 |
|----------|------|----------|
| \`01-classic-blue.html\` | 经典金融蓝 | 正式报告，蓝白配色 |
| \`02-dark-pro.html\` | 暗黑专业版 | 深度阅读，GitHub Dark 风格 |
| \`03-minimal-white.html\` | 极简白 | Apple/Notion 风格，移动端友好 |
| \`04-dashboard.html\` | 数据仪表盘 | Bloomberg 终端风格，高信息密度 |

生成报告时可参考上述模板的 CSS 变量体系、交互组件和布局结构。
所有模板均通过了 Impeccable 设计检测器验证，无 AI 生成 UI 反模式。

### 报告提取标记

在 HTML 文件的 \`<!-- REPORT_SUMMARY: ... -->\` 注释中写入一行纯文本摘要，
系统会提取该摘要用于报告列表展示。
`;
}
```

### 4.4 Route 设计

```typescript
// server/src/routes/agent.ts
import type { FastifyInstance } from 'fastify';

export function registerAgentRoutes(fastify: FastifyInstance) {

  // POST /api/agent/runs — 创建并启动 agent
  fastify.post('/api/agent/runs', {
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 10 },
          maxTurns: { type: 'number', default: 50 },
          timeoutMinutes: { type: 'number', default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const { prompt, maxTurns, timeoutMinutes } = request.body;
    const runId = crypto.randomUUID();

    // 创建数据库记录
    await agentRepository.createRun(runId, prompt);

    // 启动子进程（异步，不阻塞响应）
    orchestrator.start({
      runId, prompt,
      wslProjectPath: config.AGENT_WSL_PROJECT_PATH,
      maxTurns, timeoutMs: timeoutMinutes * 60_000,
    });

    reply.code(201).send({ runId, status: 'queued' });
  });

  // GET /api/agent/runs/:runId/stream — SSE 实时事件流
  fastify.get('/api/agent/runs/:runId/stream', async (request, reply) => {
    const { runId } = request.params;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // 重放历史事件（断线重连场景）
    const history = await agentRepository.listEvents(runId);
    for (const evt of history) {
      reply.raw.write(`id: ${evt.seq}\nevent: ${evt.eventType}\ndata: ${evt.content}\n\n`);
    }

    // 订阅实时事件
    orchestrator.subscribe(runId, (event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    request.raw.on('close', () => {
      orchestrator.unsubscribe(runId);
    });
  });

  // POST /api/agent/runs/:runId/cancel — 取消运行中的 agent
  fastify.post('/api/agent/runs/:runId/cancel', async (request, reply) => {
    const { runId } = request.params;
    const ok = orchestrator.cancel(runId);
    if (!ok) return reply.code(404).send({ error: '运行不存在或已完成' });
    reply.send({ status: 'canceled' });
  });

  // GET /api/agent/runs — 列出历史运行
  fastify.get('/api/agent/runs', async (request, reply) => {
    const { status, limit = 20, offset = 0 } = request.query;
    const runs = await agentRepository.listRuns({ status, limit, offset });
    reply.send({ items: runs });
  });

  // GET /api/agent/reports/:runId — 获取报告元信息
  fastify.get('/api/agent/reports/:runId', async (request, reply) => {
    const report = await agentRepository.getReport(request.params.runId);
    if (!report) return reply.code(404).send({ error: '报告不存在' });
    reply.send(report);  // 返回元信息（不含 HTML 全文，前端用此信息加载 iframe）
  });

  // GET /api/agent/reports/:runId/html — 获取 HTML 报告文件（用于 iframe 加载）
  fastify.get('/api/agent/reports/:runId/html', async (request, reply) => {
    const report = await agentRepository.getReport(request.params.runId);
    if (!report) return reply.code(404).send({ error: '报告不存在' });
    // 直接返回 HTML 文件内容，设置正确的 Content-Type
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Content-Disposition', `inline; filename="${report.title}.html"`);
    const html = await readFile(report.htmlPath);
    reply.send(html);
  });

  // GET /api/agent/reports/:runId/download — 下载 HTML 报告文件
  fastify.get('/api/agent/reports/:runId/download', async (request, reply) => {
    const report = await agentRepository.getReport(request.params.runId);
    if (!report) return reply.code(404).send({ error: '报告不存在' });
    reply.header('Content-Type', 'text/html; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${report.title}.html"`);
    const html = await readFile(report.htmlPath);
    reply.send(html);
  });
}
```

### 4.5 SSE 响应实现

Fastify 中 SSE 的基础实现：

```typescript
async function startSSE(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // 禁用 nginx 缓冲（如使用代理）
  });
  reply.raw.write(': connected\n\n');  // 初始注释行，确认连接
}

function sendSSE(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}
```

### 4.6 进程管理与超时

```typescript
const ACTIVE_RUNS = new Map<string, {
  child: ChildProcess;
  canceled: boolean;
  timeout: NodeJS.Timeout;
  subscribers: Set<(event: AgentEvent) => void>();
}>();

function startWithTimeout(runId: string, options: AgentRunOptions) {
  const timeout = setTimeout(() => {
    terminateRun(runId, '超出最大执行时间');
  }, options.timeoutMs);

  // ... spawn child process ...
  ACTIVE_RUNS.set(runId, { child, canceled: false, timeout, subscribers: new Set() });
}

function terminateRun(runId: string, reason: string) {
  const run = ACTIVE_RUNS.get(runId);
  if (!run) return;
  run.canceled = true;
  clearTimeout(run.timeout);
  run.child.kill('SIGTERM');
  // 3 秒后强杀
  setTimeout(() => {
    if (!run.child.killed) run.child.kill('SIGKILL');
  }, 3000);
}
```

## 5. 前端设计

### 5.1 目录结构

```text
src/features/agent/
  AgentRunner.tsx        # 主页面：输入框 + 实时输出 + 报告渲染
  AgentEventList.tsx     # 事件时间线：思考步骤、工具调用、结果
  AgentReportView.tsx    # 最终报告渲染（iframe 加载 HTML + 下载按钮）
  useAgentStream.ts      # SSE 连接 Hook
  types.ts               # 前端类型定义
```

### 5.2 SSE 连接 Hook

```typescript
// src/features/agent/useAgentStream.ts
import { useState, useRef, useCallback } from 'react';

interface AgentStreamState {
  events: AgentEvent[];
  status: 'idle' | 'connecting' | 'running' | 'completed' | 'failed' | 'canceled';
  reportUrl: string | null;   // HTML 报告的 iframe 加载 URL
  reportMeta: { title: string; summary: string } | null;
}

export function useAgentStream() {
  const [state, setState] = useState<AgentStreamState>({
    events: [], status: 'idle', reportUrl: null, reportMeta: null,
  });
  const eventSourceRef = useRef<EventSource | null>(null);

  const connect = useCallback((runId: string) => {
    setState(prev => ({ ...prev, status: 'connecting' }));

    const es = new EventSource(`/api/agent/runs/${runId}/stream`);
    eventSourceRef.current = es;

    es.addEventListener('thought', (e) => {
      const data = JSON.parse(e.data);
      setState(prev => ({
        ...prev, status: 'running',
        events: [...prev.events, { type: 'thought', ...data }],
      }));
    });

    es.addEventListener('tool_use', (e) => {
      const data = JSON.parse(e.data);
      setState(prev => ({
        ...prev, status: 'running',
        events: [...prev.events, { type: 'tool_use', ...data }],
      }));
    });

    es.addEventListener('tool_result', (e) => {
      const data = JSON.parse(e.data);
      setState(prev => ({
        ...prev,
        events: [...prev.events, { type: 'tool_result', ...data }],
      }));
    });

    es.addEventListener('text', (e) => {
      // 最终报告元信息（title + summary）
      const data = JSON.parse(e.data);
      setState(prev => ({
        ...prev,
        reportMeta: { title: data.title, summary: data.summary },
        reportUrl: `/api/agent/reports/${runId}/html`,
      }));
    });

    es.addEventListener('done', (e) => {
      const data = JSON.parse(e.data);
      setState(prev => ({
        ...prev,
        status: data.exitCode === 0 ? 'completed' : 'failed',
      }));
      es.close();
    });

    es.addEventListener('error', (e) => {
      setState(prev => ({ ...prev, status: 'failed' }));
      es.close();
    });
  }, []);

  const disconnect = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, []);

  return { ...state, connect, disconnect };
}
```

### 5.3 页面布局

```text
┌──────────────────────────────────────────────────────────────┐
│  策略研究智能体                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  描述你的研究需求...                                 │    │
│  │  _____________________________________________       │    │
│  │                                                       │    │
│  │  [启动 Agent]  [取消]                   最大轮次: 50  │    │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────┬───────────────────────────────┐  │
│  │  实时步骤            │  报告预览                     │  │
│  │                      │  ┌─────────────────────────┐ │  │
│  │  💭 思考中...        │  │  ┌─────────────────────┐ │ │  │
│  │  🔧 调用 Bash        │  │  │ iframe (HTML 报告) │ │ │  │
│  │  ┌──────────────┐   │  │  │                     │ │ │  │
│  │  │ npx tsx ...  │   │  │  │  [交互式图表]       │ │ │  │
│  │  └──────────────┘   │  │  │  [可排序表格]       │ │ │  │
│  │  ✅ 结果: 3 条记录   │  │  │  [Tab 切换]        │ │ │  │
│  │  💭 分析因子 IC...   │  │  │  [动画指标卡]      │ │ │  │
│  │  🔧 调用 DuckDB      │  │  │                     │ │ │  │
│  │  ...                 │  │  └─────────────────────┘ │ │  │
│  │                      │  │  [下载 HTML] [新窗口打开] │ │  │
│  │                      │  └─────────────────────────┘ │  │
│  └──────────────────────┴───────────────────────────────┘  │
│                                                              │
│  状态: 运行中 (已执行 12 步, 耗时 2m 35s)       [停止]      │
└──────────────────────────────────────────────────────────────┘
```

### 5.4 事件渲染

```typescript
// src/features/agent/AgentEventList.tsx
function AgentEventItem({ event }: { event: AgentEvent }) {
  const icon = {
    thought: '💭',
    tool_use: '🔧',
    tool_result: '✅',
    error: '❌',
    done: '🏁',
  }[event.type] ?? '📄';

  return (
    <div className="agent-event">
      <span className="event-icon">{icon}</span>
      <div className="event-body">
        <div className="event-type">{event.type}</div>
        <div className="event-content">
          {event.type === 'tool_use' && event.metadata?.toolName && (
            <code className="tool-name">{event.metadata.toolName}</code>
          )}
          <pre className="event-text">{event.content}</pre>
        </div>
      </div>
    </div>
  );
}
```

### 5.5 报告渲染（iframe + 下载）

报告是自包含 HTML 文件，通过 `iframe` 加载，支持完整交互和下载：

```typescript
// src/features/agent/AgentReportView.tsx
import { Button, Empty } from 'antd';
import { DownloadOutlined, ExpandAltOutlined } from '@ant-design/icons';

interface AgentReportViewProps {
  reportUrl: string | null;
  reportMeta: { title: string; summary: string } | null;
}

function AgentReportView({ reportUrl, reportMeta }: AgentReportViewProps) {
  if (!reportUrl) {
    return <Empty description="等待报告生成..." />;
  }

  const handleDownload = () => {
    // 触发浏览器下载
    const a = document.createElement('a');
    a.href = reportUrl.replace('/html', '/download');
    a.download = `${reportMeta?.title ?? 'report'}.html`;
    a.click();
  };

  const handleOpenInNewTab = () => {
    window.open(reportUrl, '_blank');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 工具栏 */}
      <div style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontWeight: 600, flex: 1 }}>
          {reportMeta?.title ?? '研究报告中'}
        </span>
        <Button size="small" icon={<DownloadOutlined />} onClick={handleDownload}>
          下载 HTML
        </Button>
        <Button size="small" icon={<ExpandAltOutlined />} onClick={handleOpenInNewTab}>
          新窗口打开
        </Button>
      </div>
      {/* iframe 报告预览 */}
      <iframe
        src={reportUrl}
        style={{ flex: 1, border: 'none', borderRadius: 8 }}
        sandbox="allow-scripts allow-same-origin"
        title="Agent Report"
      />
    </div>
  );
}
```

**iframe 安全策略**：

- `sandbox="allow-scripts allow-same-origin"` — 允许 HTML 内 JS 执行，但不允许
  访问父窗口（防止报告内容篡改前端应用）
- HTML 报告是自包含的（无外部资源请求），不会产生跨域问题
- 下载的 `.html` 文件可在任何浏览器中独立打开，保留全部交互功能

## 6. 配置项

在 `server/.env` 中新增：

```dotenv
# Agent System
AGENT_ENABLED=true
AGENT_WSL_PROJECT_PATH=/home/yourname/quant-agent    # WSL 内项目路径
AGENT_CLAUDE_PATH=claude                               # claude 命令路径
AGENT_DEFAULT_MAX_TURNS=50                             # 默认最大轮次
AGENT_TIMEOUT_MINUTES=30                               # 默认超时（分钟）
AGENT_MAX_CONCURRENT=1                                # 最大并发数（建议 1）
AGENT_REPORT_ROOT=data/agent-reports                   # HTML 报告存储目录
```

在 `server/src/config.ts` 的 Zod schema 中新增：

```typescript
const envSchema = z.object({
  // ... 现有配置 ...

  // Agent System
  AGENT_ENABLED: z.enum(['true', 'false']).default('false'),
  AGENT_WSL_PROJECT_PATH: z.string().default(''),
  AGENT_CLAUDE_PATH: z.string().default('claude'),
  AGENT_DEFAULT_MAX_TURNS: z.string().regex(/^\d+$/).default('50'),
  AGENT_TIMEOUT_MINUTES: z.string().regex(/^\d+$/).default('30'),
  AGENT_MAX_CONCURRENT: z.string().regex(/^\d+$/).default('1'),
  AGENT_REPORT_ROOT: z.string().default('data/agent-reports'),
});
```

## 7. 前端路由

在 `src/router.tsx` 中新增：

```typescript
const AgentPage = lazy(() => import('@/features/agent/AgentRunner'));
// ...
<Route path="/agent" element={<AgentPage />} />
```

## 8. 安全考量

### 8.1 `--dangerously-skip-permissions` 的安全性

| 维度 | 风险 | 缓解 |
|------|------|------|
| 文件系统 | Claude 可能修改 WSL 内文件 | Git 版本控制 + WSL 隔离 |
| 数据库 | Claude 可能执行 DROP/DELETE | MySQL 用户权限限制为 SELECT + 临时表 |
| 网络 | Claude 可能访问外网 | WSL 网络可限制（如需） |
| 资源 | Claude 可能消耗大量 CPU/内存 | 进程超时 + 内存限制 |
| 代码执行 | Claude 可能执行任意命令 | WSL 沙箱隔离，不影响宿主机 |

### 8.2 建议的 MySQL 用户权限

为 Agent 创建只读数据库用户：

```sql
CREATE USER 'agent_ro'@'%' IDENTIFIED BY 'strong-password';
GRANT SELECT ON quant_backtest.* TO 'agent_ro'@'%';
-- 如需写入临时结果表
GRANT CREATE, INSERT, UPDATE, DELETE ON quant_backtest.agent_* TO 'agent_ro'@'%';
```

### 8.3 并发控制

```typescript
const MAX_CONCURRENT = parseInt(config.AGENT_MAX_CONCURRENT, 10);
let runningCount = 0;

async function startIfSlotAvailable(options: AgentRunOptions): Promise<void> {
  if (runningCount >= MAX_CONCURRENT) {
    throw new Error('已达最大并发数，请等待当前任务完成');
  }
  runningCount++;
  // ... 启动 agent ...
  child.on('close', () => {
    runningCount--;
  });
}
```

## 9. 实现计划

### Phase 1: 基础框架（MVP）

- [ ] 数据库表创建（`agent_runs`, `agent_events`, `agent_reports`）
- [ ] 后端 `agent/orchestrator.ts` 核心编排器
- [ ] 后端 `agent/outputParser.ts` 输出解析器
- [ ] 后端 `routes/agent.ts` 三个核心接口（启动、流式、取消）
- [ ] 前端 `useAgentStream.ts` SSE Hook
- [ ] 前端 `AgentRunner.tsx` 基础页面（输入框 + 事件列表）
- [ ] WSL 环境配置（项目 clone、Claude Code 安装、数据库连接验证）

### Phase 2: 体验优化

- [ ] 事件分类渲染（思考、工具调用、代码、结果分开展示）
- [ ] 代码语法高亮
- [ ] 步骤耗时统计
- [ ] 断线重连（SSE `Last-Event-ID` 头 + 历史事件回放）
- [ ] HTML 报告持久化到文件系统并支持历史查看和下载
- [ ] 报告在新窗口全屏打开
- [ ] iframe 自适应高度（通过 `postMessage` 通信）

### Phase 3: 增强功能

- [ ] 报告模板库（预设 HTML 模板框架，减少 Claude Code 重复生成样式）
- [ ] Agent 运行模板（预设常用 prompt）
- [ ] 多轮对话（基于上一次运行结果追问）
- [ ] Agent 运行历史列表和搜索
- [ ] 管理台集成（Agent 运行状态监控）
- [ ] 报告分享（生成短链或导出独立文件）

## 10. API 接口汇总

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/agent/runs` | 创建并启动 agent 运行 |
| GET | `/api/agent/runs/:runId/stream` | SSE 实时事件流 |
| POST | `/api/agent/runs/:runId/cancel` | 取消运行中的 agent |
| GET | `/api/agent/runs` | 列出历史运行（支持 status 过滤） |
| GET | `/api/agent/runs/:runId` | 获取单个运行详情 |
| GET | `/api/agent/reports/:runId` | 获取报告元信息（标题、摘要、标签） |
| GET | `/api/agent/reports/:runId/html` | 获取 HTML 报告内容（`Content-Type: text/html`） |
| GET | `/api/agent/reports/:runId/download` | 下载 HTML 报告文件（`Content-Disposition: attachment`） |
| GET | `/api/agent/reports` | 列出所有报告 |

## 11. 事件类型定义

前端和后端共享的事件类型：

```typescript
interface AgentEvent {
  type: 'thought' | 'tool_use' | 'tool_result' | 'text' | 'error' | 'done';
  content: string;
  metadata?: {
    toolName?: string;
    toolInput?: unknown;
    durationMs?: number;
  };
  seq: number;       // 事件序号
  timestamp: string;  // ISO 时间戳
}
```

| 事件类型 | 含义 | 前端渲染 |
|----------|------|----------|
| `thought` | Claude 的思考过程 | 💭 灰色斜体 |
| `tool_use` | 工具调用开始 | 🔧 蓝色卡片 |
| `tool_result` | 工具执行结果 | ✅ 绿色折叠区 |
| `text` | 最终报告元信息（title + summary） | 触发 iframe 加载 HTML 报告 |
| `error` | 错误信息 | ❌ 红色警告 |
| `done` | 任务完成 | 🏁 状态标记 |

## 12. 注意事项与风险

1. **Claude Code 版本兼容性** — `--output-format stream-json` 的输出格式可能随版本
   变化，`outputParser.ts` 需要适配。建议固定 Claude Code 版本。

2. **WSL 性能** — 跨文件系统访问（`/mnt/d/...`）性能较差，建议将项目 clone 到
   WSL 内部文件系统（`/home/yourname/`）。

3. **长任务稳定性** — 30 分钟超时可能导致复杂研究任务中断。可通过 `maxTurns` 和
   `timeoutMinutes` 参数调整，但需注意 SSE 连接的稳定性。

4. **MySQL 连接池竞争** — Agent 运行时可能占用数据库连接，需确保连接池大小足够
   （建议 poolSize ≥ 10）。

5. **HTML 报告提取** — Claude Code 完成后需将 HTML 文件写到约定的路径
   （`reports/<runId>.html`）。后端在进程结束后检查该文件是否存在：
   - 存在 → 提取 `<title>` 作为报告标题，提取 `<!-- REPORT_SUMMARY: ... -->`
     注释作为摘要，记录到 `agent_reports` 表
   - 不存在 → 标记运行状态为 `failed`，记录错误信息

6. **HTML 报告安全** — 自包含 HTML 文件通过 `iframe` 加载，使用 `sandbox` 属性
   限制权限。Claude Code 生成的 HTML 不应包含恶意脚本（如访问 `parent.document`），
   但 `sandbox` 属性提供了额外的安全保障。下载的 HTML 文件在用户浏览器中独立打开时
   拥有完整权限，但此时由用户自行承担风险。

7. **HTML 文件大小** — 自包含 HTML（含内联 SVG 图表、CSS、JS）通常在 100KB-1MB
   范围。如 Claude Code 生成过大的文件，可考虑在 prompt 中限制图表数量或数据量。
   `agent_reports` 表中 `file_size` 字段用于监控。

## 13. HTML 报告模板参考

以下是 Claude Code 生成 HTML 报告时应遵循的结构示例。实际报告由 Claude Code
根据研究内容自动生成，但应遵循以下设计规范。

### 13.1 报告骨架

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>研究报告：动量因子有效性分析</title>
  <!-- REPORT_SUMMARY: 本报告分析了动量因子在2025年5月至6月期间的IC表现，ICIR为1.32，分层收益单调性良好 -->
  <style>
    /* === 基础变量 === */
    :root {
      --primary: #1a73e8;
      --primary-light: #e8f0fe;
      --primary-dark: #1557b0;
      --text-primary: #202124;
      --text-secondary: #5f6368;
      --bg-main: #f8f9fa;
      --bg-card: #ffffff;
      --border: #e0e0e0;
      --success: #34a853;
      --warning: #f9ab00;
      --danger: #ea4335;
      --shadow-sm: 0 1px 3px rgba(0,0,0,0.08);
      --shadow-md: 0 2px 8px rgba(0,0,0,0.10), 0 0 1px rgba(0,0,0,0.06);
      --shadow-lg: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
      --radius: 10px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      font-size: 15px; line-height: 1.8; color: var(--text-primary);
      background: var(--bg-main); padding: 24px;
    }

    /* === 头部区域 === */
    .report-header {
      background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
      color: white; padding: 32px 28px; border-radius: var(--radius);
      box-shadow: var(--shadow-lg); margin-bottom: 24px;
    }
    .report-header h1 { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
    .report-meta { display: flex; gap: 24px; font-size: 13px; opacity: 0.9; }

    /* === 指标卡片 === */
    .metrics-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px; margin-bottom: 24px;
    }
    .metric-card {
      background: var(--bg-card); padding: 20px; border-radius: var(--radius);
      box-shadow: var(--shadow-md); text-align: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .metric-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
    .metric-value { font-size: 28px; font-weight: 700; color: var(--primary); }
    .metric-label { font-size: 13px; color: var(--text-secondary); margin-top: 4px; }

    /* === Tab 切换 === */
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 2px solid var(--border); }
    .tab {
      padding: 10px 20px; cursor: pointer; border: none; background: none;
      font-size: 14px; color: var(--text-secondary);
      border-bottom: 2px solid transparent; margin-bottom: -2px;
      transition: color 0.2s, border-color 0.2s;
    }
    .tab.active { color: var(--primary); border-bottom-color: var(--primary); }
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

    /* === 可排序表格 === */
    .data-table { width: 100%; border-collapse: collapse; background: var(--bg-card);
      border-radius: var(--radius); overflow: hidden; box-shadow: var(--shadow-md); }
    .data-table th {
      background: var(--primary-light); padding: 12px 16px; text-align: left;
      font-size: 13px; font-weight: 600; color: var(--primary-dark);
      cursor: pointer; user-select: none; white-space: nowrap;
      transition: background 0.15s;
    }
    .data-table th:hover { background: #d0e2fc; }
    .data-table th .sort-indicator { opacity: 0.3; margin-left: 4px; }
    .data-table th.sorted .sort-indicator { opacity: 1; }
    .data-table td { padding: 10px 16px; border-top: 1px solid var(--border); font-size: 14px; }
    .data-table tr:hover { background: #f5f7fa; }

    /* === 折叠区块 === */
    .collapse-section { background: var(--bg-card); border-radius: var(--radius);
      box-shadow: var(--shadow-sm); margin-bottom: 12px; overflow: hidden; }
    .collapse-header { padding: 14px 20px; cursor: pointer; display: flex;
      justify-content: space-between; align-items: center; font-weight: 600; }
    .collapse-body { padding: 0 20px 16px; display: none; }
    .collapse-section.open .collapse-body { display: block; }

    /* === SVG 图表容器 === */
    .chart-container { background: var(--bg-card); padding: 20px;
      border-radius: var(--radius); box-shadow: var(--shadow-md); margin-bottom: 16px; }
    .chart-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; }
    .chart-tooltip {
      position: absolute; background: rgba(0,0,0,0.8); color: white;
      padding: 6px 10px; border-radius: 4px; font-size: 12px;
      pointer-events: none; opacity: 0; transition: opacity 0.15s;
    }
  </style>
</head>
<body>

  <!-- 报告头部 -->
  <div class="report-header">
    <h1>研究报告：动量因子有效性分析</h1>
    <div class="report-meta">
      <span>研究日期：2026-08-03</span>
      <span>数据范围：2025-05-01 ~ 2025-06-30</span>
      <span>样本数：5,200</span>
    </div>
  </div>

  <!-- 关键指标卡片 -->
  <div class="metrics-grid">
    <div class="metric-card"><div class="metric-value">1.32</div><div class="metric-label">ICIR</div></div>
    <div class="metric-card"><div class="metric-value">0.085</div><div class="metric-label">Mean IC</div></div>
    <div class="metric-card"><div class="metric-value">78%</div><div class="metric-label">IC 胜率</div></div>
    <div class="metric-card"><div class="metric-value">2.4%</div><div class="metric-label">多头超额收益</div></div>
  </div>

  <!-- Tab 区域 -->
  <div class="tabs">
    <button class="tab active" onclick="switchTab(event, 'ic-analysis')">IC 分析</button>
    <button class="tab" onclick="switchTab(event, 'layer-returns')">分层收益</button>
    <button class="tab" onclick="switchTab(event, 'decay')">因子衰减</button>
  </div>

  <div id="ic-analysis" class="tab-content active">
    <div class="chart-container">
      <div class="chart-title">每日 IC 时间序列</div>
      <!-- 内联 SVG 图表，hover 时显示 tooltip -->
      <svg width="100%" height="240" viewBox="0 0 800 240" id="ic-chart"><!-- SVG 图表内容 --></svg>
    </div>
  </div>

  <div id="layer-returns" class="tab-content">
    <table class="data-table" id="layer-table">
      <thead>
        <tr>
          <th onclick="sortTable('layer-table', 0)">分层 <span class="sort-indicator">↕</span></th>
          <th onclick="sortTable('layer-table', 1)">日均收益 <span class="sort-indicator">↕</span></th>
          <th onclick="sortTable('layer-table', 2)">夏普比率 <span class="sort-indicator">↕</span></th>
          <th onclick="sortTable('layer-table', 3)">最大回撤 <span class="sort-indicator">↕</span></th>
        </tr>
      </thead>
      <tbody>
        <!-- 数据行由 Claude Code 生成 -->
      </tbody>
    </table>
  </div>

  <div id="decay" class="tab-content">
    <div class="collapse-section">
      <div class="collapse-header" onclick="toggleCollapse(this)">
        <span>因子衰减分析</span><span>▼</span>
      </div>
      <div class="collapse-body">
        <p>详细分析内容...</p>
      </div>
    </div>
  </div>

  <!-- 结论与风险提示 -->
  <div class="chart-container">
    <div class="chart-title">结论与建议</div>
    <p>1. 动量因子在测试区间内表现稳健...</p>
    <p>2. 建议结合反转因子构建复合策略...</p>
  </div>

  <script>
    // Tab 切换
    function switchTab(e, tabId) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      e.target.classList.add('active');
      document.getElementById(tabId).classList.add('active');
    }

    // 表格排序
    function sortTable(tableId, colIdx) {
      const table = document.getElementById(tableId);
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      const asc = table.dataset.sortCol == colIdx ? !(table.dataset.sortAsc === 'true') : true;
      rows.sort((a, b) => {
        const va = a.cells[colIdx].textContent.replace(/[%]/g, '');
        const vb = b.cells[colIdx].textContent.replace(/[%]/g, '');
        return asc ? parseFloat(va) - parseFloat(vb) : parseFloat(vb) - parseFloat(va);
      });
      rows.forEach(r => tbody.appendChild(r));
      table.dataset.sortCol = colIdx;
      table.dataset.sortAsc = asc;
      // 更新排序指示器
      table.querySelectorAll('th').forEach((th, i) => {
        th.classList.toggle('sorted', i === colIdx);
        const ind = th.querySelector('.sort-indicator');
        if (ind) ind.textContent = i === colIdx ? (asc ? '↑' : '↓') : '↕';
      });
    }

    // 折叠区块
    function toggleCollapse(header) {
      header.parentElement.classList.toggle('open');
      const arrow = header.querySelector('span:last-child');
      if (arrow) arrow.textContent = header.parentElement.classList.contains('open') ? '▲' : '▼';
    }

    // SVG 图表 hover tooltip（由 Claude Code 根据实际数据实现）
    // ...
  </script>
</body>
</html>
```

### 13.2 交互功能清单

报告 HTML 中应实现以下交互功能（全部用原生 JS，不依赖外部库）：

| 交互功能 | 实现方式 | 用户体验 |
|----------|----------|----------|
| Tab 切换 | `switchTab()` 切换 `.active` 类 | 切换不同分析维度，带淡入动画 |
| 表格排序 | 点击表头，`sortTable()` 排序 tbody 行 | 升序/降序切换，箭头指示当前排序 |
| 折叠区块 | `toggleCollapse()` 切换 `.open` 类 | 展开查看详细分析，收起节省空间 |
| SVG 图表 hover | `mousemove` 事件 + tooltip `div` | 鼠标悬停显示具体数值 |
| 指标卡片动画 | CSS `transition` + `:hover` | 卡片上浮，阴影加深 |
| 响应式布局 | CSS Grid `auto-fit` + `minmax` | 适配不同屏幕宽度 |
