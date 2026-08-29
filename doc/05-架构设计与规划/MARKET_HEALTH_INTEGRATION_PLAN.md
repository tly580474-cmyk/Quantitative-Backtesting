# 大盘健康度指标集成开发计划

> 文档状态：待实施  
> 制定日期：2026-08-29  
> 适用范围：市场数据页、市场健康度离线计算、宏观/财务数据治理、服务端只读 API 及调度监控。  
> 关联验证：`server/experiments/mhi-v1`、`mhi-v2`、`mhi-v3`。  
> 核心约束：不将 MSI、MSH、FHI、NEC、VPI 线性合成为单一总分，不将低频指标伪装成实时指标。

## 0. 决策摘要

在市场数据页现有“大盘情绪温度计”位置增加指标下拉菜单，复用同一张卡片展示五条语义独立的轴：

| 指标 | 产品名称 | 频率 | 更新方式 | 分数含义 |
| --- | --- | --- | --- | --- |
| MSI | 大盘情绪 | 盘中 | 维持现有 5 分钟刷新 | 越高代表情绪越热 |
| MSH | 市场结构 | 日频 | 收盘行情同步后计算 | 越高代表结构越稳健 |
| FHI | 盈利承载 | 公告/季度 | 财报出现新公告版本后计算 | 越高代表已披露盈利越强 |
| NEC | 名义盈利周期 | 月频 | PPI 发布或修订后计算 | 越高代表名义周期越强，不代表价格越安全 |
| VPI | 估值压力 | 日频 | 收盘行情同步后计算 | 越高代表估值压力越大 |

FHI、NEC、VPI 不进入 MSI 的实时刷新链路。MSH、FHI、NEC、VPI 由离线任务计算并发布快照，
页面只读取最新已发布结果。NEC 保持月度更新，同时生成季度归档；FHI 按公告事件更新并形成季度版本；
VPI、MSH 每日更新并保存季度末快照。

## 1. 目标与非目标

### 1.1 目标

1. 在不改变 MSI v2 现有行为的前提下，完成五轴状态卡集成。
2. 将实验 SQL 中已验证的计算口径迁移到可版本化、可调度、可审计的生产模块。
3. 保存宏观首发与修订版本，明确观察期、发布日期、系统可用日和抓取时间。
4. 通过数据变化触发、定时兜底和启动补偿，保证月度及季度结果不会因休市、重启或抓取失败而遗漏。
5. 对覆盖率不足、数据过期、口径断点和计算失败进行显式降级，不静默展示旧值。
6. 为后续历史曲线、季度对比和回测复核保留完整快照。

### 1.2 非目标

- 不发布一个由五轴加权产生的“MHI 总分”。
- 不根据本轮历史结果重新拟合指标权重。
- 不在 HTTP 请求过程中扫描全量 Parquet 或运行完整 DuckDB 实验流水线。
- 不把 AKShare 聚合页描述为央行或统计局官方直连接口。
- 第一阶段不加入 PMI、M1-M2 等尚未通过稳定性验证的正式展示轴。
- 第一阶段不实现历史曲线交互；只保留后端数据能力和扩展接口。

## 2. 现状与改造边界

### 2.1 前端现状

- 当前卡片实现在 `src/features/marketData/MarketDataPage.tsx` 的 `MarketThermometer`。
- `MarketSentimentPanel` 同时承载涨跌分布、MSI 卡片和 MSI 说明。
- MSI 每 5 分钟通过 `/api/market-data/market-sentiment` 强制刷新。
- 页面级内存缓存位于 `src/features/marketData/marketDataCache.ts`。
- 样式集中在 `src/index.css`，已有响应式和深色模式规则。

### 2.2 服务端现状

- MSI 接口位于 `server/src/routes/marketData.ts`，计算和缓存位于
  `server/src/marketData/aStockDataService.ts`。
