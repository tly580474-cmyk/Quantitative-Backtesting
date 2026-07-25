# 量化行情分析与策略回测

面向 A 股研究的浏览器端行情分析、数据管理、选股研究、智能交易分析、策略构建与回测应用。项目支持 Excel 行情导入、全市场自选股、实时行情、热门板块、技术选股、K 线与技术指标、机构研报、多流派 AI 交易分析、可视化策略、回测撮合和绩效分析。

> 本项目用于研究和学习，不构成投资建议。公开行情接口可能受网络状态、上游限流或接口调整影响。

## 主要功能

### 行情分析

- 批量导入 `.xlsx`、`.xls` 或 `.csv` 日频行情文件；
- 自动映射中英文表头，校验日期、重复记录和 OHLC 数据；
- 展示 K 线、成交量、十字光标和区间涨跌；
- 支持 SMA、EMA、BOLL、MACD、RSI、KDJ、ATR、CCI、WR、OBV 和成交量均线；
- 技术指标支持添加、隐藏、删除和参数调整。

### 数据管理

- 将导入行情保存到 IndexedDB 或 MySQL；
- 按名称、代码查询并打开数据集；
- 通过校验和识别重复导入；
- 支持数据迁移、导出及质量检查。

### 市场数据

- 按股票代码、简称或拼音搜索 5000+ A 股；
- 使用自选股模式按需展示标的，不预加载全市场列表；
- 展示实时价格、涨跌幅、开高低收、涨跌停、换手率、振幅、量比和成交额；
- 展示 PE(TTM)、静态 PE、PB、总市值、流通市值、上市日期和所属行业；
- 支持日 K、周 K、年 K 和前复权价格；
- K 线叠加 MA5、MA10、MA20，并计算 RSI14、MACD；
- 鼠标悬停时在图表右上角显示固定的半透明数据卡，包括 OHLC、涨跌、成交量和技术指标；
- 根据趋势、动量、量价、形态、波动和风控项计算单股技术评分，评分明细按需展开；
- 对自选股批量评分和排名，支持置顶、快速加入/取消自选；
- 使用涨跌幅、成交额、换手率、量比和振幅完成全市场量价初筛；
- 对候选股进一步计算 MA5/10/20/60、5/10/20 日涨跌幅、连续涨跌、RSI14、KDJ 和 MACD 金叉/死叉；
- 展示行业与概念“当日热门板块”，综合板块涨幅、主力资金、上涨广度、活跃度和热度持续性排名；
- “市场概况”“当日热门板块”“自选评分”和“市场技术筛选”默认折叠，展开后按需加载；
- 机构研报支持分页、PDF 查看及独立刷新，刷新失败不会清空已有结果；
- 自选和详情页面中的智能交易系统独占整行展示，不与机构研报并排，避免 Markdown 表格被压缩；
- 自选股、置顶状态、评分、筛选条件、筛选结果和热门板块快照会持久化或缓存；
- 页面支持桌面、平板和手机窗口，并提供独立纵向滚动区域。

市场数据来源：

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 实时行情、估值 | 腾讯财经 | GBK 行情接口，按需请求 |
| 日/周/月线 | 腾讯财经 | 年 K 由长期月线聚合 |
| 分红历史、股息率 | 本地研究快照 | 读取已发布的分红事件，按近 12 个月已实施现金分红计算股息率 |
| 市场消息 | 本地消息库 | 智能交易分析读取近 72 小时已入库消息，不为单次分析主动刷新东财 |
| 个股公告 | 巨潮资讯、本地消息库 | 优先读取官方公告；无近期公告时静默跳过 |
| 行业、上市日期 | 腾讯行情及可选补充源 | 补充源失败不影响核心行情 |
| 行业/概念板块、板块资金 | 本地缓存及可选补充源 | 交互分析优先使用最近有效快照 |
| 个股研报、PDF | 可选补充源 | 独立刷新，失败不会阻断智能交易分析 |

运行智能交易分析时遵循“腾讯行情和本地快照优先、官方公告其次、外部聚合接口仅作可失败补充”的原则。东方财富相关接口不作为核心链路的单点依赖；其返回失败时保留已有缓存或将对应证据标记为缺失。

### 智能交易系统

