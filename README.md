<div align="center">

# 📊 量化行情分析与策略回测系统

**A 股全流程量化投研一体化平台**

行情分析 · 缠论形态 · 选股评分 · 智能交易 · 策略回测 · 因子挖掘 · 盘感与模拟 · 万行智研 AI 智能体

[![React](https://img.shields.io/badge/React-19.2-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-8.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Ant Design](https://img.shields.io/badge/Ant_Design-6.4-1677FF?logo=ant-design&logoColor=white)](https://ant.design)
[![Fastify](https://img.shields.io/badge/Fastify-5.2-000000?logo=fastify&logoColor=white)](https://fastify.dev)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?logo=mysql&logoColor=white)](https://www.mysql.com)
[![DuckDB](https://img.shields.io/badge/DuckDB-1.5-FFF000?logo=duckdb&logoColor=black)](https://duckdb.org)
[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org)

<br/>

<div align="center">
  <video src="./Intro.mp4" width="880" controls muted loop></video>
</div>

</div>

> [!WARNING]
> **风险提示**：本项目用于量化投研学习与策略研究，**不构成任何投资建议或实盘操作依据**。公开行情接口可能受网络状态、上游服务限流或接口变动影响。

---

## 📋 目录

- [✨ 核心功能](#-核心功能)
- [🏗️ 技术架构](#️-技术架构)
- [🚀 快速开始](#-快速开始)
- [⚙️ 配置指南](#️-配置指南)
- [📖 使用流程](#-使用流程)
- [🔧 常用命令](#-常用命令)
- [📁 项目结构](#-项目结构)
- [🛠️ 技术栈](#️-技术栈)
- [🔍 故障排查](#-故障排查)
- [📚 文档与计划](#-文档与计划)
- [🔒 数据与安全](#-数据与安全)

---

## ✨ 核心功能

### 📈 行情与结构分析
- **多源数据呈现**：批量导入 `.xlsx` / `.xls` / `.csv` 本地行情，自动映射中英文表头；支持未复权、前复权（QFQ）、后复权（HFQ）日线数据无缝切换与全量导出。
- **专业 K 线图表**：基于 TradingView Lightweight Charts 5，提供日 K、周 K、月 K、季 K、年 K，叠加均线（MA5/10/20）与十字光标浮动指标。
- **18 种经典技术指标**：包含 SMA、EMA、BOLL、MACD、RSI、KDJ、ATR、CCI、WR、OBV、成交量均线等，参数可即时调整。
- **缠论形态分析 (chan-v1)**：顶底分型、笔、线段、笔中枢、段中枢的自动识别算法与独立图层叠加开关，严格遵循缠论几何结构规则。
- **筹码分布（筹码峰）**：日 K 主图右侧成本分布轮廓渲染，直观展现获利盘比例与密集筹码峰带。
- **画线与区间测算**：支持水平线、射线、趋势线等交互画线与持久化，搭配区间统计工具即时计算区间涨跌幅、振幅与换手率。
- **日 K 分时下钻与分钟湖**：支持从日 K 下钻查看当天的 1 分、5 分、15 分、30 分、60 分、120 分历史分钟 K 线（基于 DuckDB 本地分钟 Parquet 数据湖驱动）。

### 📊 市场数据与多维选股
- **5000+ A 股秒级检索**：支持代码、简称、拼音快速匹配，按需加载并管理自选股组合。
- **市场全局全景**：实时行情跟踪、市盈率（PE-TTM）、市净率（PB）、总市值、流通市值、换手率、量比、日内振幅、热门板块轮动排行。
- **指数成份股联动**：主要指数（如沪深300、中证500、中证1000等）成份股实时行情同步与权重展示。
- **五套独立选股评分**：价值投资型、成长型、逆向抄底型、趋势跟踪型、短线打板型五维自动化评分体系。
- **砂里淘金 (`/stock-selection`)**：结合基本面财务指标、技术形态、评分模型的多维度选股筛选工作台。
- **主力资金流向 (Fund Flow)**：超大单、大单、中单、小单资金流向历史监控与每日自动化盘后同步。

### 🤖 智能交易决策系统
- **8 种经典交易流派**：价值投资、成长赛道、周期投资、逆向抄底、传统指标、缠论结构、趋势跟踪、短线打板。
- **多策略冲突仲裁机制**：严格遵循 `系统风险否决 > 大盘环境 > 个股强弱 > 策略证据 > 消息催化` 仲裁序列。
- **多维信息融合**：自动整合个股实时快照、日/周/分钟 K 线、全市场概况、巨潮公告、分红派息与财经新闻，输出深度 Markdown 分析报告。

### 🧠 万行智研（AI 智能体系统）
- **三 Provider 灵活切换**：同时支持 **Claude Code**、**Codex CLI / stdio App Server** 以及 **Pi Coding Agent**（JSON 模式），按新对话自由选用。
- **本地数据优先路由与配方**：遵循“项目本地接口优先，缺失项按配方安全调取”的数据边界；提供 `researchData.mjs recipes`（如标的筛选、因子14天分层、PE定投估值分位回测等预置复用胶囊）。
- **标准中文科研绘图**：内置 Python 绘图工具（`researchPlot.py`，支持折线图、柱状图、热力图、净值回撤、因子分层收益等标准版式）。
- **结构化 HTML 报告**：根据研究任务复杂度与用户指令自动决策是否生成独立 HTML 研究报告，内嵌可视化科研图表，并受资金流向真实性守卫（Fund Flow Guard）保护。
- **交互与生命周期**：支持 SSE 实时事件流、断点续传、刷新恢复、整段对话清理（带 5 秒撤销倒计时）、失败任务一键重试、运行指标看板（`/agent-runs`）与历史报告归档（`/agent-reports`）。
- **丰富附件支持**：支持拖拽/剪贴板上传图片（原生多模态输入）、Word、PDF、Excel、CSV、Markdown，由本地 AnyDoc 引擎解析，保障数据隐私。

### 🎯 策略回测与因子研发
- **AI 策略工作室**：通过自然语言提示词生成策略 DSL，配备可视化低代码节点连线编辑器。
- **全流程回测引擎**：内置均线突破、RSI 超买超卖、MACD 背离、BOLL 轨道等策略；精确支持 `T 日出信号 → T+1 开盘价成交`，计入滑点、佣金与印花税。
- **因子投研工作流**：20+ 内置经典与量价因子，支持单因子分析与多因子线性/复合打分，提供 IC / Rank IC、ICIR、分层累计收益回测；规范化的“草稿 → 冻结 → 测试 → 审批 → 发布”因子治理工作流。
- **自动因子挖掘 (`/factor-mining`)**：面向特征工程与因子探索的自动化挖掘流水线。

### 🎮 盘感训练与模拟实盘
- **盘感训练系统 (`/market-sense-training`)**：随机或指定股票历史盲测，逐步步进推进 K 线，进行不带未来函数的模拟决策演练，统计复盘胜率与盈亏比，并在主行情图中标注训练区间。
- **模拟交易账户 (`/paper-trading`)**：模拟资金账户管理，支持限价/市价模拟下单撮合、持仓头寸监控、历史成交流水与账户净值曲线。

### 🛡️ 数据底座与运维管理台
- **双/多引擎存储架构**：IndexedDB（前端本地轻量缓存）+ MySQL 8（权威持久化）+ DuckDB / Parquet（OLAP 向量化高性能研究镜像）。
- **快照与数据湖维护**：日频研究快照定时构建（近 5 天滚动版本保留，有效快照受保护）；通达信盘后/TCP 实时补充分钟 Parquet 数据湖。
- **独立运维管理台（开发端口 5559，Linux Nginx 入口 8081）**：集中查看数据质量、新鲜度、运行状态，以及 Claude、Codex、Pi 三种 Provider 的环境与版本信息。
- **配置编辑与故障隔离**：普通字段回填现有值，保存后自动刷新列表；密钥保持为空并防止管理令牌误填。重启提示统一来自配置定义，单个模块读取失败不阻断其他模块。
- **状态探测与资源控制**：数据库连接动态探测；数据任务运行时每 10 秒、空闲时每 60 秒刷新，隐藏页面暂停，失败自动退避；后端合并重复采集并缓存高成本读取，失败任务统计使用已有索引。
- **备份与访问保护**：SQL 备份采用浏览器原生流式下载和一次性下载凭证，核验磁盘文件状态；默认最多保留 3 份、7 天内的完成备份，始终保留最新成功文件。管理 API 对连续鉴权失败限流。

2026-09-20 管理台改造已完成 Linux 部署：81 项专项回归、12 项线上接口检查通过，临时库真实备份恢复和 1 GiB 合成文件下载验证通过。生产全量恢复演练及页面 Basic 登录复测的边界见 [部署验收记录](doc/05-架构设计与规划/ADMIN_CONSOLE_DEPLOYMENT_20260920.md)。

---

## 🏗️ 技术架构

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             浏览器前端 (Browser Clients)                          │
│                                                                                  │
│   主工作台 (localhost:5558)                     运维管理台 (localhost:5559)       │
│   ├── React 19 + Ant Design 6                   ├── React 19 + Ant Design 6      │
│   ├── TradingView Lightweight Charts (K线/筹码) ├── 运行时健康检查 & Provider 切换 │
│   ├── 缠论几何计算图层 (chan-v1)                 ├── 调度进度自适应轮询监控       │
│   ├── IndexedDB (Dexie) 本地缓存                └── 数据库 SQL 备份与导出下载   │
│   ├── Zustand 5 状态引擎 + Web Worker 回测                                       │
│   └── SSE Client 智能体实时流                                                    │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         │ HTTP REST / SSE / WebSocket
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       Fastify 5 服务端 (localhost:3001)                          │
│                                                                                  │
│  [核心存储]                                                                      │
│  ├── MySQL 8 (Drizzle ORM) ─────────────── 证券主表、日线行情、资金流向、交易策略 │
│  └── DuckDB (OLAP 向量化引擎) ──────────── 日频研究快照、Parquet 分钟数据湖        │
│                                                                                  │
│  [外部数据源采集]                                                                │
│  ├── 腾讯财经 / 新浪财经 ───────────────── 实时行情、成份股、盘口数据             │
│  ├── 巨潮资讯 / 东方财富 ───────────────── 上市公司公告、机构研报、全市场新闻     │
│  ├── 通达信 (TDX TCP / 本地 LC1) ──────── 高性能历史分钟行情同步                │
│  └── Python 工具链 ─────────────────────── 指数成份、分红派息、申万行业、资金流向 │
│                                                                                  │
│  [智能体运行编排 (Agent Orchestrator)]                                           │
│  ├── Claude Code Provider ──────────────── Windows / Linux 原生 CLI 适配器       │
│  ├── Codex stdio App Server Provider ───── 独立工作区沙箱、会话续接、工具调用    │
│  ├── Pi Agent Provider ─────────────────── @earendil-works/pi-coding-agent (JSON)│
│  ├── 科研工具链 ────────────────────────── researchData.mjs (配方) + researchPlot│
│  └── 报告服务 ──────────────────────────── 自动版式判定、图表内嵌、HTML 渲染归档  │
│                                                                                  │
│  [调度与监控中心]                                                                │
│  └── Scheduler ─────────────────────────── 盘后同步、快照滚动裁剪、健康门禁检查 │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🚀 快速开始

### 环境准备

- **Node.js**：`^20.19.0` 或 `>=22.12.0`（建议 LTS 最新稳定版）
- **包管理器**：npm
- **MySQL 8.x**（API 持久化模式必须）
- **Python 3.11+**（可选，用于行业/分红/成份股维护及科研绘图）

### 端口约定

| 服务组件 | 默认端口 | 说明 |
|---|---|---|
| **前端主应用** | `5558` | 访问地址：`http://localhost:5558/` |
| **后端 API 服务** | `3001` | 访问地址：`http://localhost:3001/` |
| **独立运维管理台** | `5559` | 访问地址：`http://localhost:5559/` |

---

### 一键启动（Windows）

项目根目录双击运行 `start.bat`，脚本将自动：
1. 校验并检查 Node.js 环境与 Python/akshare 依赖；
2. 自动安装前后端缺失依赖；
3. 启动后端监护进程（3001 端口）；
4. 启动前端 Vite 服务（5558 端口）并自动在浏览器中打开主界面。

---

### 手动分步启动

> [!TIP]
> Linux 生产环境部署（包括 systemd 守护进程、Nginx 反向代理配置）请参阅 [Linux 部署说明](deploy/linux/README.md) 及 [验收记录](deploy/linux/ACCEPTANCE-2026-09-08.md)。

```bash
# 1. 克隆代码库并安装根目录及前端依赖
npm install

# 2. 安装服务端依赖
cd server && npm install && cd ..

# 3. 终端 1：启动后端服务 (localhost:3001)
cd server && npm run dev

# 4. 终端 2：启动前端应用 (localhost:5558)
npm run dev

# 5. 终端 3（可选）：启动运维管理台 (localhost:5559)
npm run admin:dev
```

- 主工作台：浏览器访问 `http://localhost:5558/`
- 智能体中心：浏览器访问 `http://localhost:5558/#/agent`
- 运维管理台：浏览器访问 `http://localhost:5559/`

---

## ⚙️ 配置指南

### 1. 前端配置 (`.env`)

```dotenv
VITE_DATA_SOURCE=api                      # 数据持久化模式: api / indexeddb
VITE_API_URL=http://localhost:3001        # 后端接口基地址
VITE_ALLOW_INDEXEDDB_MIGRATION=false
```

### 2. 后端基础配置 (`server/.env`)

首次启动请复制 `server/.env.example` 为 `server/.env` 并按需调整：

```dotenv
# MySQL 数据库配置
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-mysql-password
DB_NAME=quant_backtest

# 服务端口与安全
PORT=3001
HOST=0.0.0.0
ADMIN_API_TOKEN=your-admin-token          # 运维管理台安全令牌（为空则禁用 /api/admin/*）

# AI 策略生成与分析 (DeepSeek / OpenAI 等)
AI_STRATEGY_ENABLED=true
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=deepseek-chat;gpt-4o         # 英文分号分隔，首项为默认模型
```

### 3. 智能体系统配置（万行智研）

系统支持 **Claude Code**、**Codex** 和 **Pi** 三 Provider，可根据运行环境按需启用：

```dotenv
AGENT_ENABLED=true
AGENT_PROVIDER=claude                     # 新对话默认值: claude / codex / pi

# ────────────────── 1. Claude Code Provider (Windows / Linux 原生) ──────────────────
AGENT_CLAUDE_PATH=claude                  # 或指定绝对路径: C:/Users/<you>/.local/bin/claude.exe
AGENT_CLAUDE_WORKING_DIRECTORY=D:/github_public_repo/量化回测
AGENT_CLAUDE_GIT_BASH_PATH=C:/Program Files/Git/bin/bash.exe

# ────────────────── 2. Codex Provider (stdio App Server) ───────────────────────────
AGENT_CODEX_ENABLED=true
AGENT_CODEX_PATH=codex
AGENT_CODEX_WORKING_DIRECTORY=D:/github_public_repo/量化回测
AGENT_CODEX_HOME=C:/Users/<you>/AppData/Local/QuantBacktest/codex-home
AGENT_CODEX_API_KEY=your-project-key
AGENT_CODEX_APPROVALS_ENABLED=false
AGENT_CODEX_TOOLS_ENABLED=true
AGENT_CODEX_SANDBOX_MODE=workspace-write
AGENT_CODEX_WINDOWS_SANDBOX=unelevated
AGENT_CODEX_MARKET_DATA_CLI=D:/github_public_repo/量化回测/server/scripts/agentMarketData.mjs

# ────────────────── 3. Pi Provider (@earendil-works/pi-coding-agent) ─────────────────
AGENT_PI_ENABLED=false
AGENT_PI_PATH=/usr/local/bin/pi           # 须为可执行文件绝对路径
AGENT_PI_WORKING_DIRECTORY=/opt/quant-backtest
AGENT_PI_AGENT_DIRECTORY=/var/lib/quant-backtest/pi-agent # 专用配置与会话目录 (权限 0700/0600)
AGENT_PI_MODEL_PROVIDER=
AGENT_PI_MODEL=

# 运行时限与附件管理
AGENT_TIMEOUT_MINUTES=60
AGENT_MAX_CONCURRENT=1
AGENT_REPORT_ROOT=data/agent-reports
AGENT_ATTACHMENT_ROOT=tmp_output/.agent-attachments
AGENT_ATTACHMENT_MAX_FILE_MB=20
AGENT_ATTACHMENT_MAX_FILES=8
```

> [!NOTE]
> 详细配置与隔离运行说明见：
> - [Codex 运行时与隔离手册](./docs/agent-codex-runtime.md)
> - [Pi Agent 运行时配置说明](./docs/agent-pi-runtime.md)
> - [a-stock-data 技能拆分与按需加载](./docs/a-stock-data-skill-layout.md)
> - [智能体数据路由与配方说明](./docs/agent-data-routing.md)

### 4. 市场数据自动同步配置

```dotenv
MARKET_DATA_ENABLED=true
MARKET_DATA_PROVIDER=tencent
INSTRUMENT_SYNC_TIME=15:20               # 证券主表同步时间 (Asia/Shanghai)
MARKET_DATA_SYNC_TIME=15:30              # 日线盘后同步时间
FUND_FLOW_UPDATE_TIME=16:20              # 资金流向同步时间
SCHEDULE_SKIP_NON_TRADING_PERIODS=true   # 节假日与周末自动跳过定时任务
```

### 5. 管理台 SQL 备份保留策略

在 `server/.env` 中配置，重启后端后生效：

```dotenv
BACKUP_ROOT=./data/backups
ADMIN_BACKUP_RETAIN_COUNT=3             # 完成备份最多保留数量，正整数
ADMIN_BACKUP_RETAIN_DAYS=7              # 完成备份保留天数，正整数
```

每次成功导出后，清理 `BACKUP_ROOT/admin-database-exports` 中超出数量或天数的旧完成备份，始终保留最新成功文件；不会清理其他目录或正在写入的临时文件。下载授权有效期为 60 秒、仅可使用一次，过期后重新点击下载即可。

---

## 📖 使用流程

<details open>
<summary><b>1. 市场数据与深度行情分析</b></summary>

1. 进入「**市场数据**」页面，搜索目标股票并加入自选列表；
2. 点击股票进入「**行情分析**」工作台，支持切换日 K、周 K、月 K 或分钟线；
3. 点击顶部工具栏按钮打开「**指标**」配置各技术均线，或点击「**缠论**」开关启用顶底分型、笔中枢图层；
4. 点击「**筹码峰**」在右侧展示成本分布，使用画线工具绘制关键支撑阻力线；
5. 在日 K 主图选中特定交易日，可即时下钻展开当天的分时行情弹窗。
</details>

<details>
<summary><b>2. 砂里淘金与多维选股</b></summary>

1. 进入「**砂里淘金** (`/stock-selection`)」工作台；
2. 结合估值区间（PE / PB）、基本面指标、技术筛选（均线多头、MACD金叉等）设定复合条件；
3. 联动参考价值型、成长型、短线打板等五套独立选股评分结果；
4. 一键筛选符合标的并支持直接批量加入自选。
</details>

<details>
<summary><b>3. 盘感训练与模拟交易</b></summary>

1. 打开「**盘感训练** (`/market-sense-training`)」，选择股票盲测或指定时间段；
2. 隐藏后续真实行情，利用逐根 K 线步进推演，模拟买入/卖出/观望决策；
3. 训练结束即时展示胜率、最大回撤与交易明细复盘；
4. 打开「**模拟交易** (`/paper-trading`)」，在模拟资金账户中进行实盘模拟挂单，跟踪组合持仓盈亏。
</details>

<details>
<summary><b>4. 策略回测与因子研究</b></summary>

1. 打开「**策略回测** (`/backtest`)」，选用经典双均线、BOLL 突破或使用「**策略工作室**」DSL 生成的定制策略；
2. 设定标的、区间、手续费与滑点参数，启动 Web Worker 异步回测；
3. 在「**回测结果** (`/results`)」查看资金曲线、夏普比率、最大回撤与逐笔成交；
4. 进入「**因子研究** (`/factors`)」与「**自动因子挖掘** (`/factor-mining`)」进行单因子/多因子 IC 分析与特征进化。
</details>

<details>
<summary><b>5. 万行智研 AI 深度研报</b></summary>

1. 进入「**万行智研** (`/agent`)」，新建对话并选择 Claude、Codex 或 Pi Provider；
2. 通过输入框左侧回形针上传研究文档（研报 PDF、数据 Excel/CSV 或参考图片）；
3. 输入课题（如：*“分析某行业近期资金流向，并对某标的进行定投策略估值回测”*）；
4. 实时观察进度、工具调用与本地科研绘图过程；
5. 生成完毕后在线查阅结构化 HTML 研报，并在「**运行记录** (`/agent-runs`)」和「**研究报告** (`/agent-reports`)」中随时归档查阅。
</details>

<details>
<summary><b>6. 运维管理台日常监控</b></summary>

1. 启动并进入管理台界面（`http://localhost:5559/`）；
2. 验证 `ADMIN_API_TOKEN`；
3. 查看数据健康度门禁状态、快照版本与分钟湖覆盖率；
4. 在「配置与密钥」中修改配置，保存后确认列表新值，并根据提示决定是否重启后端；
5. 监控定时任务执行进度，必要时导出 SQL 备份；完成后点击下载，由浏览器直接保存文件。
</details>

---

## 🔧 常用命令

```bash
# ──────────────── 前端应用 ────────────────
npm run dev                      # 启动主前端开发服务器 (5558 端口)
npm run build                    # 生产环境编译构建
npm run preview                  # 预览生产构建结果
npm test                         # 运行前端 Vitest 单元测试

# ──────────────── 运维管理台 ──────────────
npm run admin:dev                # 启动独立运维管理台 (5559 端口)
npm run admin:build              # 构建管理台生产包
npm run admin:preview            # 预览管理台生产构建

# ──────────────── 后端服务与诊断 ──────────
cd server && npm run dev                # 启动后端开发服务器 (3001 端口)
cd server && npm run typecheck          # 后端 TypeScript 类型检查
cd server && npm run admin:diagnostics  # 后端服务与运行依赖全面诊断
cd server && npm run agent:claude:probe # Claude Code Provider 连通性探针
cd server && npm run agent:codex:probe  # Codex Provider 连通性与续接探针

# ──────────────── 科研数据与绘图工具 ──────
node server/scripts/researchData.mjs recipes # 查看内置可用研究配方胶囊
node server/scripts/agentMarketData.mjs catalog # 查看只读行情目录
python server/scripts/testResearchPlot.py     # 测试 Matplotlib 中文科研绘图

# ──────────────── 数据同步与因子引擎 ──────
cd server && npm run fund-flow:update   # 每日资金流向同步更新
cd server && npm run snapshot:build     # 手动构建 DuckDB 研究快照
cd server && npm run snapshot:freshness # 检查研究快照新鲜度与版本
cd server && npm run data:gate          # 执行数据健康门禁全面核验
cd server && npm run factor:list        # 列出所有已注册因子
cd server && npm run backup:create      # 创建系统与数据库归档备份
```

---

## 📁 项目结构

```
量化回测/
├── admin/                         # 独立运维管理台前端 (localhost:5559)
│   ├── vite.config.ts             # 管理台独立构建与代理配置
│   └── src/                       # 管理台视图、组件与状态
├── src/                           # 主工作台前端应用 (localhost:5558)
│   ├── api/                       # 后端 REST / SSE 接口客户端
│   ├── components/                # 通用 UI 组件（布局、导航、图层抽屉）
│   ├── features/
│   │   ├── chart/                 # TradingView K 线、筹码峰、画线与分时下钻
│   │   ├── chanlun/               # 缠论形态结构分析引擎 (chan-v1)
│   │   ├── marketData/            # 市场看板、热门板块、指标详情
│   │   ├── stockSelection/        # 砂里淘金多维选股系统
│   │   ├── marketSenseTraining/   # 盘感训练演练系统
│   │   ├── paperTrading/          # 模拟交易账户与持仓跟踪
│   │   ├── agent/                 # 万行智研 AI 智能体 (交互、流式、运行与报告)
│   │   ├── strategies/            # 策略协议、内置策略集
│   │   ├── strategyStudio/        # AI 策略工作室与可视化 DSL 编辑器
│   │   ├── backtest/              # 策略回测配置与引擎
│   │   ├── backtestResults/       # 回测结果看板与绩效归因
│   │   ├── factorResearch/        # 因子分析工作流与自动因子挖掘
│   │   └── dataLibrary/           # 本地导入数据集管理
│   ├── stores/                    # Zustand 全局状态管理
│   └── workers/                   # Web Worker 回测异步运行沙箱
├── server/                        # Fastify 后端服务 (localhost:3001)
│   ├── src/
│   │   ├── marketData/            # 数据源获取、质量监控、缓存与定时同步
│   │   ├── fundFlow/              # 资金流向同步、历史回补与调度 (Python)
│   │   ├── marketHealth/          # 市场大盘健康度与估值分位计算
│   │   ├── research/              # DuckDB OLAP 引擎、Parquet 快照查询
│   │   ├── minuteData/            # 分钟数据湖引擎 (TDX / 在线补充)
│   │   ├── referenceData/         # 指数成份、分红事件、行业分类工具 (Python)
│   │   ├── services/
│   │   │   ├── agent/             # 智能体编排器、提示词工程与报告生成
│   │   │   │   └── providers/     # Claude / Codex / Pi 驱动适配器
│   │   │   └── strategyGeneration/# AI 策略生成服务
│   │   ├── factorResearch/        # 因子计算引擎与候选生命周期
│   │   ├── admin/                 # 运维管理台后端 API
│   │   └── db/                    # MySQL Schema 定义与迁移
│   └── scripts/                   # 辅助 CLI 工具（探针、配方与中文绘图）
├── doc/                           # 项目设计文档、业务说明与操作手册
├── docs/                          # 核心技术文档（Codex / Pi 运行时、数据路由）
└── plan/                          # 分阶段开发演进计划文档
```

---

## 🛠️ 技术栈

| 层次 | 技术选型 | 说明 |
|---|---|---|
| **前端框架** | React 19.2 + TypeScript 7.0 + Vite 8.0 | 组件化与极速热更新 |
| **UI 组件库** | Ant Design 6.4 + @xyflow/react | 企业级界面与可视化节点连线流 |
| **K 线图表** | TradingView Lightweight Charts 5.2 | 高性能 Canvas 级专业金融图表 |
| **状态与存储** | Zustand 5.0 + Immer + Dexie 4.4 (IndexedDB) | 响应式状态管理与浏览器持久化 |
| **服务端框架** | Fastify 5.2 + TypeScript 7.0 + Node.js 22 | 高并发轻量异步服务端 |
| **数据持久化** | MySQL 8.0 (Drizzle ORM) | 规范化关系型主数据持久存储 |
| **高性能分析** | DuckDB 1.5 + Apache Parquet | 本地向量化 OLAP 查询与分钟湖 |
| **AI 模型集成** | OpenAI SDK (DeepSeek / OpenAI 规范) | 策略自然语言生成与流派决策 |
| **智能体运行时** | Claude Code / Codex CLI / Pi Coding Agent | 跨平台本地科研智能体多 Provider |
| **科研绘图工具** | Python 3.11+ / Matplotlib 3.11+ / AnyDoc | 中文规范科研绘图与本地文档转换 |
| **测试与质量** | Vitest 4.1 + Zod 4.4 | 类型验证、契约保护与单元测试 |

---

## 🔍 故障排查

| 常见问题 | 可能原因 | 解决办法 |
|---|---|---|
| **端口已被占用** | 历史遗留进程占用 `3001`、`5558` 或 `5559` | 执行 `start.bat` 会自动清理旧项目进程；或通过任务管理器结束对应 `node.exe`。 |
| **管理台提示 401 或 Token 无效** | 未配置或输错后台令牌 | 检查 `server/.env` 中的 `ADMIN_API_TOKEN`，在管理台登录页输入相同令牌；Linux 页面的 Basic 登录与管理 API 令牌是两层独立认证。 |
| **管理台提示 429** | 同一来源在 60 秒内累计 10 次鉴权失败 | 按 `Retry-After` 等待后使用正确令牌重试；反向代理后的客户端共享代理地址额度。 |
| **备份提示文件不可用** | 文件被外部删除或修改，或导出被中断 | 重新导出并等待完成；管理台会重新读取磁盘状态，不再使用永久内存状态。 |
| **数据库恢复后业务服务仍不可用** | 部分路由或调度器因启动时数据库离线而未注册 | 管理台会重新探测数据库；确认恢复后重启后端，以初始化业务服务。 |
| **Claude 智能体不可用** | 路径错误或未登录 Claude Code | 检查 `AGENT_ENABLED=true`、`AGENT_CLAUDE_PATH` 配置，终端运行 `claude auth status` 确认登录有效。 |
| **Codex 智能体不可用** | 项目 Key 或沙箱配置不符 | 确认配置了专用的 `AGENT_CODEX_HOME` 与项目 `AGENT_CODEX_API_KEY`，且沙箱设为 `unelevated`。 |
| **Pi 智能体不可用** | 路径未配置为绝对路径或目录权限有误 | 确认 `AGENT_PI_ENABLED=true`，`AGENT_PI_PATH` 指向可执行文件绝对路径，`AGENT_PI_AGENT_DIRECTORY` 目录属主与权限符合规范。 |
| **智能体报告为空** | 研究复杂度未触发报告或执行未决 | 报告为智能体按题意自主判定生成；若已明确要求生成报告，检查运行日志确认输出决策。 |
| **分钟行情提示不可用** | 尚未构建对应日期的分钟 Parquet 镜像 | 确认已下载通达信 1 分钟数据并运行 `npm run minute:tdx:import` 或在线更新脚本补充。 |

---

## 📚 文档与计划

### 核心文档与运行指南
- [项目总览与完整业务流程](./doc/05-架构设计与规划/PROJECT_OVERVIEW.md)
- [运维管理台使用指南](./doc/03-运维监控/ADMIN_CONSOLE_GUIDE.md)
- [管理台技术债治理与配置说明](./doc/05-架构设计与规划/ADMIN_CONSOLE_HARDENING_20260920.md)
- [管理台部署验收记录（2026-09-20）](./doc/05-架构设计与规划/ADMIN_CONSOLE_DEPLOYMENT_20260920.md)
- [Codex Agent 运行时与隔离配置](./docs/agent-codex-runtime.md)
- [Pi Agent 运行时与配置指南](./docs/agent-pi-runtime.md)
- [智能体数据路由与复用配方说明](./docs/agent-data-routing.md)
- [本地 DuckDB 因子研究与 SQL 指南](./doc/02-因子研究与查询/LOCAL_DUCKDB_CLI_GUIDE.md)
- [缠论 v1 形态规则与计算原理](./doc/05-架构设计与规划/CHANLUN_V1_RULES.md)
- [多风格选股评分标准体系](./doc/多风格选股评分标准.md)

### 研发演化计划
- **系统计划**：[Phase 1](./plan/PHASE1_PLAN.md) · [Phase 2](./plan/PHASE2_PLAN.md) · [Phase 3](./plan/PHASE3_PLAN.md) · [Phase 3.5](./plan/PHASE3_5_PLAN.md) · [Phase 4](./plan/PHASE4_PLAN.md) · [Phase 4.5](./plan/PHASE4_5_PLAN.md) · [Phase 5](./plan/PHASE5_PLAN.md) · [Phase 5.5](./plan/PHASE5_5_PLAN.md) · [Phase 6](./plan/PHASE6_PLAN.md) · [Phase 6.5 自动因子挖掘](./plan/PHASE6_5_AUTOMATED_FACTOR_MINING_PLAN.md)
- **智能体接入**：[Codex Harness 分阶段接入计划](./plan/CODEX_HARNESS_INTEGRATION_PLAN.md)

---

## 🔒 数据与安全

1. **权威数据保护**：默认 API 模式下，全部基础行情与交易回测持久化至本地 MySQL 与 DuckDB，IndexedDB 仅用于前端轻量级只读缓存。
2. **凭据安全隔离**：后端不向浏览器返回业务密钥明文；管理令牌由用户在登录页输入，随 Bearer 请求发送。备份下载使用短时、一次性凭证，管理令牌不进入下载 URL；Codex 与 Pi 使用各自的专属配置目录。
3. **工作区边界保护**：智能体写权限受限于预设的项目工作区，常规命令与只读取数不进行逐步审批以保障研究流程度，但严禁向外网泄露敏感数据库配置。
4. **外部技能只读补缺**：外部行情与资讯抓取仅作为项目本地数据的后备补充，绝不直接反向污染系统权威持久化库。
5. **合规提示**：系统内模拟交易及回测模型暂不包含涨跌停不可成交、盘中临时停牌、转融通及滑点极端恶化的所有实盘摩擦，实盘运用请遵循证券监管法规。