- 日行情默认在 15:30 同步，财务数据默认在 19:00 更新。
- `financialDataScheduler.ts` 当前会受 `SCHEDULE_SKIP_NON_TRADING_PERIODS` 影响而跳过休市日；
  这适合行情，但不适合可能在周末或节假日披露的财务公告。
- 研究快照和 DuckDB CLI 已具备挂载 `bars`、`financial_reports` 等数据集的能力。
- `market_data_collector_runs` 已提供任务防重和结果记录基础。

### 2.3 改造原则

实验目录继续作为研究证据，不直接成为生产运行依赖。生产实现提取固定公式、参数和数据门禁，
通过单独服务、仓储与调度器发布小型结果快照。

## 3. 总体架构

```text
行情同步 ───────────────┐
                       ├─→ 指标重算队列 ─→ DuckDB 计算 ─→ 质量门禁 ─→ 快照原子发布
财务公告自然日采集 ────┤                                            ↓
                       │                                  market_health_snapshots
宏观数据自然日检查 ────┘                                            ↓
                                                         只读 API / 前端状态卡
```

生产链路分为四层：

1. **原始层**：保存行情、财报公告版本、宏观观察值和来源证据。
2. **计算层**：按固定模型版本计算 MSH、FHI、NEC、VPI。
3. **发布层**：通过覆盖率、时点、范围和完整性检查后，将 pending 版本原子切换为 published。
4. **展示层**：API 只读 published 版本，MSI 仍走现有实时接口。

## 4. 数据模型

### 4.1 `macro_observations`

建议新增迁移 `server/src/db/migrations/0044_market_health.sql`；实施前检查编号是否已被其他分支占用。

| 字段 | 类型建议 | 说明 |
| --- | --- | --- |
| id | bigint | 主键 |
| series_key | varchar(32) | `ppi_yoy` 等稳定代码 |
| observation_period | date | 数据所属月份/季度 |
| value | double | 标准化前原始值 |
| published_at | datetime nullable | 官方实际发布时间 |
| available_at | datetime | 系统允许使用的时间 |
| fetched_at | datetime | 抓取时间 |
| source_key | varchar(64) | 数据提供/传输层 |
| authority_key | varchar(64) | 统计局、人民银行等权威机构 |
| source_url | varchar(1024) | 对应发布页或文件 |
| source_checksum | varchar(64) | 原始响应或文件 SHA-256 |
| revision_no | int | 同一观察期修订序号 |
| status | varchar(16) | `observed/revised/rejected` |

唯一约束：`(series_key, observation_period, source_checksum)`。同一观察期数值变化时追加版本，不覆盖旧值。

### 4.2 `market_health_snapshots`

| 字段 | 类型建议 | 说明 |
| --- | --- | --- |
| id | bigint | 主键 |
| indicator_key | varchar(16) | `msh/fhi/nec/vpi` |
| as_of_date | date | 指标所属日或季度 |
| period_key | varchar(16) | 如 `2026-08`、`2026Q2` |
| score | double | 0～100 |
| status_label | varchar(64) | 面向用户的状态 |
| interpretation | text | 指标解释，不给买卖结论 |
| direction | varchar(32) | 高分语义 |
| frequency | varchar(16) | `daily/event/monthly/quarterly` |
| model_version | varchar(32) | 公式版本 |
| components_json | json | 分项、权重、数值与来源 |
| source_periods_json | json | 使用的行情/财报/宏观数据期 |
| coverage_pct | double nullable | 股票覆盖率等质量信息 |
| source_snapshot_id | varchar(128) | 对应研究快照 |
| calculated_at | datetime | 完成计算时间 |
| publication_status | varchar(16) | `pending/preliminary/published/superseded` |
| stale_after | datetime nullable | 超过后页面标为过期 |

唯一约束：`(indicator_key, as_of_date, model_version)`；查询索引：
`(indicator_key, publication_status, as_of_date)`。

### 4.3 不可混淆的时间字段

