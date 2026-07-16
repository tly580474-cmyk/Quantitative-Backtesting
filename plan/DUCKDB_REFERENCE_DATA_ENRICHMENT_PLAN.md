# DuckDB 研究数据补全开发计划

## 1. 计划定位

本计划用于补全当前 DuckDB/Parquet 研究层缺少的四类关键数据：

1. 复权参数；
2. 股票估值与分红；
3. 指数行情；
4. 指数成分股及其权重历史。

MySQL 继续作为权威事实层，Parquet 作为可重建、可校验、可版本化的研究快照，DuckDB 只读取已发布快照。任何在线接口结果都必须先完成标准化、质量校验和原子发布，不能直接覆盖研究数据。

### 执行状态（2026-07-16）

- M1 复权与估值视图：已完成；
- M2 指数行情：已完成首批 9 个 A 股指数历史回补与每日增量；
- M3 指数成分与权重：已完成当前批次采集、版本留存和 SCD 查询；
- M4 分红事实层：采集、幂等入库、失败重试和轮换刷新已上线；全市场历史数据由每日 200 只证券的可恢复任务继续回补；
- M5 自动发布与运维：计划任务、状态报告、快照校验和查询文档已上线，进入连续运行观察期。

当前实现和查询方式见 [REFERENCE_DATA_USAGE.md](../doc/REFERENCE_DATA_USAGE.md)。

## 2. 当前数据基线

审计日期：`2026-07-16`。

| 数据项 | MySQL 当前状态 | DuckDB 当前状态 | 结论 |
| --- | --- | --- | --- |
| 日线行情 | `daily_bars_v2` 共 17,079,875 行，更新至 2026-07-15 | `bars` 更新至 2026-07-13 | 快照自动发布存在滞后 |
| PE | 17,076,963 个非空值，覆盖率约 99.98% | 已包含 `peTtm` | 无需重新采集，需保证每日快照更新 |
| PB | 17,072,806 个非空值，覆盖率约 99.96% | 已包含 `pb` | 无需重新采集，需保证每日快照更新 |
| 复权参数 | `adjustment_factors_v2` 共 58,535 行，覆盖 5,824 只证券 | 无独立视图 | 从 MySQL 导出独立事实集 |
| 分红 | `corporate_actions` 仅 8 条推断记录 | 无 | 不能视为完整分红数据，需要正式回补 |
| 指数行情 | 8 个指数数据集、20,719 根日线 | 无 | 需要标准化并进入研究快照 |
| 指数成分 | 无专用表 | 无 | 需要新增批次与成员历史表 |

现有复权参数包含 `factor` 与 `price_offset`。价格复权必须继续使用仿射变换：

```text
adjusted_price = raw_price × factor + price_offset
```

不得只导出乘数而丢失现金分红形成的价格偏移。

## 3. 数据源与接口边界

### 3.1 复权参数与估值

- 权威源：现有 MySQL。
- 复权参数：`adjustment_factors_v2`、`adjustment_factor_publications`。
- 每日估值：`daily_stock_metrics`。
- DuckDB 中的 PE、PB 默认继续来自日线研究快照，不重复保存第二份全量估值文件。
- 增加 `stock_valuations` 视图，作为 `bars` 中估值字段的稳定查询入口。

### 3.2 分红

首轮回补优先使用 AkShare 的分红配送明细接口，保留原始来源字段和原始方案文本。标准化后至少包含：

- 报告期；
- 公告日；
- 股权登记日；
- 除权除息日；
- 每股现金分红；
- 每股送股比例；
- 每股转增比例；
- 方案状态；
- 来源、抓取时间和源数据指纹。

不得用价格缺口推断值覆盖正式分红记录。现有 `corporate_actions` 只作为交叉校验和异常发现来源。

### 3.3 指数行情

优先复用现有 `market_datasets` 与 `candles` 中的指数行情，再补齐缺失指数。第一批目标指数：