- 复用策略工作室配置的 OpenAI 兼容模型、地址和密钥；
- 支持同时选择 1–3 种交易流派，并按风险偏好从稳健到激进排列：
  - 价值投资派；
  - 成长赛道流；
  - 周期投资派；
  - 逆向抄底流；
  - 传统指标派；
  - 缠论结构派；
  - 趋势跟踪派；
  - 短线打板流；
- 自动整合腾讯实时行情、日 K、周 K、全市场快照、本地消息、官方公告、分红历史及按流派加载的扩展证据；
- 分析大盘指数、涨跌广度、成交额、市场情绪、主力资金和热点板块，判断风险偏好扩张、震荡分化或风险收缩；
- 所有流派都必须比较个股与中证全指、中证 A500、沪深 300 等核心宽基的表现，并结合市场广度，将个股定位为“逆势强、顺势强、市场同步、相对弱”或“待确认”；
- 价值投资派强制展示股息率，并同时检查 PE/PB、ROE、盈利质量、现金流、分红持续性与派息覆盖能力；股息率缺失时明确标记“待补充”，不得省略或编造；
- 个股近期没有新闻或公告时直接省略相关内容，不输出无信息价值的缺失提示；
- 每种流派独立给出适配度、大盘博弈定位、支持证据、反对证据、触发条件和失效条件；
- 最终只输出观察、等待确认、风险回避或带前置条件的候选方案，不输出无条件买卖指令；
- 报告使用 Markdown 渲染，支持标题、列表、表格、引用和代码样式；
- 运行时展开分析过程摘要，完成后自动折叠；
- 过程摘要只展示可审计的取数和分析步骤，不展示模型隐藏思维链；
- 已生成的报告会在页面切换后保留。

#### 多策略冲突裁决

系统保留不同流派的独立观点，但不允许将互相矛盾的买卖指令并列交给用户。统一裁决顺序为：

```text
风险否决 > 大盘环境 > 个股相对强弱 > 用户主策略 > 辅助策略 > 消息催化
```

- 首先执行统一市场风险闸门。大盘风险收缩时，趋势追涨、打板等进攻型流派自动降低权重和仓位上限；
- 按时间周期隔离结论。价值、成长和周期偏中长期，传统技术、趋势和缠论偏短中期，打板属于超短期；“长期有价值、短期未止跌”属于周期差异，不直接视为互相否定；
- 财务异常、流动性不足、个股持续弱于大盘或价格触发失效条件时，风险层拥有一票否决权；
- 各流派使用统一维度比较：大盘环境适配、个股相对强弱、流派自身证据、基本面/消息验证和风险收益比；
- 多个流派形成共识只能提高证据置信度，不能突破统一仓位上限；
- 最终执行层只能生成一个状态：风险回避、继续观察、等待确认、小仓试错、条件满足后分批参与，或持有并执行退出纪律；
- 报告必须说明主导流派、被否决流派、冲突来自时间周期还是证据口径，以及最终裁决原因。

### 策略工作室

- 使用自然语言生成策略 DSL；
- 支持模型选择、策略修改、解释和结构校验；
- 支持可视化策略节点编辑、校验、编译及信号预览；
- 支持成交量/量比、前期高低点突破和滚动回撤指标，并可由 AI 生成对应规则；
- AI 输出仅作为策略草稿，需经过预览和回测确认。

### 策略回测

内置策略：

- 双均线交叉；
- RSI 超买超卖；
- MACD 金叉死叉；
- BOLL 布林带回归。

回测能力：

- 初始资金、全仓买卖，以及按剩余资金/当前持仓百分比逐步加减仓；
- 手续费、最低手续费、卖出印花税和滑点；
- 收盘后生成信号，下一交易日开盘成交；
- 期末强制平仓；
- 买卖信号、成交记录和权益曲线；
- 累计收益、年化收益、夏普比率、最大回撤、胜率和盈亏比；
- 历史结果保存及多组结果对比。

## 技术架构

```text
浏览器
├── React + Ant Design 界面
├── Lightweight Charts 图表
├── IndexedDB 本地数据
├── Zustand 页面/业务状态
└── Web Worker 回测引擎
        │
        ▼
Fastify 服务（localhost:3001）
├── MySQL 持久化（可选）
├── 腾讯行情、巨潮公告与可选补充数据适配
├── 本地研究快照、市场消息库与分红事件
├── 市场快照、热门板块与技术指标缓存
├── 市场数据限流、重试和数据源降级
└── OpenAI 兼容 AI Provider
```

