# 智能体应用对齐评估与路线（2026-08-02）

> 定位：对照最初"智能体应用"设想，盘点现状数据资产与能力、识别过度防御壁垒、给出重新对齐的阶段路线。
> 本文是讨论产物，不是已批准实施计划；落地前需用户对"决策点"逐项拍板。

## 1. 最初设想（用户口径）

> 用户输入想研究的方向或策略 → 智能体调用两个数据库（MySQL：全 A 个股日频 + 价值因子；DuckDB/分钟快照：分时数据）→ **写代码** → 产出数据 → 得出结论 → 给出报告。

核心特征：**由智能体完成"读数据 → 写代码 → 跑研究 → 出结论"的闭环**，用户只给方向，不做工程操作。

## 2. 现状数据资产盘点（2026-08-02 实测）

| 资产 | 位置 | 规模（实测） |
|---|---|---|
| 全 A 日频（daily_bars_v2） | MySQL | **5,875 只证券 / 17,147,801 行**，2000-01 ~ 2026-07 |
| 日频量价指标（daily_stock_metrics） | MySQL | 17,145,858 行 |
| 财报（financial_reports） | MySQL | 519,397 行 |
| 分红事件（dividend_events） | MySQL | 56,518 行 |
| 因子定义（factor_definitions） | MySQL | 42 个 |
| 申万行业成员（sw_industry_memberships） | MySQL | 6,459 条 |
| 证券主数据（instruments） | MySQL | 5,537 只 stock（含 type/market/industry/listDate） |
| 七层数据（龙虎榜/新闻/资金等） | MySQL | dragon_tiger_billboards、market_news 等表 |
| 日频研究快照（DuckDB parquet） | server/data/research-snapshots | 887 个 parquet / 23.5 GB |
| 分钟数据湖（1m parquet） | D:\github_public_repo\所有股票的历史数据\1m_price_parquet | 4,025 个 parquet / 54.2 GB，2010 年起 |

**结论：数据侧完全支撑"全 A 智能研究"的设想，两库真实可用。问题不在数据，在智能体能力侧。**

## 3. 智能体能力现状

| 能力 | 现状 | 说明 |
|---|---|---|
| 假设生成 | ✅ LLM 生成假设文本 + 能力边界校验 | 但假设 → 固定映射到 `dual_ma`（[hypothesisMapper.ts](../../server/src/experiments/hypothesis/hypothesisMapper.ts)），LLM 不产生代码 |
| 事件引擎筛选 | ✅ backtrader 事件引擎（screening_only） | 白名单策略注册表（[eventEngineStrategies.ts](../../server/src/experiments/m5/eventEngineStrategies.ts)）**仅 1 个：dual_ma** |
| 任意 Python 执行 | ✅ 阶段 C 已开放（2026-08-02） | `research-code` 通道：只读 MySQL + DuckDB 快照挂载 + 强隔离沙箱；结果恒 `exploration_only`（[researchSandboxClient.ts](../../server/src/researchCode/researchSandboxClient.ts)） |
| 因子研究 | ✅ Phase 6 完整（42 因子、runner、挖掘、materialization） | 独立于 Agent，有调度+Python miner，属"固定流程自动化" |
| 权威复算/实验闭环 | ❌ 断点 | 筛选通过 → 直接出报告，**没有权威 TS 复算 → 正式实验 → 结论沉淀**（ADR-05 缺口） |
| 报告 | ✅ 报告中心 + HTML/PDF 制品 | 内容来自筛选层结果，未经复算 |
| 多资产执行（M4） | ✅ 多资产 worker + 模拟盘 | 执行侧完整，但缺少研究结论喂入 |

## 4. 壁垒盘点（"防御性壁垒给太高"的具象化）

1. **能力清单只锁到 1 个策略**：`goldenParityLocked` 门槛高（TS/Python 严格对拍），RSI/MACD/BOLL 均未锁定 → 假设研究永远只能跑双均线，"智能"形同虚设。
2. **任意 Python 默认全关**：`EXPERIMENT_ARBITRARY_PYTHON_ENABLED=false`，且即使开启也标记 `authority=exploration_only`、`publishable=false`，必须权威复算+人工审批。当前**没有一条可用的"写代码做研究"路径**——这是与最初设想差距最大的一处。
3. **假设映射不写代码**：假设生成 Agent 只产文本，由 `hypothesisToStrategyDocument` 硬编码映射到白名单策略，模型对"如何研究"没有话语权。
4. **研究闭环断裂**：筛选（screening_only）→ 权威复算（TS）→ 正式实验 → 结论/报告，中间环节缺失，导致"评估通过=直接出报告"且报告未经复算（本次 0 交易问题只是表象，流程断点是根因）。
5. **结论沉淀缺失**：没有"研究结论 → 因子/策略入册 → 多资产执行"的管道，Agent 研究的产出无法闭环到执行。

## 5. 偏离分析：必要防御 vs 过度防御

