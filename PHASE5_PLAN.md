# 量化回测第五阶段：自动化行情数据平台

## 1. 阶段定位

第五阶段在现有 MySQL 持久化、行情分析、策略回测和参数实验能力之上，建设稳定、可追溯的自动化行情数据管线。系统能够从配置的数据源同步证券基础信息、交易日历和日线行情，自动完成历史回补、每日增量更新、复权处理、质量检查及异常重试。

核心闭环：

```text
配置数据源与同步范围
          ↓
证券列表 / 交易日历同步
          ↓
历史行情回补 / 每日增量更新
          ↓
标准化、去重、复权与质量校验
          ↓
MySQL 原子写入与版本记录
          ↓
同步监控、异常重试与数据修复
          ↓
行情分析 / 回测 / 参数实验统一消费
```

第五阶段优先解决“数据从哪里来、是否完整、何时更新以及能否复现”，为第六阶段的量化因子研究提供可信数据基础。

## 2. 阶段目标

1. 建立可替换的数据源适配器，不让业务逻辑绑定单一供应商；
2. 支持 A 股、主要指数的证券信息、交易日历和日线行情同步；
3. 支持历史数据回补、每日增量更新、手动补数和失败重试；
4. 统一原始价格、前复权和后复权口径，保留数据来源及版本；
5. 自动识别缺失、重复、非法价格和异常涨跌等质量问题；
6. 提供任务进度、同步日志、数据新鲜度和异常处理界面；
7. 现有行情分析、回测和实验功能无须关心数据来源即可使用自动同步数据；
8. 为后续财务数据、指数成分和因子计算预留可扩展的数据模型。

## 3. 范围与优先级

### 3.1 P0：数据口径与工程基线

- 定义统一证券代码格式、市场标识、交易日和时区口径；
- 日线日期按 `Asia/Shanghai` 交易日保存，禁止使用服务器本地时区隐式转换；
- 定义开盘价、最高价、最低价、收盘价、成交量和成交额的单位；
- 建立数据源配置、凭据读取、限流、超时、重试和错误归一化机制；
- 数据源密钥仅保存在服务端环境变量，不进入前端、日志和数据库明文字段；
- 建立数据库迁移、任务锁、审计日志和数据版本基线；
- 同步写入必须幂等，同一证券同一交易日不得产生重复 K 线。

### 3.2 P1：自动同步 MVP

- 实现统一 `MarketDataProvider` 接口和至少一个可用数据源适配器；
- 同步证券基础信息，包括代码、名称、市场、类型、上市和退市日期；
- 同步交易日历，并记录开市、休市和特殊交易日状态；
- 支持单证券、多证券和按市场批量回补日线行情；
- 支持按最后有效交易日执行增量更新；
- 支持手动触发、查看进度、取消等待任务和重试失败项；
- 批量同步按页或分块执行，避免大事务和内存峰值；
- 每个同步任务记录范围、数据源、耗时、成功数、跳过数和失败原因；
- 应用启动时不自动执行大规模历史回补，避免阻塞服务启动。

### 3.3 P1：复权与数据质量

- 保存未经复权的原始 OHLCV 数据，不用复权结果覆盖原始记录；
- 保存复权因子及其来源，按需生成前复权和后复权序列；
- 回测结果记录使用的复权模式、行情版本和数据更新时间；
- 检查 OHLC 关系、负价格、负成交量、重复日期和日期乱序；
- 结合交易日历识别缺失 K 线，停牌与数据缺失必须区分；
- 对异常涨跌、成交量突变和复权因子跳变生成警告，不擅自修改原始值；
- 质量问题支持确认、忽略、重新拉取和人工修复记录；
- 数据修复后生成新版本，不静默改变已有回测所引用的数据快照。

### 3.4 P2：调度与运维

- 支持配置每日自动更新时间、启用状态和同步市场；
- 仅在交易日收盘后的安全时间窗口执行日线更新；
- 服务重启后可以识别未完成任务，避免重复并发执行；
- 同类任务使用分布式或数据库任务锁，单实例和多实例均不得重复写入；
- 对网络错误、限流和临时服务错误使用指数退避重试；
- 对鉴权失败、余额不足和参数错误停止自动重试并明确告警；
- 提供数据新鲜度总览、最近成功时间、待补交易日和失败证券数量；
- 日志保留结构化错误码，不记录完整密钥、请求头或敏感响应。