普通 Excel 导入和本地回测可以只使用浏览器。市场数据、MySQL 持久化和 AI 功能需要启动后端服务。

## 环境要求

- Node.js `^20.19.0` 或 `>=22.12.0`；
- npm；
- 支持 IndexedDB、Web Worker 和现代 CSS 的浏览器；
- MySQL 8.x（仅 API 持久化模式需要）。

## 快速开始

### Windows 一键启动

双击：

```text
start.bat
```

脚本会：

1. 安装缺失的前后端依赖；
2. 检查 3001 端口上的后端版本；
3. 自动替换缺少当前市场数据路由的旧后端进程；
4. 启动后端 `http://localhost:3001`；
5. 启动前端并打开 `http://localhost:5173`。

### 手动启动

安装前端依赖：

```bash
npm install
```

安装后端依赖：

```bash
cd server
npm install
cd ..
```

分别启动两个终端：

```bash
# 终端 1：后端
cd server
npm run dev

# 终端 2：前端
npm run dev
```

访问 `http://localhost:5173/`。

## 配置

### 前端配置

复制 `.env.example` 为 `.env`：

```dotenv
# api：后端/MySQL，是唯一权威可写数据源
VITE_DATA_SOURCE=api
VITE_API_URL=http://localhost:3001
VITE_ALLOW_INDEXEDDB_MIGRATION=false
```

旧版本浏览器数据需要迁移时，可临时同时设置
`VITE_DATA_SOURCE=indexeddb` 和 `VITE_ALLOW_INDEXEDDB_MIGRATION=true`。该模式只允许读取和
导出，禁止新增、修改和删除；导出的 Excel 首张“迁移清单”记录各表行数、日期范围、
记录 ID 样本和确定性 checksum。完成迁移后必须恢复 API 模式。

### 后端与 AI 配置

复制 `server/.env.example` 为 `server/.env`：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=quant_backtest

AI_STRATEGY_ENABLED=true
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=deepseek-v4-flash
OPENAI_TIMEOUT_MS=60000