- `observation_period`：统计数据属于哪个月或季度。
- `published_at`：权威机构何时发布。
- `available_at`：系统从何时允许模型使用。
- `as_of_date`：指标快照描述的市场时点。
- `calculated_at`：系统何时完成计算。

API 和页面必须同时展示 `asOfDate` 与 `calculatedAt`，不能用“刚刚更新”掩盖数据本身属于旧季度。

## 5. 指标生产化方案

### 5.1 MSH

- 数据：交易日收盘行情、行业行情、流动性和回撤特征。
- 触发：15:30 行情同步成功后；建议计算时间 16:00 以后。
- 公式：沿用 MHI v1 冻结权重，不重新拟合。
- 发布门禁：当日行情完整、行业广度可用、历史窗口不少于 252 个交易日。
- 季度归档：季度最后一个有效交易日的 published 快照。

### 5.2 FHI

- 数据：按公告日可用的 `financial_reports` 版本。
- 触发：发现新的公告日期、报告期版本或更正版本后重算；无变化不重算。
- 公式：盈利能力 50%、盈利增长 50%；现金流质量第一阶段仅展示诊断值，不计入 FHI。
- 初步发布：覆盖率未达到正式阈值但高于最低展示阈值时标记 `preliminary`。
- 正式发布：建议 `roe_coverage_pct >= 85%` 且 `growth_coverage_pct >= 85%`；阈值上线前用历史数据复核。
- 休市修正：财务公告采集改为自然日运行，不能继承行情任务的休市跳过策略。
- 季度归档：每个报告期保存初步值、正式值和后续更正版，不覆盖历史版本。

### 5.3 NEC

- 数据：PPI 同比及三个月变化；水平 60%、变化 40%。
- 触发：每天自然日检查一次数据源，只有出现新观察期或 checksum 变化时重算。
- 发布时间：优先保存官方实际 `published_at`；缺少历史发布时间时才使用明确标注的保守可用日。
- 月度发布：每个 PPI 观察月发布一份 NEC。
- 季度归档：使用季度最后一个月份的已发布 NEC；最后一个月尚未发布时标记“季度进行中”，不得冒充完整季度。
- 来源要求：AKShare 可作为传输或交叉验证层；生产 manifest 必须区分 retrieval URL 与 official authority URL。

### 5.4 VPI

- 数据：日终总市值、PE TTM、PB 及历史分布。
- 触发：收盘行情和估值字段同步完成后每日计算。
- 方向：分数越高表示估值压力越大，不能复用 FHI 的“越高越健康”文案和配色。
- 发布门禁：正 PE、正 PB 的股票覆盖率达到设定阈值；异常极值和当日覆盖骤降需要拒绝发布。
- 季度归档：季度最后一个有效交易日的 published 快照。

## 6. 更新、补偿与季度保障

### 6.1 调度策略

| 任务 | 建议时间 | 日历 | 触发条件 |
| --- | --- | --- | --- |
| MSI | 现有 5 分钟 | 交易时段 | 保持现状 |
| MSH/VPI | 行情同步后 | 交易日 | 当日行情版本变化 |
| 财务公告采集 | 19:00，可增加早间补偿 | 自然日 | 每日检查 |
| FHI | 财务采集成功后 | 自然日 | 财务 fingerprint 变化 |
| PPI 检查 | 10:30 与启动补偿 | 自然日 | 新观察期或修订 |
| NEC | PPI 入库后 | 自然日 | 宏观 checksum 变化 |
| 季度归档 | 每日检查 | 自然日 | 季度完成条件满足 |

### 6.2 数据驱动，不使用单一季度定时器

季度更新由以下闭环保证：

```text
自然日检查数据源
  → 比较 observation_period + checksum
  → 写入新版本
  → 创建唯一 runKey
  → 幂等重算受影响指标
  → 写入 pending
  → 质量门禁
  → 原子发布
  → 更新 freshness 状态
```

建议 runKey：

