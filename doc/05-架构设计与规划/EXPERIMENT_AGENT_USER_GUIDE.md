# 实验 Agent 使用手册

> 版本：M0–M4 v1
> 更新日期：2026-08-01
> 面向对象：策略研究人员、开发人员、测试与运维人员

## 1. Agent 能做什么

实验 Agent 将自然语言策略转换为受约束、可审计的研究流程，而不是直接生成并执行任意
Python 代码。当前产品提供两条路径：

1. **单标的实验（M0–M3）**：自然语言 → Strategy DSL → 三栏人工确认 → 不可变实验版本
   → 现有权威回测引擎 → 稳健性门禁与报告；
2. **多资产研究（M4 v1）**：冻结沪深 300 只读快照 → DuckDB/Python 生成调仓计划 →
   TypeScript 权威撮合 → 逐日资金账本与可复核制品。

Agent 只生成研究草稿、候选和解释，不会自动发布策略、提交模拟委托或连接真实资金。

## 2. 当前能力边界

| 能力 | 当前状态 |
| --- | --- |
| A 股单标的、日线、只做多 | 支持 |
| 收盘信号、下一交易日开盘成交 | 支持，固定口径 |
| 技术指标、参数、买卖条件和固定风控 | 支持，以能力接口返回值为准 |
| Schema 确定性修复及修复审计 | 支持；不会补写交易意图 |
| 训练/验证/锁定测试、Walk-forward、扰动检验 | 支持 |
| Markdown 报告、按需 HTML | 支持 |
| PDF 报告 | 支持；由独立 Chromium Worker 按需异步生成 |
| 沪深 300 多资产动量研究 | 支持 M4 v1 |
| 周频/月频，等权/评分加权 | 支持 M4 v1 |
| 已发布 `momentum_20` 因子治理绑定 | 支持 M4 v1 |
| 中证 500、全 A 股、任意多因子 | 尚不支持 |
| 任意 Python/VectorBT 代码执行 | 尚不支持，计划属于 M5 |
| 实盘自动发布或下单 | 禁止 |

## 3. 启动前准备

### 3.1 必要依赖

- Node.js 与 npm；
- MySQL，数据库配置见 `server/.env`；
- Python，供固定多资产计算 Worker 使用；
- 已发布研究快照，默认目录为 `server/data/research-snapshots`；
- 如需真实自然语言解析，需要 OpenAI 兼容接口的模型与密钥。
- 如需 PDF，需要本机 Chrome、Edge 或 Chromium，并启动独立报告 Worker。

### 3.2 服务端配置

复制 `server/.env.example` 为 `server/.env`，至少确认：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=quant_backtest

AI_STRATEGY_ENABLED=true
OPENAI_API_KEY=your-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=deepseek-v4-flash

RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
FACTOR_MINER_PYTHON=python
```

不配置模型时，界面会明确显示 Mock 演示模式。Mock 只能用于界面演示，不能作为自然语言
解析质量验收证据。

### 3.3 启动命令

首次启动或数据库结构更新后：

```powershell
cd server
npm install
npm run db:migrate
npm run dev
```

另开一个服务端终端启动 M3 报告 Worker：

```powershell
cd server
npm run experiment:report-worker
```

另开终端启动前端：

```powershell
npm install
npm run dev
```

默认服务端为 `http://127.0.0.1:3001`。可通过以下接口检查状态：

```text
GET /api/health
GET /api/ai/status
GET /api/ai/strategy-capabilities
```

能力清单来自实际指标注册表、Schema 和数据库已发布因子版本，不应在提示词或文档中手工
复制成第二份可执行清单。

## 4. 使用单标的实验 Agent

### 4.1 进入生成界面

1. 从左侧进入“策略工作室”；
2. 点击右上角“更多”；
3. 选择“AI 生成策略”；
4. 选择“新建策略”或“改动现有策略”。

建议描述明确包含指标、买入、卖出和风控。例如：

```text
当 5 日均线上穿 20 日均线时买入；当 5 日均线下穿 20 日均线时卖出；
止损 5%，止盈 15%。使用日线，信号次日开盘成交。
```

“挑点强势股”这类缺少股票池、强势定义和退出规则的输入不应被系统擅自补齐。遇到缺失
字段时，应修改原始描述后重新提交。

### 4.2 审阅三栏确认

模型输出通过 Schema 后，界面显示：

- **原始描述**：保存用户的原文；
- **结构化抽取**：策略名称、指标、买入、卖出与风控；
- **显式假设**：单标的、日线、T+1 成交、交易成本来源和回测区间来源。

逐项勾选显式假设后，“冻结实验并导入编辑器”才会启用。显式假设不由 Repair
Middleware 写回交易规则。

### 4.3 理解 Schema Repair