PORT=3001
```

`OPENAI_BASE_URL` 支持 OpenAI、DeepSeek 及其他兼容 Chat Completions 的服务。密钥仅保存在后端环境变量中，不发送到浏览器。

需要自动更新 MySQL 全量历史库时，可在 `server/.env` 中启用：

```dotenv
MARKET_DATA_ENABLED=true
MARKET_DATA_PROVIDER=tencent
MARKET_DATA_SYNC_TIME=15:30
MARKET_DATA_INTRADAY_INTERVAL_MINUTES=30
MARKET_INDEX_AUTO_UPDATE_ENABLED=true
MARKET_CN_INDEX_UPDATE_TIME=20:00
MARKET_US_INDEX_UPDATE_TIME=05:00
```

服务会在 A 股盘后 15:30 统一更新并定稿个股日线，盘中不会写入当天个股日线。
增量任务只处理状态为 `active` 的股票，不请求已退市证券；腾讯批量行情负责当日更新，缺失
多个交易日时再按证券补拉 K 线。

所有调度时间均按 `Asia/Shanghai` 解释。服务在 15:30 之后启动时会补偿执行当天
尚未完成的任务，成功后当天不重复；失败任务按分钟重试。交易日历缺失时，服务
会先从腾讯指数日线确认沪、深、北三市是否开市。

业务前端默认运行在 `http://127.0.0.1:5558`，运维管理台运行在
`http://127.0.0.1:5559`。注册 Windows 登录后会同时启动后端、业务前端和
运维管理台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-startup.ps1
```

后台日志分别写入 `logs/backend.log`、`logs/frontend.log` 和
`logs/admin.log`。启动脚本是幂等的，服务已经运行时不会创建重复进程。

当交易所昨收价与数据库上一交易日收盘价不一致时，系统将该证券标记为疑似除权
除息，只为该证券拉取近期前复权数据并重新校验压缩因子。校验通过后按证券原子
发布新因子版本，不复权日线不会被改写。

## 使用流程

### 使用公开市场数据

1. 启动前端和后端；
2. 打开“市场数据”；
3. 搜索股票代码、简称或拼音并加入自选；
4. 展开“市场概况”查看全市场情绪与涨跌分布；
5. 展开“当日热门板块”，查看行业/概念热度、主力资金、上涨广度和领涨股；
6. 展开“自选评分”，查看自选股排名、置顶关注标的；
7. 展开“市场技术筛选”，设置实时量价和日 K 技术条件，将结果加入或移出自选；
8. 查看个股实时指标，切换日 K、周 K 或年 K，并展开评分“详细数据”查看评分依据；
9. 在“机构研报”中查看 PDF，网络失败时点击该卡片右上角“刷新”；
10. 在智能交易系统中选择 1–3 种交易流派，输入关注问题并运行分析；
11. 先检查全市场环境和个股相对强弱，再查看各流派结论及最终冲突裁决；
12. 价值投资派需确认报告已展示股息率、分红质量及相关数据缺口。

### 导入数据并回测

1. 点击“导入 Excel”，选择本地日频行情文件；
2. 检查导入结果和异常警告；
3. 保存数据集并在“数据管理”中打开；
4. 进入“策略回测”，选择策略并设置参数；
5. 设置资金、费用和滑点；
6. 运行回测，在“回测结果”中查看绩效和交易明细。

## Excel 数据格式

当前面向单工作表、单标的、日频行情。必填字段：

| 字段 | 说明 |
| --- | --- |
| 日期 | 支持常见日期文本和 `YYYYMMDD` |
| 标的代码 | 按字符串处理，保留前导零 |
| Open | 开盘价 |
| High | 最高价 |
| Low | 最低价 |
| Close | 收盘价 |

可选字段包括涨跌、涨跌幅、成交量、成交金额和样本数量。导入器兼容中英文混合表头。

## 回测规则

- 第 `T` 根 K 线只允许使用第 `T` 根及以前的数据；
- 第 `T` 日收盘后生成信号，第 `T+1` 个交易日开盘撮合；
- 买入金额按仓位比例计算，并按最小交易金额向下取整；
- 买入成交价加入正向滑点，卖出成交价扣除滑点；
- 买入收取手续费，卖出收取手续费和印花税；
- 当前版本以日频、单标的、只做多回测为主。

## 常用命令

```bash
# 前端开发服务器
npm run dev

# 前端生产构建与类型检查
npm run build

# 前端测试
npm test
npm run test:watch

# 后端开发服务器
cd server && npm run dev

# 后端类型检查
cd server && npm run typecheck

# 5.5/第六阶段数据底座：确认研究快照已追平 MySQL
cd server && npm run snapshot:freshness
cd server && npm run backup:verify -- --path ./data/backups/<backup-id>
cd server && npm run backup:restore-check -- --path ./data/backups/<backup-id> --database quant_backtest_restore_check --confirm-drop quant_backtest_restore_check --cleanup true

# 历史行情只读预检（路径也可配置为 STOCK_HISTORY_ROOT）
cd server && npm run import:history -- --source "D:\github_public_repo\所有股票的历史数据\每只股票一个文件" --limit 10 --dry-run

# 第六阶段：查看内置因子并运行单因子研究报告
cd server && npm run factor:list
cd server && npm run factor:run -- --factor momentum_20 --start 2026-05-01 --end 2026-06-30 --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --validationStart 2026-06-11 --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --validationStart 2026-06-11 --weighting ic --horizon 5 --layers 5
cd server && npm run factor:composite -- --factors momentum_20,reversal_5 --start 2026-06-01 --end 2026-06-20 --weighting manual --weights momentum_20:2,reversal_5:-1 --horizon 5 --layers 5

# 预览生产构建
npm run preview
```

## 项目结构

```text
src/
  api/                       前端 API 与 Repository
  components/                通用页面组件
  db/                        IndexedDB 数据库
  features/
    import/                  Excel 解析与行情校验
    chart/                   行情分析图表
    indicators/              技术指标计算
    marketData/              自选评分、技术筛选、热门板块、实时行情、K线、研报和 Agent
    dataLibrary/             数据集管理
    strategies/              策略协议及内置策略
    visualStrategies/        可视化策略编辑与编译
    strategyStudio/          AI 策略工作室
    backtest/                撮合、账户和回测引擎
    backtestResults/         回测报告和结果对比
  models/                    TypeScript 业务模型
  stores/                    Zustand 状态管理
  workers/                   Web Worker 回测入口