```text
macro:ppi_yoy:2026-06:<checksum>
health:nec:2026-06:<modelVersion>:<sourceChecksum>
health:fhi:2026Q2:<modelVersion>:<financialFingerprint>
health:vpi:2026-06-30:<modelVersion>:<snapshotId>
```

### 6.3 补偿机制

1. 服务启动时检查每个指标的 latest period，不依赖当天定时点是否已经错过。
2. 失败任务保留原 runKey，按退避策略重试；成功后不重复计算。
3. 每周执行一次全链路 reconciliation，比较原始最新期与 published 最新期。
4. 新数据到达但指标未发布超过 SLA 时，在管理台和日志中告警。
5. 旧 published 快照始终保留；新版本失败时继续返回旧值，但 API 必须标记 `stale=true`。

### 6.4 Freshness 判定

服务端返回每轴状态：

```ts
type HealthFreshness = 'current' | 'preliminary' | 'stale' | 'unavailable';
```

- `current`：观察期、覆盖率和计算版本均符合预期。
- `preliminary`：新季度已有数据，但覆盖率尚未达到正式发布门槛。
- `stale`：预计数据已经可得或来源已更新，但计算/发布未完成。
- `unavailable`：没有任何可用 published 快照。

## 7. API 设计

### 7.1 当前快照

新增：

```http
GET /api/market-data/market-health
```

一次返回全部低频轴，不接受触发全量计算的 `force=true`：

```ts
interface MarketHealthOverview {
  generatedAt: string;
  indicators: Partial<Record<'msh' | 'fhi' | 'nec' | 'vpi', MarketHealthIndicator>>;
}

interface MarketHealthIndicator {
  key: 'msh' | 'fhi' | 'nec' | 'vpi';
  name: string;
  score: number;
  scale: [number, number];
  direction: 'higher_is_better' | 'higher_is_riskier' | 'cycle_strength';
  statusLabel: string;
  interpretation: string;
  frequency: 'daily' | 'event' | 'monthly';
  asOfDate: string;
  periodKey: string;
  calculatedAt: string;
  modelVersion: string;
  coveragePct: number | null;
  freshness: 'current' | 'preliminary' | 'stale' | 'unavailable';
  components: MarketHealthComponent[];
}
```

MSI 继续通过现有 `/api/market-data/market-sentiment` 返回，不改变其兼容性。

### 7.2 历史接口预留

第一阶段可以不在 UI 使用，但仓储层预留：

```http
GET /api/market-data/market-health/:indicator/history?start=YYYY-MM-DD&end=YYYY-MM-DD
```

接口必须只返回在相应 `available_at` 后发布的版本，不能用最新修订值覆盖历史时点。

## 8. 前端集成

### 8.1 组件拆分

将 `MarketThermometer` 重构为：

- `MarketIndicatorCard`：卡片壳、下拉菜单、分数、时间与 freshness。
- `MsiIndicatorContent`：复用现有 MSI 温度带、结构背离和 A/B/C/D 因子。
- `HealthIndicatorContent`：展示 MSH/FHI/NEC/VPI 的刻度、解释和分项。
- `useMarketHealthOverview`：独立读取低频接口，不加入 5 分钟轮询。

建议新增文件：

```text
src/features/marketData/MarketIndicatorCard.tsx
src/features/marketData/useMarketHealthOverview.ts
src/features/marketData/marketHealthPresentation.ts
```

### 8.2 交互规则

1. 默认选中 MSI；通过 `localStorage` 保存用户上次选择。
2. 下拉选项同时展示名称、代码和频率标签，如“盈利承载 FHI · 公告驱动”。
3. 指标切换只切换本地内容，不发起重复 HTTP 请求。
4. 卡片保持固定最小高度，异步加载时使用等高 Skeleton，避免布局跳动。
5. 下拉触发区不少于 44×44px，支持键盘、可见焦点和 `aria-label`。
6. MSI 保留 `-100～100` 刻度；其余指标使用 `0～100`，不得共用刻度文案。
7. NEC 和 VPI 使用各自语义配色，颜色不能成为唯一状态提示。
8. 页面顶部“刷新市场概况”可以重新读取最新低频快照，但不能触发后台全量计算。