| 指数代码 | 指数名称 |
| --- | --- |
| 000001 | 上证指数 |
| 399001 | 深证成指 |
| 399006 | 创业板指 |
| 000300 | 沪深300 |
| 000905 | 中证500 |
| 000852 | 中证1000 |
| 932000 | 中证2000 |
| 000688 | 科创50 |
| 000680 | 科创综指 |

指数行情必须保存 OHLC、成交量、成交额、涨跌额、涨跌幅、来源和终态标记。指数代码需要同时保存交易所/供应商代码，禁止仅凭六位代码猜测市场。

### 3.4 指数成分和权重

计划使用以下 AkShare 接口：

- `ak.index_stock_cons()`：部分指数的最新成分；
- `ak.index_stock_cons_csindex()`：中证网站当前发布的成分目录；
- `ak.index_stock_cons_weight_csindex()`：中证网站当前发布的成分权重。

接口验证表明，同一指数的三个结果可能分别对应不同日期。例如沪深300实测出现 `2026-06-15`、`2026-07-15` 和 `2026-06-30` 三个批次日期。因此：

1. 成分日期与权重日期必须分别保存；
2. 不允许用抓取日期替代来源批次日期；
3. 不允许把最新权重写入更早或更晚的成分批次；
4. 只有指数代码、成分代码和来源日期均一致时才能直接合并；
5. 权重缺失时保留 `NULL`，不得平均分配伪造权重。

`index_stock_cons_csindex(symbol)` 没有历史日期参数，它返回当前可下载批次，并不能查询任意历史时点。历史数据采用以下两条路径：

- 从上线日起持续留存每个新批次，形成可靠的版本历史；
- 另行寻找中证官方历史成分文件进行回补，回补数据必须标注独立来源。

参考文档：