server/src/
  marketData/                数据源、热门板块、技术筛选、标准化、缓存、同步和质量检查
  routes/                    Fastify API 路由
  services/                  AI 策略与股票调研服务
  db/                        MySQL Schema 和迁移
```

## 技术栈

- React 19、TypeScript、Vite；
- Ant Design；
- TradingView Lightweight Charts；
- React Markdown / remark-gfm；
- Zustand、Dexie / IndexedDB；
- Fastify、Drizzle ORM、MySQL；
- OpenAI 兼容 SDK；
- SheetJS、Zod、Vitest。

## 故障排查

### 市场数据接口返回 404

通常是 3001 端口上仍运行着旧后端。重新运行 `start.bat`，脚本会检查 `/api/market-data/research-agent/status` 并替换旧进程。

### 行情或 K 线首次加载失败

- 点击行情卡片的“刷新行情”；
- 检查后端是否运行在 `localhost:3001`；
- 腾讯接口偶发网络抖动时稍后重试。

### 热门板块或市场技术筛选加载失败

- 热门板块和全市场快照依赖公开行情接口，上游超时后会继续展示最近一次成功快照；
- 首次市场技术筛选会先读取全市场快照，再并发分析候选股日 K，后续筛选会复用缓存；
- 可点击对应折叠面板中的“刷新”或“开始筛选”重试；
- 检查后端是否运行在 `localhost:3001`。

### 机构研报为空

- 点击“机构研报”卡片右上角“刷新”；
- 东方财富存在频率控制，系统会串行请求并保留上次成功数据；
- 避免短时间对大量股票连续刷新。
- 机构研报属于补充证据，即使为空也不会阻断智能交易分析。

### 智能交易系统不可用

- 检查 `server/.env` 中 `AI_STRATEGY_ENABLED=true`；
- 检查 API Key、Base URL 和模型名称；
- 模型调用可能超过 30 秒，智能交易接口使用更长的前端超时；
- 价值投资派没有显示股息率时，检查是否已经发布包含 `dividend_events` 的本地研究快照；
- 外部补充源异常时，系统会继续使用腾讯行情、本地快照、本地消息和官方公告；报告中的对应指标会标记为待补充。

## 相关文档

- [项目总览与完整业务流程](./doc/PROJECT_OVERVIEW.md)
- [独立运维管理台](./doc/ADMIN_CONSOLE_GUIDE.md)
- [一期开发计划](./doc/PHASE1_PLAN.md)
- [二期回测开发计划](./doc/PHASE2_PLAN.md)
- [三期可视化策略与 AI 生成开发计划](./doc/PHASE3_PLAN.md)
- [3.5 阶段目标与验收](./doc/PHASE3_5_PLAN.md)
- [第四阶段参数研究与策略稳健性分析计划](./doc/PHASE4_PLAN.md)
- [第五阶段市场数据平台计划](./doc/PHASE5_PLAN.md)
- [5.5 阶段全量历史行情库与高性能研究底座](./doc/PHASE5_5_PLAN.md)
- [第六阶段因子研究与多因子评价平台](./doc/PHASE6_PLAN.md)

## 数据与隐私说明

- 默认 API 模式下，导入行情、策略和回测结果统一写入后端 MySQL；
- IndexedDB 仅保留为显式启用的只读历史迁移源，不会在 MySQL 不可用时自动降级写入；
- 自选股、置顶状态、评分结果、市场筛选条件/结果和热门板块快照保存在浏览器 Local Storage；
- 服务端会在 `server/.cache/` 保存市场快照和热门板块缓存，刷新失败时可继续使用最近一次成功数据；
- AI 请求会将当前股票的公开行情、K线、研报元数据和用户问题发送到配置的模型服务；
- API Key 仅由后端读取；
- 清理浏览器缓存可能删除本地数据；
- 暂不模拟停牌、涨跌停成交限制、成交量限制、融资融券和实盘交易。
