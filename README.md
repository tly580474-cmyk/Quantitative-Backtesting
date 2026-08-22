<div align="center">

#  📊 量化行情分析与策略回测

**A股研究一体化平台 — 行情分析 · 数据管理 · 选股评分 · 智能交易 · 策略回测 · 因子研究 · AI 智能体**

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![MySQL](https://img.shields.io/badge/MySQL-8-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com)
[![DuckDB](https://img.shields.io/badge/DuckDB-FFF000?logo=duckdb&logoColor=black)](https://duckdb.org)
[![Ant Design](https://img.shields.io/badge/Ant_Design-6-1677FF?logo=ant-design&logoColor=white)](https://ant.design)

<div align="center">
  <video src="./Intro.mp4" width="860" controls muted loop></video>
</div>

</div>

> ⚠️ **风险提示**：本项目用于研究和学习，**不构成投资建议**。公开行情接口可能受网络状态、上游限流或接口调整影响。

---

## 📋 目录

- [核心功能](#-核心功能)
- [技术架构](#-技术架构)
- [快速开始](#-快速开始)
- [配置指南](#-配置指南)
- [使用流程](#-使用流程)
- [常用命令](#-常用命令)
- [项目结构](#-项目结构)
- [技术栈](#-技术栈)
- [故障排查](#-故障排查)
- [文档与计划](#-文档与计划)
- [数据与隐私](#-数据与隐私)

---

## 🚀 核心功能

### 📈 行情分析
- 批量导入 `.xlsx`/`.xls`/`.csv` 日频行情，自动映射中英文表头
- K 线图表（TradingView Lightweight Charts）叠加 MA5/10/20，十字光标与区间涨跌
- 18 种技术指标：SMA、EMA、BOLL、MACD、RSI、KDJ、ATR、CCI、WR、OBV、成交量均线等

### 📊 市场数据
- 5000+ A 股搜索（代码/简称/拼音），自选股模式按需加载
- 实时行情、PE/PB、估值、市值、换手率、量比、振幅
- 日 K / 周 K / 年 K / 前复权，自定义区间
- 五套独立选股评分：价值投资、成长型、逆向抄底、趋势型、短线打板
- 当日热门板块、市场技术筛选、全市场概况

### 🤖 智能交易系统
- 8 种交易流派：价值投资、成长赛道、周期投资、逆向抄底、传统指标、缠论结构、趋势跟踪、短线打板
- 多策略冲突裁决：风险否决 > 大盘环境 > 个股强弱 > 策略证据 > 消息催化
- 自动整合实时行情、K 线、全市场快照、公告、分红、新闻
- 深度分析报告，Markdown 渲染

### 🧠 智能体系统
- 支持 **Claude Code**（WSL Ubuntu）与 **Codex App Server**（Windows）双 Provider，可按新对话选择
- 输入问题后自动执行多步研究，并按任务复杂度与用户要求判断是否生成结构化 HTML 报告
- 实时 SSE 展示执行进度、工具调用与输出，支持事件持久化、刷新恢复和取消运行
- 对话历史管理、删除任务和继续对话；同一对话固定沿用创建时的 Provider
- Codex 在项目工作区内自主运行命令、修改文件和执行测试，常规操作不逐步请求人工审批
- 行情查询遵循“项目本地接口优先，明确缺失后再由 a-stock-data 补缺”的顺序
- 四套可配置报告模板：经典金融蓝 / 暗色专业 / 极简白 / 数据面板

### 🎯 策略研究
- **策略工作室**：自然语言生成策略 DSL，可视化节点编辑器
- **策略回测**：双均线、RSI、MACD、BOLL 等内置策略，支持自定义参数
- 回测引擎：T 日信号 → T+1 开盘成交，滑点/手续费/印花税，绩效指标
- **因子研究**：20+ 内置因子，单因子/多因子复合运行，IC/ICIR/分层收益
- 因子候选工作流：草稿 → 冻结 → 测试 → 审批 → 发布

### 🗄️ 数据管理
- IndexedDB / MySQL 双存储，数据迁移与导出
- 全量历史行情库（MySQL）自动同步，研究快照（Parquet）构建
- 成交量单位自动校验与修复，除权除息检测
- 运维管理台：诊断、配置编辑、监控大盘

---

## 🏗️ 技术架构

```
Browser
├── React 19 + Ant Design 6  —  UI 界面
├── TradingView Lightweight Charts  —  K 线图表
├── IndexedDB (Dexie)  —  本地数据持久化
├── Zustand  —  状态管理
├── Web Worker  —  回测引擎异步执行
└── SSE Client  —  智能体实时事件流
        │
        ▼
Fastify 5 Server (localhost:3001)
├── MySQL 8 (Drizzle ORM)  —  持久化存储
├── Market Data Providers
│   ├── 腾讯财经  —  实时行情、估值、K 线
│   ├── 新浪财经  —  美股指数、全市场名单
│   ├── 巨潮资讯  —  个股公告
│   ├── 东方财富  —  研报、新闻、板块（可选补充）
│   └── Tushare  —  证券主表（可选）
├── Python Toolchain
│   ├── 指数成分股 / 分红事件 / 申万行业
│   └── 分钟数据湖（TDX 导入 + 在线更新）
├── DuckDB  —  OLAP 研究快照查询引擎
├── OpenAI SDK  —  AI 策略生成 + 智能交易
├── Agent Orchestrator
│   ├── WSL Claude Code  —  Claude Provider
│   ├── Codex stdio App Server  —  Codex Provider、续接、取消与工具事件
│   ├── 项目行情 CLI  —  本机只读数据入口，本地数据优先
│   ├── SSE 实时流推送  —  事件持久化与断点续传
│   └── HTML 报告生成
└── Scheduler  —  数据同步、因子挖掘、市场推送
```

---

## 🚀 快速开始

### 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`
- npm
- MySQL 8.x（仅 API 持久化模式需要）

### 一键启动（Windows）

双击 `start.bat`，自动安装依赖、启动后端（3001）和前端（5173/5558）。

### 手动启动

```bash
# 安装前端依赖
npm install

# 安装后端依赖
cd server && npm install && cd ..

# 终端 1：后端
cd server && npm run dev

# 终端 2：前端
npm run dev
```

访问 `http://localhost:5173/`（开发）或 `http://localhost:5558/`（生产）。

---

## ⚙️ 配置指南

### 前端配置

```dotenv
# .env
VITE_DATA_SOURCE=api                      # api / indexeddb
VITE_API_URL=http://localhost:3001
VITE_ALLOW_INDEXEDDB_MIGRATION=false
```

### 后端核心配置

```dotenv
# server/.env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=quant_backtest

AI_STRATEGY_ENABLED=true
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://your-provider.example/v1
OPENAI_MODEL=model-1;model-2;model-3   # 英文分号分隔，第一项为默认模型

PORT=3001
```

### 智能体系统配置

```dotenv
AGENT_ENABLED=true
AGENT_PROVIDER=claude          # claude / codex；仅作为新对话默认值

# Claude Code Provider（WSL）
AGENT_WSL_PROJECT_PATH=/mnt/d/github_public_repo/量化回测
AGENT_CLAUDE_PATH=claude

# Codex Provider（Windows 原生，按需开启）
AGENT_CODEX_ENABLED=true
AGENT_CODEX_PATH=codex
AGENT_CODEX_MODEL=
AGENT_CODEX_WORKING_DIRECTORY=D:/github_public_repo/量化回测
AGENT_CODEX_HOME=C:/Users/<you>/AppData/Local/QuantBacktest/codex-home
AGENT_CODEX_API_KEY=your-project-specific-key
AGENT_CODEX_APPROVALS_ENABLED=false
AGENT_CODEX_TOOLS_ENABLED=true
AGENT_CODEX_SANDBOX_MODE=workspace-write
AGENT_CODEX_WINDOWS_SANDBOX=unelevated
AGENT_CODEX_NETWORK_ENABLED=true
AGENT_CODEX_MARKET_DATA_CLI=D:/github_public_repo/量化回测/server/scripts/agentMarketData.mjs
AGENT_CODEX_EXTERNAL_DATA_SKILL_ENABLED=true
AGENT_CODEX_PYTHON_PATH=C:/Users/<you>/AppData/Local/QuantBacktest/codex-home/a-stock-data-venv/Scripts/python.exe

AGENT_DEFAULT_MAX_TURNS=0     # 0=不限制
AGENT_TIMEOUT_MINUTES=30
AGENT_CODEX_TIMEOUT_MINUTES=60
AGENT_MAX_CONCURRENT=1
AGENT_REPORT_ROOT=data/agent-reports
```

> 智能体访问地址：`http://localhost:5558/#/agent`。Claude Provider 需要在 WSL Ubuntu 中安装 `claude`；Codex Provider 使用 Windows 原生 `codex` CLI。Codex Harness 使用独立 `AGENT_CODEX_HOME` 和项目 API Key，不读取或修改全局 Codex 登录状态。OpenRouter 等自定义 Responses Provider 的配置见 [Codex 运行手册](./docs/agent-codex-runtime.md)。

### 市场数据自动同步

```dotenv
MARKET_DATA_ENABLED=true
MARKET_DATA_PROVIDER=tencent
INSTRUMENT_SYNC_TIME=15:20
MARKET_DATA_SYNC_TIME=15:30
SCHEDULE_SKIP_NON_TRADING_PERIODS=true
```

> 所有调度时间按 `Asia/Shanghai` 解释。更多配置见 [配置文件说明](doc/05-架构设计与规划/)。

---

## 📖 使用流程

### 市场数据 + 智能交易

1. 启动前端和后端
2. 打开「市场数据」→ 搜索股票加入自选
3. 展开「市场概况」「热门板块」「自选评分」「技术筛选」
4. 查看个股实时指标、K 线、评分明细
5. 在智能交易系统中选择 1–3 种流派，运行分析

### 导入数据 + 策略回测

1. 点击「导入 Excel」→ 选择本地日频行情文件
2. 保存数据集 → 在「数据管理」中打开
3. 进入「策略回测」→ 选择策略、设置参数
4. 运行回测 → 查看绩效和交易明细

### 智能体研究

1. 打开智能体页面（`/agent`）
2. 新建对话时选择 Claude 或 Codex Provider
3. 输入研究问题（如“调查某家公司近期重要公告与行情变化”）
4. 实时观察执行进度与工具调用
5. 对于明确要求报告或值得留档的复杂研究，查看自动生成的 HTML 研究报告

Codex 查询行情时先使用项目只读入口；只有项目接口返回空、缺少必要字段或数据已过期时，才使用项目隔离目录中的 `a-stock-data` 技能补缺。外部结果不会自动回写项目数据库或数据湖。

---

## 🔧 常用命令

```bash
# 前端
npm run dev              # 开发服务器 (5558)
npm run build            # 生产构建
npm test                 # 测试

# 后端
cd server && npm run dev        # 开发服务器 (3001)
cd server && npm run typecheck  # 类型检查
cd server && npm run agent:codex:probe  # Codex 连通性与续接探针

# Codex 项目行情入口
node server/scripts/agentMarketData.mjs catalog
node server/scripts/agentMarketData.mjs quote 600519

# 数据底座
cd server && npm run snapshot:freshness   # 研究快照新鲜度
cd server && npm run snapshot:build       # 构建快照
cd server && npm run data:gate            # 数据健康门禁

# 因子研究
cd server && npm run factor:list
cd server && npm run factor:run -- --factor momentum_20 --start 2026-05-01 --end 2026-06-30

# 备份
cd server && npm run backup:create
cd server && npm run backup:verify -- --path ./data/backups/<backup-id>
```

---

## 📁 项目结构

```
src/                          # 前端应用
├── api/                      # API 客户端
├── components/               # 通用组件
├── features/
│   ├── import/               # Excel 导入与行情校验
│   ├── chart/                # K 线图表
│   ├── indicators/           # 技术指标（18 种）
│   ├── marketData/           # 自选评分、市场概况、热门板块
│   ├── agent/                # 智能体系统（AgentRunner、SSE 流式、事件列表）
│   ├── dataLibrary/          # 数据集管理
│   ├── strategies/           # 策略协议与内置策略
│   ├── visualStrategies/     # 可视化策略编辑器
│   ├── strategyStudio/       # AI 策略工作室
│   ├── backtest/             # 回测引擎
│   ├── backtestResults/      # 回测报告
│   └── factorResearch/       # 因子研究 UI
├── models/                   # 业务模型
├── stores/                   # Zustand 状态管理
├── workers/                  # Web Worker 回测入口
├── db/                       # IndexedDB 数据库
└── admin/                    # 运维管理台

server/src/                   # 后端服务
├── marketData/               # 数据源、同步、缓存、质量
├── routes/                   # Fastify API 路由
├── services/
│   ├── agent/                # 智能体编排器、仓储、提示词
│   │   └── providers/        # Claude / Codex Provider
│   └── strategyGeneration/   # AI 策略生成
├── factorResearch/           # 因子引擎、候选工作流、挖掘
├── research/                 # 研究快照、DuckDB 查询
├── historyImport/            # 历史数据批量导入
├── backup/                   # 备份与恢复
├── referenceData/            # 指数、分红、行业（Python）
├── minuteData/               # 分钟数据湖（Python）
├── admin/                    # 管理 API
└── db/                       # MySQL Schema 与迁移
```

---

## 🛠️ 技术栈

| 层 | 技术 |
|---|---|
| **前端** | React 19, TypeScript 7, Vite, Ant Design 6 |
| **图表** | TradingView Lightweight Charts 5 |
| **状态** | Zustand 5 + Immer |
| **本地存储** | Dexie 4 (IndexedDB) |
| **后端** | Fastify 5, TypeScript 7 |
| **数据库** | MySQL 8 (Drizzle ORM), DuckDB (OLAP) |
| **AI** | OpenAI SDK (DeepSeek / OpenAI), Claude Code |
| **智能体运行时** | Claude Code, Codex CLI / stdio App Server |
| **数据处理** | Python (参考数据/分钟数据), SheetJS (Excel) |
| **验证** | Zod 4, Vitest |

---

## 🔍 故障排查

| 问题 | 解决 |
|---|---|
| 市场数据 404 | 3001 端口运行旧后端，重新运行 `start.bat` |
| 行情加载失败 | 点击「刷新行情」，检查后端是否运行 |
| 智能交易不可用 | 检查 `AI_STRATEGY_ENABLED=true` 和 API Key |
| Claude 智能体不可用 | 检查 `AGENT_ENABLED=true`，WSL 中 `claude` 已安装并登录 |
| Codex 智能体不可用 | 检查 `AGENT_CODEX_ENABLED`、项目 API Key、独立 `AGENT_CODEX_HOME`、Windows 工作目录和管理台 Provider 状态 |
| Codex 只能读取、不能修改文件 | 确认 `AGENT_CODEX_SANDBOX_MODE=workspace-write` 且 Windows 配置为 `AGENT_CODEX_WINDOWS_SANDBOX=unelevated` 或已初始化的 `elevated` |
| Codex 没有调用工具 | 检查模型目录的 `shell_type` 是否为 `shell_command`，以及 `AGENT_CODEX_TOOLS_ENABLED=true` |
| 智能体报告为空 | 报告为自动判断；若已明确要求报告，查看 `[Agent]` 日志并检查最终 `agent-report` 决策 |
| 机构研报为空 | 点击卡片右上角「刷新」，东财有频率控制 |

---

## 📚 文档与计划

- [项目总览与完整业务流程](./doc/PROJECT_OVERVIEW.md)
- [运维管理台指南](./doc/ADMIN_CONSOLE_GUIDE.md)
- [Codex Agent 运行与隔离配置](./docs/agent-codex-runtime.md)
- [Codex Harness 分阶段接入计划](./plan/CODEX_HARNESS_INTEGRATION_PLAN.md)
- 开发计划：[Phase 1](./doc/PHASE1_PLAN.md) · [Phase 2](./doc/PHASE2_PLAN.md) · [Phase 3](./doc/PHASE3_PLAN.md) · [Phase 3.5](./doc/PHASE3_5_PLAN.md) · [Phase 4](./doc/PHASE4_PLAN.md) · [Phase 5](./doc/PHASE5_PLAN.md) · [Phase 5.5](./doc/PHASE5_5_PLAN.md) · [Phase 6](./doc/PHASE6_PLAN.md)

---

## 🔒 数据与隐私

- 默认 API 模式：行情、策略、回测结果写入后端 MySQL
- IndexedDB 仅作为显式启用的只读迁移源
- 自选股、评分、筛选条件保存在浏览器 Local Storage
- AI 请求将公开行情、K 线、研报元数据发送到配置的模型服务
- API Key 仅由后端读取，不发送到浏览器
- Codex Harness 使用项目专用状态目录和 API Key，不复用全局 Codex/ChatGPT 登录
- Codex 的写权限限制在配置的项目工作区；常规命令、测试和只读行情查询无需逐步审批
- 外部行情技能仅在项目数据明确缺失时补缺，不自动写回权威数据源
- 暂不模拟停牌、涨跌停成交限制、融资融券和实盘交易