- [AkShare 指数数据](https://akshare.akfamily.xyz/data/index/index.html)
- [AkShare 股票与分红数据](https://akshare.akfamily.xyz/data/stock/stock.html)

## 4. 目标数据模型

### 4.1 `dividend_events`

建议主键：`instrument_key + report_period + ex_date + source_key`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| instrument_key | INT UNSIGNED | 证券内部键 |
| report_period | VARCHAR(32) | 年报、中报等报告期 |
| announcement_date | DATE NULL | 公告日 |
| record_date | DATE NULL | 股权登记日 |
| ex_date | DATE NULL | 除权除息日 |
| cash_dividend_per_share | DOUBLE NULL | 每股现金分红，单位元 |
| bonus_share_per_share | DOUBLE NULL | 每股送股比例 |
| transfer_share_per_share | DOUBLE NULL | 每股转增比例 |
| plan_status | VARCHAR(32) | 预案、实施、取消等 |
| raw_plan | VARCHAR(1000) NULL | 原始方案文本 |
| source_key | VARCHAR(32) | 数据源 |
| source_fingerprint | VARCHAR(64) | 幂等指纹 |
| fetched_at | DATETIME(3) | 抓取时间 |

### 4.2 `index_definitions`

保存指数代码、名称、英文名称、发布机构、市场、币种、基日、启用状态和供应商代码映射。

### 4.3 `index_daily_bars`

建议主键：`index_key + trade_date`。字段包括 OHLC、成交量、成交额、涨跌额、涨跌幅、来源版本、抓取时间和 `is_final`。

### 4.4 `index_constituent_snapshots`

每次来源批次对应一条快照记录：

| 字段 | 说明 |
| --- | --- |
| snapshot_id | 快照唯一标识 |
| index_key | 指数内部键 |
| constituent_date | 来源成分日期 |
| weight_date | 来源权重日期，可为空 |
| source_key | 来源接口 |
| source_checksum | 规范化成员集合校验和 |
| fetched_at | 抓取时间 |
| member_count | 成分数量 |
| weight_sum_pct | 权重合计，可为空 |
| status | staged、validated、published、rejected |

### 4.5 `index_constituent_members`

建议主键：`snapshot_id + instrument_key`。保存成分证券、交易所、成分名称、权重和来源原始代码。

对外提供 SCD2 兼容视图，字段至少包括：

```text
indexCode
constituentCode
effectiveFrom
effectiveTo
constituentDate
weightDate
weightPct
source
snapshotId
```

`effectiveTo` 由同一指数下一批已发布快照推导；最新批次保持 `NULL`。

## 5. Parquet 与 DuckDB 设计

已发布研究数据增加以下逻辑数据集：

```text
bars/                         股票日线与每日估值
adjustment_factors/           复权参数
dividend_events/              分红事件
index_bars/                   指数日线
index_constituent_snapshots/  指数成分快照元数据
index_constituents/           指数成分明细
```

DuckDB CLI 自动注册以下视图：

- `bars`；
- `stock_valuations`；
- `adjustment_factors`；
- `dividend_events`；
- `index_bars`；
- `index_constituent_snapshots`；
- `index_constituents`；
- `index_constituents_scd`。

`stock_valuations` 从 `bars` 投影生成，不重复写入 1,700 万行估值文件。建议字段为：

```sql
SELECT instrumentKey, market, symbol, name, tradeDate,
       close, totalMarketCap, floatMarketCap, peTtm, pb, psTtm
FROM bars
```

复权、分红和指数数据可以作为独立小型快照发布，避免每次更新都重写全部股票日线历史。主研究快照通过版本指针引用各子快照版本，查询结果需要返回所使用的版本集合。

## 6. 自动更新流程

### 6.1 每日盘后流程

```text
MySQL 股票日线与估值终态确认
  → 更新指数日线
  → 拉取分红增量
  → 检查复权参数新版本
  → 拉取指数成分与权重批次
  → 标准化与交叉校验
  → 生成 Parquet 临时文件
  → DuckDB 行数、主键、日期和聚合校验
  → 原子发布子快照和总版本指针
```

建议调度：

| 时间 | 工作 |
| --- | --- |
| 15:30 | 日线与估值终态同步 |
| 16:10 | 指数行情增量更新 |
| 16:30 | 分钟数据更新 |
| 17:00 | 分红、复权参数、指数成分增量更新 |
| 17:30 | 失败任务重试 |
| 18:00 | 构建并发布 DuckDB 研究快照 |
| 18:30 | 全量状态与滞后检查 |

任务需要具备幂等性、单实例锁、超时、有限重试、日志轮转和 `StartWhenAvailable`。同一来源批次校验和未变化时不重复发布。

### 6.2 初始回补

1. 从 MySQL 全量导出复权参数；
2. 从现有指数数据集迁移指数行情；
3. 补齐第一批目标指数历史行情；
4. 抓取第一批指数当前成分和权重快照；
5. 对全市场分红执行可恢复的分批回补；
6. 每批记录游标、成功数、失败数和错误样本；
7. 全量回补完成前，DuckDB 明确标注分红数据的覆盖范围。

分红全量回补不得在单次计划任务中串行请求全部证券。建议按 100～200 只证券分片，并支持断点续传。

## 7. 数据质量规则

### 7.1 通用规则

- 主键重复数必须为 0；
- 日期必须合法且不晚于抓取时已终态日期；
- 所有数值字段拒绝 `NaN` 和无穷值；
- 半成品文件不得匹配正式 DuckDB 通配符；
- manifest 行数、文件大小和 SHA-256 必须与文件一致；
- 失败批次不得更新 `current.json`。

### 7.2 复权参数

- `factor` 必须为有限正数；
- `price_offset` 必须为有限数；
- 同一证券、版本、生效日期不得重复；
- 抽样重建前复权价格，与现有已验证样本按价格最小变动单位对账；
- 发布版本必须来自 `adjustment_factor_publications` 或明确标记的历史版本。

### 7.3 估值与分红

- PE、PB 保留负值语义，不将亏损公司 PE 强制改成 0；
- 缺失值保持 `NULL`；
- 现金分红、送股和转增比例不得为负；
- 相同分红事件多来源冲突时保留来源记录并生成质量告警；
- 除权日附近的复权参数变化只作交叉验证，不自动修改正式分红金额。

### 7.4 指数行情和成分

- OHLC 满足 `high >= max(open, close)`、`low <= min(open, close)`；
- 成分数量与指数预期数量进行软校验，例如沪深300应接近 300；
- 成分代码必须能映射到 `instruments`，无法映射的成员进入隔离表；
- 权重必须非负，权重总和偏离 100% 时记录来源日期和告警；
- 同一指数相邻批次成员完全一致时可以不发布新成员明细，但仍保留来源批次元数据；
- 成分日期与权重日期不一致时禁止无标记合并。

## 8. 实施里程碑

### M1：复权与估值视图（P0）

- 从 MySQL 导出 `adjustment_factors` Parquet；
- 在 DuckDB 注册 `adjustment_factors` 和 `stock_valuations`；
- 修复股票研究快照盘后自动发布；
- 增加复权抽样重建测试。

验收：DuckDB 可按证券和日期查询复权参数；`bars` 最大日期与 MySQL 最终日线一致。

### M2：指数行情（P0）

- 建立指数定义和指数日线标准模型；
- 迁移现有 8 个指数数据集；
- 补齐第一批缺失指数；
- 注册 `index_bars` 视图并接入每日增量更新。

验收：目标指数日期连续、主键无重复，最新终态交易日与股票交易日历一致。

### M3：指数成分与权重（P0）

- 建立快照和成员表；
- 实现三个 AkShare 接口适配器；
- 保存来源日期、权重日期、原始交易所和校验和；
- 实现 SCD2 查询视图和每日变更检测。

验收：沪深300等目标指数可以查询任意已留存批次的成员；权重不会跨批次静默错配。

### M4：分红事实层（P1）

- 建立分红事件表和来源映射；
- 实现可恢复的全市场历史回补；
- 实现每日公告增量更新；
- 与复权参数、除权日和价格缺口进行质量交叉验证。

验收：能够按股票查询完整已覆盖区间的现金分红、送转和除权日期，并明确展示覆盖起止日期。

### M5：统一自动发布与运维（P0）

- 将四类数据纳入盘后任务编排；
- 建立子快照和总版本指针；
- 增加状态、滞后、失败和覆盖率报告；
- 更新 DuckDB CLI 文档与常用查询样例。

验收：连续多个交易日无需人工下载或手动刷新，失败时不发布半成品，补跑后可以幂等恢复。

## 9. 测试与验收清单

- [x] MySQL 新表迁移可重复执行；
- [x] 复权参数 Parquet 行数与当前发布版本一致；
- [x] PE/PB 非空覆盖率未因快照生成下降；
- [x] 分红事件标准化单位经过样本核对；
- [x] 指数行情 OHLC 与日期连续性通过校验；
- [x] 指数成分成员数、代码映射和权重合计通过校验；
- [x] 成分日期与权重日期差异在查询结果中可见；
- [x] DuckDB 目标视图均可查询；
- [x] 快照校验能发现缺文件、行数变化和校验和错误；
- [x] 计划任务失败不会更新当前版本指针；
- [x] 计划任务补跑不会产生重复记录；
- [x] 文档包含复权、估值、分红、指数行情和指数成分查询样例。

## 10. 明确不做的事项

- 不把 AkShare 当前批次描述为完整历史成分；
- 不伪造缺失权重或分红金额；
- 不让 DuckDB 直接写回 MySQL；
- 不因新增参考数据而重复保存整份日线估值事实；
- 不在正式文件路径发布未校验的临时 Parquet；
- 不保证第三方公开接口的 SLA，必须保留重试、缓存、版本和回补能力。

## 11. 最终交付物

1. MySQL 表迁移和数据源适配器；
2. 复权参数、分红、指数行情和指数成分 Parquet 数据集；
3. DuckDB 自动注册视图；
4. 初始回补与每日增量 CLI；
5. Windows 盘后计划任务；
6. 数据质量与原子发布测试；
7. DuckDB 查询和运维文档；
8. 首次全量回补验收报告。