### 3.5 P2：数据使用体验

- 数据管理页增加“自动数据”入口和同步状态；
- 支持按代码、名称、市场和数据新鲜度筛选证券；
- 支持选择证券后直接打开行情分析、策略回测或参数实验；
- 展示数据来源、实际日期范围、记录数、复权状态和最近更新时间；
- 手工 Excel 导入继续保留，并明确标识为“本地导入”来源；
- 自动数据和手工数据使用统一 Repository，不在页面维护两套业务逻辑；
- 数据量较大时使用服务端分页、筛选和排序。

## 4. 明确不纳入第五阶段

- 分钟线、Tick、逐笔成交和实时推送行情；
- 自动交易、券商下单和实盘账户连接；
- 新闻、公告、舆情和另类数据采集；
- 网页 DOM 爬取、验证码绕过和违反数据源服务条款的采集方式；
- 财务因子、技术因子自动挖掘和机器学习选股；
- 多因子合成、IC 分析、因子分层和行业中性化；
- 多数据源自动拼接为“真值”而不保留来源差异；
- 无数据授权情况下向外部分发或公开缓存行情。

量化因子研究作为第六阶段候选，不应在数据质量和版本追踪尚未稳定时提前混入。

## 5. 关键业务口径

### 5.1 证券与交易日

- 内部证券 ID 与供应商代码分离，通过映射表维护；
- 证券唯一键由市场、代码和证券类型共同确定；
- 上市前、退市后、休市日和停牌日不按普通缺失数据处理；
- 交易日历是增量同步和缺失检查的唯一日期基线；
- 供应商返回的日期和时间统一转换后再写入数据库。

### 5.2 原始与复权行情

- 原始行情是不可变事实层，标准化只转换格式和单位；
- 前复权用于观察当前价格体系下的历史走势，后复权用于观察累计增长；
- 回测默认复权模式必须在界面和结果快照中明确展示；
- 复权因子变化后重新计算派生序列，并保留旧版本引用能力；
- 不允许将供应商已经复权的数据误标为原始行情。

### 5.3 增量更新与幂等

- 增量起点从数据库最后完整交易日计算，并保留可配置重叠窗口；
- 重叠窗口用于处理供应商事后修订，不依赖单纯追加；
- 唯一索引和 upsert 共同保证重复执行结果一致；
- 单个证券失败不应中止整个批次；
- 任务完成状态必须在数据事务成功后更新；
- 取消任务只停止尚未开始的分块，已提交事务不得产生半条记录。

### 5.4 数据质量等级

```text
通过：结构、交易日和数值检查均正常
警告：存在可疑波动或待确认差异，仍可使用但需提示
阻断：关键字段缺失、价格非法或日期冲突，不允许进入回测
```

质量规则、阈值和检查版本必须记录，避免规则升级后无法解释历史状态。

## 6. 技术方案

### 6.1 服务端模块划分

```text
server/src/marketData/
  providers/
    provider.ts                 数据源统一接口
    primaryProvider.ts          首个数据源适配器
    providerRegistry.ts         适配器注册与选择
  normalization/
    symbolMapper.ts             证券代码映射
    candleNormalizer.ts         行情字段和单位标准化
    adjustment.ts               复权序列计算
  quality/
    validators.ts               结构与数值检查
    calendarCheck.ts            缺失交易日检查
    anomalyDetector.ts          异常波动警告
  jobs/
    syncScheduler.ts            定时计划
    syncExecutor.ts             分块执行
    retryPolicy.ts              重试分类与退避
    jobLock.ts                  防重复执行
  repositories/
    instrumentRepository.ts
    calendarRepository.ts
    marketDataRepository.ts
    syncJobRepository.ts

server/src/routes/
  instruments.ts
  marketData.ts
  syncJobs.ts
  dataQuality.ts
```

### 6.2 数据源接口