### 应保留（必要，防"假智能"与不可追溯）
- Schema 修复中间件（只做可证明不改变语义的修复，防 LLM 幻觉污染）
- 三栏确认（原始描述｜结构化抽取｜显式假设）
- specHash/resultHash 幂等 + 完整性校验（防重复/篡改）
- 黄金样例对拍（防引擎漂移）——但门槛应从"全部或全无"改为"按策略逐个解锁"
- 沙箱强隔离（digest 钉死/签名/seccomp）——任意代码执行必须保留此防线
- ADR-05 的"筛选不可直接发布"原则——但缺了配套的"权威复算"通道，变成只堵不放

### 过度/未接通（导致智能体跑不起来）
- 策略能力面锁死到 1 个，且无解锁节奏
- 任意 Python 只做了隔离没有做"受控开放"通道
- 研究闭环断在筛选层，结论无法产生、无法入册
- LLM 只做"入口一句话"，不参与研究方法设计

## 6. 对齐路线（建议顺序）

### 阶段 A：接通研究闭环（先转起来）
复用 M5 `authorityReplayWorkflow`：筛选通过 → 权威 TS 复算 → 生成复算报告 → 结论状态（通过/否决/待人工）→ 结论可沉淀为实验结论。
- 目的：让"评估通过"有一个真实可信的终点，报告内容经权威引擎背书。
- 交付：`POST /api/hypotheses/:id/promote`（或评估链路内自动触发）+ 结论入实验表。

### 阶段 B：扩策略能力面（让"智能"有宽度）
逐个把 RSI / MACD / BOLL / 波动率策略做黄金样例锁定并发布进能力清单；同时建立 **假设 → 策略映射矩阵**（LLM 产出的假设语义分类 → 可用的策略+参数网格），让不同假设落到不同策略，而非全部双均线。
- 目的：LLM 的假设第一次真正影响研究方法。
- 交付：事件引擎注册表扩到 ≥4 策略 + 映射矩阵 + 黄金样例矩阵。

### 阶段 C：受控开放"写代码研究"路径（回到最初设想）—— ✅ 已完成（2026-08-02）

> 用户拍板"直接做阶段 C"（决策点 2：只读库访问 + 强隔离沙箱 + exploration_only 标记边界获认可）。已交付并端到端验证：
>
> - **只读数据边界**：MySQL 只读账号 `quant_research_ro`（仅 SELECT，已验证写操作被拒）+ DuckDB 日频快照/分钟数据湖只读挂载；
> - **研究沙箱镜像** `quant-sandbox-research:dev`：基于本地 `quant-sandbox:dev` + 清华 PyPI 装 duckdb/pandas/pymysql；`--read-only` + `--cap-drop=ALL` + `--pids-limit=16` + 内存/CPU/超时上限；
> - **后端**：`researchSandboxClient.ts`（M5 协议）、`research_code_runs` 表（migration 0045）、`POST/GET /api/research-code/runs`；
> - **前端**：`/research-code` 写代码研究页（代码编辑 + 运行历史 + 结果/输出/错误展开）；
> - **端到端验证**：真实代码在沙箱内读 MySQL（17,147,801 行 / 5,875 只 / 至 2026-07-31）+ DuckDB（887 parquet）成功，状态 `completed`、`authority=exploration_only`、`publishable=false`；沙箱内 `CREATE TABLE` 被只读账号拒绝。
>
> 阶段 C 打通了"写代码 → 产出数据"通道；"结论 → 权威复算 → 入册"仍依赖阶段 A，ADR-05 防线保留。

### 阶段 D：整合对话式工作台（产品形态）
把策略工作室 AI 抽屉、假设研究、报告中心、因子研究、多资产整合为一个自然语言驱动的工作台：用户描述方向 → Agent 规划（假设/因子/回测）→ 执行 → 报告 → 可入册。
- 目的：用户侧感知"这是一个智能体应用"，而非零散管理页。

## 7. 决策点（需用户拍板）

1. **阶段 A 是否现在开工**：接通"筛选→权威复算→结论"闭环，让现有评估有可信终点？
2. **任意 Python 的开放边界**：✅ 已拍板并落地（阶段 C 完成）——只读库访问 + 强隔离沙箱 + exploration_only 标记，`EXPERIMENT_RESEARCH_CODE_ENABLED=true` 已启用，通道已端到端验证。
3. **策略解锁节奏**：阶段 B 先做哪 1~2 个策略？（建议 RSI 超卖反转 + MACD）
4. **优先级排序**：A→B→C→D 顺序是否认可，还是想先做 C（直接回归"写代码"设想）？

## 附：与原始设计文档的关系

本评估不推翻 [EXPERIMENT_AGENT_STRATEGY_RESEARCH_DESIGN.md](./EXPERIMENT_AGENT_STRATEGY_RESEARCH_DESIGN.md) 的 M0-M5 架构与验收结论；它只指出"工程管道已超额完成、研究闭环未接通、策略/代码能力未开放"三个偏差，并把后续计划从"继续加固平台"拉回"让智能体真正做研究"。