### 8.3 缓存

- `marketDataCache` 增加 `marketHealth` 和 `marketHealthCachedAt`。
- 前端低频缓存建议 30 分钟；用户刷新只绕过前端缓存读取服务端最新 published 快照。
- 服务端查询可使用 1～5 分钟内存缓存，底层 MySQL 快照仍是权威结果。

## 9. 服务端模块落点

建议新增：

```text
server/src/marketHealth/types.ts
server/src/marketHealth/repository.ts
server/src/marketHealth/service.ts
server/src/marketHealth/calculation/
  marketStructure.ts
  fundamentalHealth.ts
  nominalEarningsCycle.ts
  valuationPressure.ts
server/src/marketHealth/jobs/marketHealthScheduler.ts
server/src/marketHealth/jobs/macroObservationCollector.ts
server/src/marketHealth/jobs/quarterlyReconciliation.ts
server/src/marketHealth/*.test.ts
```

计算层通过托管 DuckDB 会话读取最新研究快照；计算完成后只把小型结果写入 MySQL。必须遵循项目
现有 DuckDB 并发与内存限制，不为每个 API 请求创建新扫描任务。

## 10. 开发阶段与交付物

### 阶段 A：契约与持久化

任务：

- 增加两张表及 Drizzle schema。
- 定义服务端/前端共享语义一致的类型。
- 实现 snapshot repository、最新版本查询与原子发布。
- 建立 source/version/freshness 字段，不先做 UI。

验收：

- 同一 runKey 重复执行不产生重复数据。
- pending 失败不影响现有 published 版本。
- 可以查询每个指标的最新 published、preliminary 和 stale 状态。

### 阶段 B：VPI、FHI 生产化

任务：

- 从实验 SQL 提取固定公式和测试夹具。
- VPI 接入日终行情触发。
- FHI 接入财务公告版本触发，并把财务采集调整为自然日可运行。
- 实现覆盖率门禁和季度状态。

验收：

- 结果与冻结实验在同一快照上的差异小于浮点容差。
- FHI 不读取公告日之后才知道的数据。
- 周末模拟新公告能够被发现并生成 preliminary 快照。

### 阶段 C：NEC 与宏观版本治理

任务：

- 实现 PPI 采集、原始响应哈希和官方抽样核对。
- 支持首发与修订版本。
- 实现 NEC 月度快照及季度末归档。
- 增加启动补偿和每周 reconciliation。

验收：

- 新观察月只触发一次计算；同值重复抓取不触发。
- 修订值追加版本并生成新 NEC，不覆盖历史记录。
- 季度最后一个月未发布时只能显示“季度进行中”。

### 阶段 D：MSH 生产化

任务：

- 接入日终行情、行业广度和历史窗口。
- 保留 v1 权重和消融测试基线。
- 添加数据完整性与行业覆盖门禁。

验收：

- 与实验结果逐日对齐。
- 行情缺失或行业数据异常时拒绝发布，不用中性值掩盖故障。

### 阶段 E：前端状态卡

任务：

- 重构温度计为通用卡片。
- 接入下拉选择、不同刻度、频率和 freshness 标签。
- 缓存用户选择，适配移动端和深色模式。
- 保持 MSI 左侧涨跌分布和现有 5 分钟刷新行为不变。

验收：

- 五个指标可键盘切换且无布局跳动。
- 切换低频指标不触发 DuckDB 计算或额外重复请求。
- VPI、NEC 的高分语义没有被显示为“更健康”。
- 375px、768px、1024px、1440px 以及深色模式通过视觉检查。

### 阶段 F：监控、灰度与文档

任务：