```ts
interface MarketDataProvider {
  readonly id: string;
  getCapabilities(): ProviderCapabilities;
  fetchInstruments(request: InstrumentRequest): Promise<InstrumentPage>;
  fetchTradingCalendar(request: CalendarRequest): Promise<TradingDay[]>;
  fetchDailyCandles(request: DailyCandleRequest): Promise<ProviderCandle[]>;
  fetchAdjustmentFactors(request: AdjustmentRequest): Promise<AdjustmentFactor[]>;
}
```

实施约束：

- Provider 只负责外部协议和字段映射，不直接写数据库；
- 调度器只依赖统一接口，不判断具体供应商；
- 每个 Provider 声明支持市场、数据类型、日期跨度和限流能力；
- 外部错误统一映射为鉴权、限流、网络、参数、配额和数据异常；
- 测试使用 Mock Provider，不依赖真实网络和真实密钥。

### 6.3 建议数据模型

```text
instruments
  id, market, symbol, name, type, list_date, delist_date, status

provider_symbol_mappings
  provider_id, instrument_id, provider_symbol

trading_calendar
  market, trade_date, is_open, session_metadata

daily_candles
  instrument_id, trade_date, open, high, low, close,
  volume, turnover, source_id, source_version, fetched_at

adjustment_factors
  instrument_id, trade_date, factor, source_id, fetched_at

market_data_versions
  id, instrument_id, start_date, end_date, checksum,
  adjustment_version, quality_status, created_at

sync_jobs
  id, job_type, status, provider_id, request_snapshot,
  total_items, completed_items, failed_items, started_at, finished_at

sync_job_items
  job_id, instrument_id, status, attempts, error_code, error_message

data_quality_issues
  id, instrument_id, trade_date, rule_code, severity,
  status, details, detected_at, resolved_at
```

关键索引：

- `instruments(market, symbol, type)` 唯一；
- `daily_candles(instrument_id, trade_date, source_id)` 唯一；
- `trading_calendar(market, trade_date)` 唯一；
- `sync_jobs(status, created_at)`；
- `data_quality_issues(status, severity, detected_at)`。

## 7. API 与页面设计

### 7.1 服务端 API

```text
GET    /api/instruments
GET    /api/instruments/:id
GET    /api/instruments/:id/candles
GET    /api/market-data/freshness

POST   /api/sync/instruments
POST   /api/sync/calendars
POST   /api/sync/history
POST   /api/sync/incremental
GET    /api/sync/jobs
GET    /api/sync/jobs/:id
POST   /api/sync/jobs/:id/cancel
POST   /api/sync/jobs/:id/retry

GET    /api/data-quality/issues
POST   /api/data-quality/issues/:id/resolve
POST   /api/data-quality/recheck
```

所有写操作进行 Zod 校验；日期范围、证券数量和单任务规模设置硬上限。

### 7.2 数据管理页面

桌面端分为三个区域：

1. 证券数据：证券列表、数据范围、新鲜度和质量状态；
2. 同步任务：新建任务、实时进度、失败原因、取消和重试；
3. 数据质量：缺失、异常和阻断问题的筛选与处理。

交互要求：

- 首屏明确展示最新交易日、已更新证券数和异常数；
- 新建历史回补任务前展示证券数量、日期跨度和预计请求量；
- 大规模任务必须二次确认；
- 进度采用轮询或服务端事件增量更新，不频繁刷新整张表；
- 状态除颜色外同时使用文字和图标表达；
- 移动端保留状态查看和单任务操作，不强塞宽表；
- 所有外部数据均标明来源和最后获取时间。

## 8. 实施顺序与工作量

### 阶段 0：数据协议与数据库设计（3～4 人日）

- 冻结证券、交易日、日线和复权数据口径；
- 设计 Provider 接口、错误模型和能力声明；
- 完成数据表、索引、迁移和 Repository；
- 准备固定 Mock 数据和人工核对样例。

### 阶段 1：首个数据源与历史回补（5～7 人日）

- 数据源配置和凭据安全；
- 证券列表、交易日历和日线适配；
- 分页、限流、重试和标准化；
- 单证券及批量历史回补。

### 阶段 2：增量调度与任务系统（4～6 人日）

- 增量窗口和交易日判断；
- 任务、任务明细、进度和取消；
- 定时执行、任务锁和服务重启恢复；
- 失败分类与定向重试。