允许的修复仅包括不改变业务语义的确定性转换，例如数字字符串转数字、固定输出类型补全
和系统元数据写入。系统会保存修复前后 hash、字段路径、操作类型、前后值以及校验结果。

以下行为不会自动执行：

- 猜测缺失的买卖条件；
- 把未知指标替换为相似指标；
- 改写合法参数以强行通过校验；
- 删除未知内容后继续运行；
- 根据运行报错让模型黑盒修改策略。

无法修复时接口返回 422 和固定字段路径，用户需要修改自然语言后重新提交。

### 4.4 冻结与回测

确认完成后：

1. 点击“冻结实验并导入编辑器”；
2. 检查策略画布和参数；
3. 手动保存策略；
4. 进入“策略回测”，选择带实验标识的策略；
5. 配置标的、资金、手续费、印花税、滑点和数据区间；
6. 运行回测。

实验版本不可变。系统冻结策略、快照、参数、交易成本和引擎版本，并使用幂等键避免重复
运行。Agent 路径复用现有 `compileAndValidate()` 与 `runBacktestAsync()`，不引入第二套
单标的撮合器。

### 4.5 M3 验证门禁

基础回测完成后，系统生成训练、验证和锁定测试计划，并执行：

- 未来字段和正向 offset 扫描；
- 收盘信号不得同 bar 成交检查；
- purge/embargo 样本隔离；
- Walk-forward；
- 参数 ±5%/±10% 扰动；
- 成本 2/3 倍、日期移动和额外成交延迟。

锁定测试只能打开一次。打开前需要二次确认；服务端通过数据库状态转换和唯一 token 保证
原子性。打开后不能在同一实验版本继续调参。

报告中的数值以结构化 JSON 为权威来源，并记录 `sourcePath` 和
`calculatorVersion`。Markdown 可直接预览，HTML/PDF 按需进入独立低优先级队列。进入
“回测结果 → 实验报告中心”可集中查看历史报告、Worker 状态、排队/失败状态，生成或重试
制品并下载。HTML 默认保留 7 天，PDF 默认保留 30 天；过期制品可由长期保存的结构化
报告重建。

## 5. 使用多资产研究 Agent（M4 v1 + E1–E7 扩展）

### 5.1 创建冻结计划

1. 从左侧进入“多资产研究”；
2. 点击“新建研究计划”；
3. 选择沪深 300、中证 500 或全 A，设置回测区间、周/月调仓、Top N、权重、仓位上限和最低现金；
4. 选择单因子、多因子或公告日基本面模型，并设置标准化与因子权重；
5. 可选启用确定性组合优化、最大换手、单标的非零下限和 SW2021 行业中性；行业绝对
   上下限使用小数 JSON，例如 `{"801010":{"min":0.05,"max":0.20}}`；
6. 在“原文配置｜结构化计划｜显式假设”三栏中复核，再填写可选的治理版本 ID；
7. 点击“冻结计划”。

可用能力由自动生成的能力清单控制。基本面数据只在公告日之后可用，更正公告从新公告日
起生效；策略版本仍必须处于 `validated`、`paper` 或 `champion`，并绑定相同快照和因子版本。

### 5.2 启动运行

选择冻结计划，点击“启动运行”，输入初始资金后进入队列。页面关闭不会终止服务端任务。

状态含义：

| 状态 | 含义 | 用户操作 |
| --- | --- | --- |
| `queued` | 等待 Worker | 可取消 |
| `running` | 正在计算或撮合 | 可请求取消 |
| `retry_wait` | 可重试错误，等待退避 | 等待或取消 |
| `completed` | 已完成并固化 | 查看账本、订单和制品 |
| `failed` | 当前尝试失败 | 查看错误，按条件重试 |
| `dead_letter` | 达到最大尝试次数 | 修复外部问题后人工重试 |
| `cancelled` | 已取消 | 可重新启动或人工重试 |

任务默认最多尝试三次。错误会按确定性类别处理，不会把 Traceback 交给 Agent 自动改写
策略。

### 5.3 审阅结果

完成态提供：

- 初始资金、期末权益、累计收益率和累计成本；
- 逐日现金、持仓市值、总权益、换手和持仓数量；
- 交易清单；
- 调仓计划、执行结果与扩展诊断制品下载；
- 调仓审阅中的原始/标准化因子、综合分、财报期与公告可用日、行业、优化前后权重；
- 基准与优化组合的预期收益、风险代理、换手、集中度，以及行业偏离和冲突；
- 执行结果中的佣金、卖出税和滑点成本归因。

下载制品在数据库中保存 SHA-256、字节数和媒体类型。回测收益只用于链路复现和研究，
不构成收益承诺。

### 5.4 独立 Worker 部署

单机开发可使用 API 进程内嵌 Worker。生产化拆分方式：