- 管理台增加指标 freshness、最近成功时间、最新观察期和失败任务。
- 增加手工重算 CLI；只允许指定指标和日期，不开放任意 SQL。
- 完成运行手册、异常恢复和模型版本升级说明。
- 先灰度展示数据期和分项，再开放默认下拉入口。

验收：

- 人为制造抓取失败、计算失败和覆盖率不足时，页面状态准确。
- 服务重启跨过定时点后能够自动补偿。
- 回滚模型版本无需删除数据，只需切回上一 published 版本。

## 11. 测试矩阵

### 11.1 单元测试

- 各轴固定输入与分数结果。
- 分数边界、NULL、异常值和覆盖率门禁。
- status label、direction 和刻度映射。
- 调度 due 判断、runKey 幂等、自然日/交易日区别。
- 宏观 revision_no 和 checksum 去重。

### 11.2 集成测试

- 财报公告入库 → FHI pending → published。
- PPI 新月份/修订 → NEC 新版本。
- 行情同步 → MSH/VPI 日终快照。
- 计算失败后 API 返回旧 published 且 `stale=true`。
- 服务重启后的 missed-run 补偿。

### 11.3 前端测试

- 默认 MSI、选择持久化和下拉键盘操作。
- 每种 direction 的颜色、标签和解释。
- loading、preliminary、stale、unavailable 四种状态。
- 低频数据不进入 5 分钟 MSI 轮询。
- 响应式、深色模式与可访问性。

### 11.4 回归测试

- `/market-sentiment` 响应结构和 MSI v2 计算不变。
- 市场涨跌分布、股票明细抽屉和全局刷新保持可用。
- 财务更新、研究快照构建与现有调度任务不退化。

## 12. 发布与回滚

1. 数据库迁移先上线，表为空时旧页面不受影响。
2. 后台以 shadow 模式计算，至少覆盖一个完整数据更新周期，不向前端展示。
3. 对照实验产物与生产快照，确认公式、数据期和覆盖率一致。
4. 上线只读 API，前端通过功能开关隐藏新下拉。
5. 开启内部灰度，观察 freshness、错误率和计算耗时。
6. 开放下拉；默认值仍为 MSI。
7. 回滚时关闭功能开关并停止低频调度，保留所有原始数据和快照。

## 13. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 宏观历史数据被修订 | 保存版本与 checksum；历史查询按 available_at 选版本 |
| AKShare 实际来自聚合页 | 分离 retrieval 与 authority；保存官方抽查证据 |
| 财报季度披露不齐 | preliminary/published 双状态和覆盖率门禁 |
| 周末公告遗漏 | 财务和宏观采集使用自然日调度及启动补偿 |
| 低频指标被误认为实时 | 显示数据期、频率、计算时间和 freshness |
| NEC/VPI 高分被误读 | direction 字段、专用配色和轴特定文案 |
| API 请求触发重计算 | API 严格只读 published 快照 |
| DuckDB 并发占用 | 调度队列、单飞锁、内存限制和错峰运行 |
| 模型升级破坏历史 | model_version 并存，旧版本不覆盖 |

## 14. 完成定义

满足以下条件后视为第一版集成完成：

- MSI、MSH、FHI、NEC、VPI 均有明确且不混淆的产品语义。
- 页面下拉可以稳定切换五轴，默认 MSI，低频轴不参与 5 分钟轮询。
- 所有低频轴来自 published 快照，API 请求不执行全市场计算。
- FHI 能在非交易日发现新公告，并通过覆盖率发布季度初步值/正式值。
- NEC 能按月更新、按季度归档，并保留修订历史及来源证据。
- VPI、MSH 能在收盘后更新并生成季度末快照。
- stale、preliminary、unavailable 均可在 API、页面和管理台被观察。
- 生产结果与冻结实验结果通过基准对齐，且没有未来数据泄漏。
- 运行手册、恢复流程、模型版本和回滚开关齐备。