### 阶段 3：复权与数据质量（4～5 人日）

- 复权因子存储和派生序列；
- 完整性、合法性和异常规则；
- 质量问题处理和重新检查；
- 数据版本、checksum 和回测快照关联。

### 阶段 4：前端管理与验收（4～5 人日）

- 证券数据、同步任务和质量问题界面；
- 行情分析、回测和实验的数据选择接入；
- 性能、失败恢复和安全验收；
- README、配置示例和运维说明。

预计总工作量：20～27 人日。建议先交付 P0 + P1，稳定运行一段时间后再启用自动定时更新。

## 9. 测试计划

### 9.1 单元测试

- 各市场证券代码映射和日期转换；
- Provider 响应标准化、分页和空结果；
- OHLC、成交量、成交额和复权因子校验；
- 交易日历缺失检测和停牌豁免；
- 增量起点、重叠窗口和幂等 upsert；
- 限流、超时、指数退避和不可重试错误；
- 任务状态流转、取消和服务重启恢复；
- checksum、数据版本和复权结果稳定。

### 9.2 集成与回归

- Mock Provider 到 MySQL 的完整同步链路；
- 同一历史任务重复执行不增加重复记录；
- 单个证券失败不影响其他证券提交；
- 中途取消和进程异常后不存在半完成任务状态；
- 原始、前复权和后复权数据与人工样例一致；
- 自动同步数据可直接用于行情分析、策略回测和参数实验；
- 手工导入数据仍可读取、导出和回测；
- 数据库迁移不破坏第四阶段及 4.5 阶段数据。

### 9.3 性能与稳定性

- 记录 100、1,000 和全市场证券一年增量更新的耗时；
- 批量写入期间服务健康检查和普通查询保持可用；
- 百万级日线记录分页查询无明显卡顿；
- 任务进度更新不产生高频数据库写放大；
- 模拟限流、断网、数据库断开和供应商异常响应；
- 连续多日自动调度不重复执行、不漏交易日。

## 10. 验收标准

- [ ] 至少一个数据源适配器可以同步证券、交易日历、日线和复权因子；
- [ ] 用户可以创建历史回补任务并查看准确进度；
- [ ] 系统可以按交易日执行每日增量更新；
- [ ] 重复执行相同任务不会生成重复行情；
- [ ] 原始行情、前复权和后复权口径明确且结果可核对；
- [ ] 停牌、休市和真实缺失数据能够正确区分；
- [ ] 数据质量问题具有通过、警告和阻断状态；
- [ ] 单证券失败不会中断整个同步批次，并可单独重试；
- [ ] 数据源限流、断网和鉴权失败均有稳定错误状态；
- [ ] 回测结果记录数据来源、复权模式和版本；
- [ ] 手工导入数据与自动同步数据可以并存且来源清晰；
- [ ] 密钥不进入前端、日志、数据库迁移和 Git 历史；
- [ ] 前端测试、类型检查、生产构建和服务端类型检查通过；
- [ ] README 更新数据源配置、同步、修复和故障排查说明。

## 11. 阶段交付物

- `MarketDataProvider` 协议和首个数据源适配器；
- 证券、交易日历、日线、复权、任务和质量问题数据库结构；
- 历史回补、增量更新、调度、重试和任务锁；
- 数据标准化、复权计算和质量检查模块；
- 证券数据、同步任务和数据质量管理界面；
- 行情分析、回测和参数实验的自动数据接入；
- Mock Provider、自动化测试和性能基准；
- 更新后的环境配置、README 和运维文档。

## 12. 第五阶段后的候选方向

第五阶段稳定运行后，第六阶段建议进入“量化因子研究平台”：

1. 因子定义、版本和批量计算；
2. 截面去极值、标准化及行业/市值中性化；
3. IC、Rank IC、分层收益和因子衰减；
4. 换手率、交易成本与可交易性过滤；
5. 多因子合成、样本外验证和研究报告；
6. 指数历史成分与财务数据的时点化管理。

在进入因子研究前，建议第五阶段至少连续稳定完成若干个交易日的自动更新，并完成一次全市场数据质量审计。