```powershell
# API 进程
$env:MULTI_ASSET_EMBEDDED_WORKER='false'
npm run start

# 独立计算进程
$env:MULTI_ASSET_WORKER_CONCURRENCY='2'
npm run multi-asset:worker
```

队列状态持久化在数据库中，支持租约、心跳、过期恢复、受控重试、死信和取消。不要同时
开启多个没有统一容量规划的 Worker 进程。

## 6. 常见错误

| 表现或错误 | 处理方式 |
| --- | --- |
| `AI_NOT_ENABLED` | 设置 `AI_STRATEGY_ENABLED=true` 并重启服务端 |
| `INVALID_MODEL_OUTPUT` | 按字段路径修改原始策略描述，不要反复提交同一模糊文本 |
| `IDEMPOTENCY_CONFLICT` | 不要使用同一幂等键提交不同配置 |
| `LOCKED_TEST_ALREADY_OPENED` | 锁定测试已使用；创建新实验版本继续研究 |
| 数据库接口返回 503 | 检查 MySQL 和 `/api/health` |
| 多资产计划无法冻结 | 检查快照、日期范围、Top N 与仓位上限是否可行 |
| 因子治理绑定失败 | 确认因子已发布，且快照、因子版本和策略状态一致 |
| `OPTIMIZER_*_VIOLATION` | 检查仓位、换手、单标的和行业约束是否共同可行 |
| `POINT_IN_TIME_*_DATASET_UNAVAILABLE` | 发布包含财务或 SW2021 行业数据集的只读研究快照 |
| 运行进入 `dead_letter` | 先修复数据、快照或 Worker 环境，再人工重试 |
| PDF 长时间排队 | 检查“实验报告中心”的 Worker 状态，并启动 `npm run experiment:report-worker` |
| PDF 任务失败 | 修复 Chromium 路径、目录权限或磁盘空间后，在报告中心点击“重试 PDF” |

## 7. 运维与验收命令

生产部署、Worker 心跳、队列告警、优雅停机、制品清理和故障恢复详见
[M4 多资产 Agent 生产运维手册](../03-运维监控/MULTI_ASSET_PRODUCTION_RUNBOOK.md)。

```powershell
# 根目录：能力清单、全量前端/共享测试与构建
npm run capabilities:check
npm test
npm run build

# server：迁移、类型检查与全量后端测试
cd server
npm run db:migrate
npm run typecheck
npm test

# M4 固定样例、真实快照和生产任务状态机
npm run multi-asset:smoke
npm run multi-asset:snapshot-smoke
npm run multi-asset:persistence-smoke
npm run multi-asset:lease-smoke
npm run multi-asset:api-smoke
npm run multi-asset:production-smoke

# M3 独立 PDF Worker 真实 Chromium 冒烟
npm run experiment:report-worker:smoke
```

项目已经提供 [M1 A/B/C 合成标注流水线](../../server/evaluation/m1/README.md)：模型 A
生成候选，模型 B、C 独立盲审且双通过才进入通过集。`m1-synthetic-v2` 共保留 200 条
双通过样本，并由项目负责人抽查 70 条，70/70 与原文一致。详细记录见
[M1 合成标注集人工抽查记录](../04-数据治理与验收/20260801_M1_SYNTHETIC_CORPUS_HUMAN_SPOTCHECK.md)。

该制品必须标记为“机器全量筛选 + 人工抽查的合成标注集”，不能描述为 200 条人工逐条
标注。正式签署 M1 自然语言解析质量前，仍须使用这 200 条 Gold 候选运行实际解析器，并
报告字段级 precision/recall/F1、首次通过率、确定性修复率、正确澄清率和真实人工确认
修改率；不能用一次成功生成、Mock 测试或标注集自身的 B/C 评分替代解析器评测。

## 8. 安全与研究纪律

- 不在日志、报告或截图中记录模型密钥、数据库密码和完整环境变量；
- 不执行模型返回的任意源码；
- 不允许 Python 计算平面写现金、订单、持仓或最终权益；
- 不使用当前指数成分股回填历史；
- 不在同一锁定测试结果上继续调参；
- 不把测试集结果反馈给 Agent 选择参数；
- 不把实验候选自动晋级或发布；
- 不将回测结果表述为投资建议或收益承诺。

## 9. 相关文档

- [技术设计](./EXPERIMENT_AGENT_STRATEGY_RESEARCH_DESIGN.md)
- [M0–M4 验收报告](../04-数据治理与验收/20260801_EXPERIMENT_AGENT_M0_M4_ACCEPTANCE.md)
- [M3 实验报告 Worker 运维手册](../03-运维监控/EXPERIMENT_REPORT_WORKER_RUNBOOK.md)
- [因子研究使用说明](../02-因子研究与查询/FACTOR_RESEARCH_USER_GUIDE.md)
