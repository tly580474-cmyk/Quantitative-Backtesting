# 本地 DuckDB CLI 使用说明

本文档说明如何在不启动后端服务的情况下，通过 `server` 提供的 DuckDB CLI 查询本地 Parquet 研究数据：

- 已发布的股票日线、估值、复权、分红、指数行情和指数成分研究快照；
- 2010 年至今的 1 分钟行情湖，通过 `read_parquet(...)` 按日期直接读取。

CLI 支持直接 SQL、SQL 文件、JSON/CSV 输出和持久 DuckDB 文件，适合临时研究、数据核验与批量导出。

数据职责边界：

```text
MySQL / 在线数据源 / 分钟数据湖
  → 标准化、质量校验和 Parquet 发布
  → current.json 原子切换
  → DuckDB CLI 只读查询
```

DuckDB 不是权威写入层。需要修正数据时应修正上游 MySQL、采集程序或 Parquet 发布流程，不应直接修改 CLI 临时视图。

## 1. 入口位置

进入后端目录：

```powershell
cd D:\github_public_repo\量化回测\server
```

查看帮助：

```powershell
npm run duckdb -- help
```

CLI 源码位于：

```text
server/src/research/duckdbCli.ts
```

## 2. 数据模型

### 2.1 已发布研究快照

CLI 默认读取：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
```

如果存在已发布快照，CLI 会读取 `current.json` 指向的版本，并自动注册以下只读视图：

| 视图 | 内容 | 主要日期字段 |
| --- | --- | --- |
| `bars` | 股票日线、成交数据及每日估值 | `tradeDate` |
| `stock_valuations` | 从 `bars` 投影的 PE、PB、PS、市值 | `tradeDate` |
| `adjustment_factors` | 已发布复权乘数和价格偏移 | `effectiveDate` |
| `index_bars` | 指数日线 OHLC、成交量和成交额 | `tradeDate` |
| `index_constituent_snapshots` | 指数成分及权重来源批次 | `constituentDate`、`weightDate` |
| `index_constituents` | 指数成分成员与权重明细 | `constituentDate`、`weightDate` |
| `index_constituents_scd` | 按来源批次推导的成员有效区间 | `effectiveFrom`、`effectiveTo` |
| `dividend_events` | 现金分红、送股和转增事件 | `reportPeriod`、`exDate` |

其中 `bars` 的物理路径为：

```text
<RESEARCH_SNAPSHOT_ROOT>/<snapshot-id>/bars/year=*/*.parquet
```

其他参考数据文件位于同一 `<snapshot-id>` 目录，并由 manifest 记录相对路径、行数、大小和 SHA-256。查询这些视图同样不需要手写 `read_parquet(...)`：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, symbol, close FROM bars LIMIT 10"
```

```powershell
npm run duckdb -- query --sql "SELECT indexCode, MAX(tradeDate) AS latestTradeDate FROM index_bars GROUP BY indexCode ORDER BY indexCode"
```

视图是否存在取决于当前已发布快照是否包含对应数据集。旧快照可能只有 `bars`。

### 2.2 1 分钟行情湖

分钟数据不属于研究快照，也不会自动注册为视图。默认位置由以下变量控制：

```dotenv
MINUTE_DATA_ROOT=../../所有股票的历史数据/1m_price_parquet
```

目录结构为：

```text
1m_price_parquet/
├── manifest.json
└── year=<year>/
    └── <YYYYMMDD>.parquet
```

每个 Parquet 文件对应一个交易日。查询时使用正斜杠形式的绝对路径，避免 Windows 反斜杠转义问题：

```sql
SELECT *
FROM read_parquet(
  'D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet'
)
LIMIT 10;
```

当前分钟字段如下：

| 字段 | 含义 |
| --- | --- |
| `code` | 股票代码，格式如 `002155.SZ`、`600519.SH` |
| `trade_time` | 分钟时间，格式 `YYYY-MM-DD HH:mm:ss` |
| `open`, `high`, `low`, `close` | 分钟 OHLC |
| `vol` | 分钟成交量，单位为股 |
| `amount` | 分钟成交额，单位为元 |
| `date` | 交易日，格式 `YYYYMMDD` |
| `pre_close` | 上一根分钟线收盘价；当日首根使用上一交易日收盘价 |
| `change`, `pct_chg` | 相对上一根分钟线的涨跌额、涨跌幅 |
| `__index_level_0__` | 源文件保留的分钟序号，不建议作为跨数据源时间键 |

## 3. 命令列表

### 查看当前研究快照状态

```powershell
npm run duckdb -- status
```

输出包括 `snapshotId`、`publishedAt`、`rowCount`、`instrumentCount`、股票日线日期范围、分区数和参考数据集数量。这里的 `maxDate` 是股票日线最大日期，不代表指数行情、分红或指数成分的最大日期。

该命令不描述分钟湖；分钟湖范围以分钟湖的 `manifest.json` 或 HTTP 目录接口为准。

### 查看研究视图字段结构

```powershell
npm run duckdb -- schema
```

该命令等价于 `DESCRIBE bars`。查看所有自动注册视图：

```powershell
npm run duckdb -- query --sql "SHOW TABLES"
```

查看某个参考数据视图的字段：

```powershell
npm run duckdb -- query --sql "DESCRIBE adjustment_factors"
```

```powershell
npm run duckdb -- query --sql "DESCRIBE index_constituents_scd"
```

查看分钟字段时直接执行：

```powershell
npm run duckdb -- query --no-snapshot-view --sql "DESCRIBE SELECT * FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet')"
```

### 执行 SQL

直接传入 SQL：

```powershell
npm run duckdb -- query --sql "SELECT market, COUNT(*) AS rows FROM bars GROUP BY market"
```

从文件读取 SQL：

```powershell
npm run duckdb -- query --file ./queries/latest-close.sql
```

分钟查询通常加 `--no-snapshot-view`，避免无关的日线快照注册：

```powershell
npm run duckdb -- query --no-snapshot-view --file ./queries/minute-check.sql
```

如果 `query` 未传入 `--sql` 或 `--file`，已挂载快照时会显示最近 20 条日线；使用 `--no-snapshot-view` 时只返回当前日期时间。

注意，子命令必须写在参数之前。正确写法是：

```powershell
npm run duckdb -- query --sql "SELECT COUNT(*) FROM bars"
```

以下写法会把 `--sql` 误识别为命令并返回“未知命令”：

```text
npm run duckdb -- --sql "SELECT COUNT(*) FROM bars"
```

## 4. 输出格式

默认输出表格：

```powershell
npm run duckdb -- query --sql "SELECT symbol, close FROM bars LIMIT 5"
```

输出 JSON：

```powershell
npm run duckdb -- query --format json --sql "SELECT symbol, close FROM bars LIMIT 5"
```

输出 CSV：

```powershell
npm run duckdb -- query --format csv --sql "SELECT symbol, close FROM bars LIMIT 5"
```

导出到文件：

```powershell
npm run duckdb -- query --sql "SELECT * FROM bars LIMIT 1000" --out ./out/sample.csv
```

当 `--out` 后缀为 `.csv` 或 `.json` 时，CLI 会自动推断格式。

## 5. 常用参数

| 参数 | 说明 |
| --- | --- |
| `--sql`, `-q` | 直接传入 SQL |
| `--file` | 从文件读取 SQL |
| `--out`, `-o` | 写入结果文件 |
| `--format`, `-f` | `table`、`json`、`csv` |
| `--db` | DuckDB 数据库路径，默认 `:memory:` |
| `--snapshot-root` | 日线研究快照目录 |
| `--no-snapshot-view` | 不自动创建日线 `bars` 视图 |
| `--threads` | DuckDB 线程数，默认 `4` |
| `--max-memory` | DuckDB 内存上限，例如 `1GB` |

## 6. 日线查询示例

查看最近交易日：

```powershell
npm run duckdb -- query --sql "SELECT MAX(tradeDate) AS latestTradeDate FROM bars"
```

按市场统计：

```powershell
npm run duckdb -- query --sql "SELECT market, COUNT(*) AS rows FROM bars GROUP BY market ORDER BY market"
```

导出某天收盘价：

```powershell
npm run duckdb -- query --out ./out/close-2026-07-09.csv --sql "SELECT market, symbol, name, tradeDate, close FROM bars WHERE tradeDate = '2026-07-09' ORDER BY market, symbol"
```

## 7. 估值、复权、分红和指数查询

### 7.1 查询股票估值

查询湖南黄金最近 10 个交易日的估值：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, close, totalMarketCap, floatMarketCap, peTtm, pb, psTtm FROM stock_valuations WHERE symbol='002155' ORDER BY tradeDate DESC LIMIT 10"
```

PE、PB 缺失时保持 `NULL`。亏损公司的负 PE 保留原始语义，不应在查询中强制替换成 0。

### 7.2 查询复权参数

```powershell
npm run duckdb -- query --sql "SELECT effectiveDate, factor, priceOffset, factorVersion FROM adjustment_factors WHERE symbol='002155' ORDER BY effectiveDate"
```

本项目的复权价格是仿射变换，不是单纯乘法：

```text
adjusted_price = raw_price × factor + priceOffset
```

现金分红可能形成非零 `priceOffset`。不得只使用 `factor` 而丢弃价格偏移。

### 7.3 查询指数行情和涨跌幅

查询沪深300最近 20 个交易日的源字段：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, open, high, low, close, change, changePercent, volume, amount FROM index_bars WHERE indexCode='000300' ORDER BY tradeDate DESC LIMIT 20"
```

增量更新器会从数据库读取前一交易日收盘价，并自动修复已有的非首日空涨跌幅。每个指数历史第一行因为不存在前收盘价，`change`、`changePercent` 保持 `NULL`。需要独立复核某日涨跌幅时，可以在完整指数历史上使用 `LAG(close)` 重新计算，再过滤目标日期：

```powershell
npm run duckdb -- query --sql "WITH returns AS (SELECT indexCode, indexName, tradeDate, close, 100 * (close / LAG(close) OVER (PARTITION BY indexCode ORDER BY tradeDate) - 1) AS calculatedChangePercent FROM index_bars) SELECT indexCode, indexName, close, calculatedChangePercent FROM returns WHERE tradeDate='2026-07-16' ORDER BY calculatedChangePercent DESC"
```

### 7.4 查询指数成分与权重

先查看沪深300已留存的来源批次：

```powershell
npm run duckdb -- query --sql "SELECT snapshotId, constituentDate, weightDate, memberCount, weightSumPct, sourceKey, fetchedAt FROM index_constituent_snapshots WHERE indexCode='000300' ORDER BY constituentDate DESC, weightDate DESC NULLS LAST"
```

查询最新权重批次的前十大成分时，必须先锁定一个 `snapshotId`，避免把多个批次混在一起排序：

```powershell
npm run duckdb -- query --sql "WITH latest AS (SELECT snapshotId FROM index_constituent_snapshots WHERE indexCode='000300' AND weightDate IS NOT NULL ORDER BY weightDate DESC, fetchedAt DESC LIMIT 1) SELECT constituentCode, constituentName, weightPct, constituentDate, weightDate FROM index_constituents INNER JOIN latest USING (snapshotId) ORDER BY weightPct DESC NULLS LAST LIMIT 10"
```

查询一只股票在某日属于哪些已留存指数：

```powershell
npm run duckdb -- query --sql "WITH matches AS (SELECT indexCode, indexName, constituentCode, effectiveFrom, effectiveTo, weightPct, sourceKey FROM index_constituents_scd WHERE constituentCode='002155' AND DATE '2026-07-15' >= effectiveFrom AND (effectiveTo IS NULL OR DATE '2026-07-15' <= effectiveTo)), ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY indexCode, constituentCode ORDER BY (weightPct IS NOT NULL) DESC, effectiveFrom DESC, sourceKey) AS rn FROM matches) SELECT * EXCLUDE (rn) FROM ranked WHERE rn=1 ORDER BY indexCode"
```

`effectiveTo` 是同一指数、同一来源的下一批 `constituentDate` 减一天。当前批次的 `effectiveTo` 为 `NULL`。

系统会分别留存成分文件和权重文件，因此同一指数可能同时出现两个 `sourceKey`。上述查询优先返回带权重的来源记录，并按 `indexCode` 去重；需要审计原始来源时应去掉 `ROW_NUMBER()` 筛选，保留全部记录。

成分日期和权重日期可能不同：

- `constituentDate`：来源文件声明的成分日期；
- `weightDate`：权重文件声明的日期，无权重时为 `NULL`；
- `fetchedAt`：本机抓取时间。

系统不会把最新权重静默写入日期不同的成分批次。目前只保证查询已经留存的批次；AkShare 当前批次接口不能提供任意历史日期，更早的完整历史成分仍需官方历史文件回补。

### 7.5 查询分红历史

```powershell
npm run duckdb -- query --sql "SELECT reportPeriod, announcementDate, recordDate, exDate, cashDividendPerShare, bonusSharePerShare, transferSharePerShare, planStatus FROM dividend_events WHERE symbol='002155' ORDER BY reportPeriod DESC"
```

现金分红、送股和转增的源接口单位为“每 10 股”，入库后统一为“每股”。例如 `cashDividendPerShare = 0.3` 表示每股现金分红 0.3 元。

分红历史仍在按批次回补。查询当前覆盖率：

```powershell
npm run reference:status
```

单只股票没有结果可能表示尚未轮到回补，不应直接解释为该公司从未分红。

全市场当前报告期接口会提高最新方案的覆盖速度，单股明细接口负责补齐更早历史。两类来源按业务键合并，因此查询结果不会因为来源不同重复展示同一分红方案。

### 7.6 联合查询示例

查询股票收盘价、估值以及当天是否除权除息：

```powershell
npm run duckdb -- query --sql "SELECT bar.tradeDate, bar.symbol, bar.close, bar.peTtm, bar.pb, dividend.cashDividendPerShare, dividend.bonusSharePerShare, dividend.transferSharePerShare FROM stock_valuations AS bar LEFT JOIN dividend_events AS dividend ON dividend.symbol=bar.symbol AND dividend.exDate=bar.tradeDate WHERE bar.symbol='002155' ORDER BY bar.tradeDate DESC LIMIT 30"
```

当前研究快照尚未提供独立的行业/概念板块成分和板块行情视图。`index_constituents_scd` 只能回答已接入指数的归属；行业、概念板块归属及其涨跌幅需要后续新增专用数据集，不能用指数成分替代。

## 8. 分钟行情查询示例

以下示例使用变量中的实际绝对路径。若数据目录不同，请替换路径。

### 查询单股单日分时

```powershell
npm run duckdb -- query --no-snapshot-view --sql "SELECT trade_time, open, high, low, close, vol, amount FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet') WHERE code = '002155.SZ' ORDER BY trade_time"
```

### 核对分钟数量与时间范围

```powershell
npm run duckdb -- query --no-snapshot-view --format json --sql "SELECT code, MIN(trade_time) AS first_time, MAX(trade_time) AS last_time, COUNT(*) AS minute_rows, SUM(vol) AS volume FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet') WHERE code = '002155.SZ' GROUP BY code"
```

通达信增量数据通常返回 240 根，时间为 09:31–15:00；旧年度源通常为 241 根并包含 09:30。不要使用固定行号判断分钟时间。

### 从分钟线聚合日线

```powershell
npm run duckdb -- query --no-snapshot-view --sql "SELECT code, first(open ORDER BY trade_time) AS open, MAX(high) AS high, MIN(low) AS low, last(close ORDER BY trade_time) AS close, SUM(vol) AS volume, SUM(amount) AS amount FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet') WHERE code = '002155.SZ' GROUP BY code"
```

### 查询一个月并导出 CSV

```powershell
npm run duckdb -- query --no-snapshot-view --out ./out/002155-2026-07.csv --sql "SELECT trade_time, open, high, low, close, vol, amount FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/202607*.parquet') WHERE code = '002155.SZ' ORDER BY trade_time"
```

### 同时读取指定的多个交易日

```sql
SELECT code, trade_time, close, vol
FROM read_parquet([
  'D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260714.parquet',
  'D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=2026/20260715.parquet'
])
WHERE code = '002155.SZ'
ORDER BY trade_time;
```

多行 SQL 建议保存为 `.sql` 文件后使用 `--file` 执行。

### 创建可复用的分钟视图

使用持久 DuckDB 文件可以保存视图定义：

```powershell
npm run duckdb -- query --no-snapshot-view --db ./data/local-research.duckdb --sql "CREATE OR REPLACE VIEW minute_bars AS SELECT * FROM read_parquet('D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=*/*.parquet', hive_partitioning = true)"
```

随后查询：

```powershell
npm run duckdb -- query --no-snapshot-view --db ./data/local-research.duckdb --sql "SELECT trade_time, close, vol FROM minute_bars WHERE year = 2026 AND code = '002155.SZ' AND date = '20260715' ORDER BY trade_time"
```

该视图不会复制 Parquet 数据，只保存读取路径。移动分钟湖后需要重建视图。

## 9. 性能建议

- 分钟湖体量较大，优先指定单日文件或较窄的文件通配符，不要默认扫描 `year=*/*.parquet`。
- 查询必须尽量包含 `code`、日期范围和必要的 `LIMIT`。
- 多日查询优先明确列出文件，或按年月使用 `202607*.parquet`，让文件裁剪发生在扫描前。
- 只选择需要的列，避免 `SELECT *` 导出全市场分钟明细。
- 大查询可使用 `--threads` 和 `--max-memory` 控制资源，例如 `--threads 8 --max-memory 4GB`。
- CLI 会把最终结果读入 Node.js 后再格式化；聚合可交给 DuckDB，但不要把数千万明细行直接输出到终端或 JSON。
- `bars` 已按年份拆分。包含 `tradeDate` 范围过滤可以减少分区扫描。
- 指数、复权、成分和分红数据集相对较小，可以直接扫描；连接多个成分快照时仍应先锁定 `snapshotId` 或有效日期。
- 只需要分钟数据时使用 `--no-snapshot-view`，可以省去研究快照视图注册。

## 10. 使用持久 DuckDB 文件

默认 `--db` 为 `:memory:`。需要保存表、视图或中间结果时可指定数据库文件：

```powershell
npm run duckdb -- query --db ./data/local-research.duckdb --sql "CREATE OR REPLACE TABLE latest AS SELECT * FROM bars WHERE tradeDate = (SELECT MAX(tradeDate) FROM bars)"
```

持久库中的物化表不会随 Parquet 自动更新；视图会在下次查询时读取路径中的最新文件。

## 11. DuckDB 的自动更新行为

DuckDB 在本项目中是查询层，不是行情采集器。它不会主动连接通达信、Tushare 或 MySQL，也不会自行生成 Parquet。所谓“自动看到新数据”，取决于查询对象是视图还是物化表：

| 查询对象 | 新数据是否自动可见 | 实际行为 |
| --- | --- | --- |
| CLI 默认的日线 `bars` 视图 | 是，下次执行 CLI 时可见 | 每次命令都会重新读取当前快照指针，并为本次连接注册最新已发布快照 |
| SQL 中直接 `read_parquet(...)` | 是，下次查询时可见 | 每次查询重新读取指定路径；精确文件路径只读取该文件，通配符会匹配当时存在的文件 |
| 持久库中的 `minute_bars` 视图 | 是 | 视图只保存 SQL 和路径，不复制数据；新发布且符合通配符的 Parquet 会在后续查询中被读取 |
| `CREATE TABLE ... AS SELECT ...` 物化表 | 否 | 创建时复制一份结果，之后不会随 Parquet 或研究快照变化 |
| 导出的 CSV/JSON | 否 | 属于静态文件，需要重新执行导出命令 |

### 11.1 研究快照刷新

`bars` 和参考数据视图都是 CLI 连接内的临时视图。每次运行：

```powershell
npm run duckdb -- query --sql "SELECT MAX(tradeDate) FROM bars"
```

CLI 都会重新读取 `RESEARCH_SNAPSHOT_ROOT` 下的当前快照指针。因此新的研究快照完成发布后，无需修改 DuckDB 文件或重建 CLI 视图，下一次命令会自动查询同一版本中的股票日线和参考数据。

如果某个长时间运行的程序一直保持同一个 DuckDB 连接，则应在快照切换后重新注册视图或重启该进程；本 CLI 每条命令都会新建并关闭连接，不存在这个问题。

### 11.2 分钟湖刷新

分钟数据日常更新由在线拉取器负责：

```powershell
npm run minute:online:update
```

导入器先写临时文件，校验成功后再原子发布正式 `.parquet` 并更新 `manifest.json`。DuckDB 查询的通配符只匹配正式 `.parquet`，不会读取 `.partial` 或 `.tdx-partial` 半成品。

例如持久视图使用：

```sql
read_parquet(
  'D:/github_public_repo/所有股票的历史数据/1m_price_parquet/year=*/*.parquet',
  hive_partitioning = true
)
```

当天文件发布后，下一次查询会自动包含它，不需要重建 `minute_bars`。以下情况需要重建视图：

- `MINUTE_DATA_ROOT` 移动到了其他路径；
- 视图使用的是某个固定日文件，而现在需要读取其他日期；
- Parquet schema 发生不兼容变化。

注意：原始 DuckDB SQL 不读取 `manifest.json` 来决定文件范围，而是按给定路径或通配符扫描。应用层 API 会使用 manifest 控制已发布日期；直接使用 CLI 时应只匹配正式文件。

### 11.3 物化结果刷新

下列命令创建的是静态副本：

```sql
CREATE OR REPLACE TABLE minute_sample AS
SELECT * FROM minute_bars
WHERE year = 2026 AND code = '002155.SZ';
```

分钟湖更新后，`minute_sample` 不会改变。需要主动重建：

```powershell
npm run duckdb -- query --no-snapshot-view --db ./data/local-research.duckdb --sql "CREATE OR REPLACE TABLE minute_sample AS SELECT * FROM minute_bars WHERE year = 2026 AND code = '002155.SZ'"
```

如果目标是始终查询最新数据，优先使用视图；只有需要固定研究截面或加速重复计算时才物化为表，并记录其生成时间与源数据末日。

### 11.4 自动任务的职责边界

Windows 计划任务运行的是数据导入命令，不是 DuckDB 数据库刷新命令：

```powershell
npm run minute:schedule:register
```

默认任务名为 `QuantBacktest-MinuteUpdate`，每天 16:30 自动在线拉取、校验和发布，17:30 再自动重试一次。在线主源失败时才尝试本地 TDX 回补；正常日更不再依赖人工下载 `.lc1`。发布成功后，基于通配符的 DuckDB 视图会在下一次查询时自然看到新文件。

任务执行日志保存在：

```text
server/.logs/minute-data/minute-update.log
```

推荐的盘后链路是：

```text
在线拉取 → 日线与覆盖率校验 → 原子发布 Parquet/manifest → DuckDB 下次查询读取新文件
```

可用以下命令确认在线源、数据库最终交易日和分钟湖是否一致：

```powershell
npm run minute:online:dry-run
```

返回 `status: up-to-date` 代表在线源、最终日线和分钟湖已经对齐。

若数据库交易日历已经出现新的终态交易日，而在线分钟源仍停留在更早日期，任务会返回非零退出码并记录 `status: source-stale`。周末和休市日使用数据库中的最近交易日判断，不会产生虚假滞后告警。

## 12. 与数据更新流程的关系

DuckDB CLI 只负责读取，不构建数据。

日线研究快照更新：

```powershell
npm run snapshot:build
npm run snapshot:verify
npm run snapshot:freshness
```

研究快照还会自动挂载估值、复权参数、指数行情、指数成分和分红视图。盘后自动任务可通过以下命令注册：

```powershell
npm run snapshot:schedule:register
```

默认任务名为 `QuantBacktest-ResearchSnapshot`，18:00 执行，18:30 再执行一次。更集中的参考数据字段口径见 [REFERENCE_DATA_USAGE.md](./REFERENCE_DATA_USAGE.md)。

研究任务的实际顺序为：

```text
index:update
  → index:constituents:update
  → dividend:current:update
  → dividend:update
  → snapshot:build
  → snapshot:verify
```

18:30 是第二个幂等触发器，不会判断 18:00 是否成功后再决定是否运行。由于各步骤支持增量或幂等发布，第一次成功时第二次运行通常是无变化校验，并可继续推进下一批分红回补。

分钟湖盘后更新无需人工下载：

```powershell
npm run minute:online:probe
npm run minute:online:health
npm run minute:online:dry-run
npm run minute:online:update
```

分钟数据的完整接入、对账、时间轴和自动任务说明见 [MINUTE_DATA_USAGE.md](./MINUTE_DATA_USAGE.md)。

## 13. 自动任务状态与故障排查

### 13.1 查看 Windows 任务状态

```powershell
Get-ScheduledTask -TaskName 'QuantBacktest-ResearchSnapshot'
Get-ScheduledTaskInfo -TaskName 'QuantBacktest-ResearchSnapshot'
```

`LastTaskResult = 0` 表示上次完整链路成功。任务注册：

```powershell
npm run snapshot:schedule:register
```

手动触发一次真实计划任务：

```powershell
Start-ScheduledTask -TaskName 'QuantBacktest-ResearchSnapshot'
```

### 13.2 查看日志

```powershell
Get-Content .logs/research-snapshot/research-update.log -Tail 100 -Encoding utf8
```

日志超过 20MB 时会轮换为：

```text
server/.logs/research-snapshot/research-update.previous.log
```

Python 或第三方库可能向 stderr 输出弃用警告或进度条。任务以原生进程退出码判断成败，不应仅凭一条 warning 判断任务失败。

### 13.3 检查数据和快照状态

```powershell
npm run reference:status
npm run snapshot:freshness
npm run snapshot:verify
npm run duckdb -- status --format json
```

- `reference:status`：分红从未处理、待重试、终态无数据、完成及刷新数量，以及指数行情和成分快照覆盖；
- `snapshot:freshness`：MySQL 股票日线与当前研究快照是否一致；
- `snapshot:verify`：逐文件核对行数、文件大小和 SHA-256；
- `duckdb status`：显示当前 `current.json` 指向的已发布版本。

### 13.4 常见问题

| 现象 | 常见原因 | 处理方式 |
| --- | --- | --- |
| `未知命令：--sql` | 忘记写 `query` 子命令 | 使用 `npm run duckdb -- query --sql "..."` |
| 找不到 `bars` | 尚未发布快照或快照根目录错误 | 检查 `.env`、运行 `snapshot:build` 和 `snapshot:verify` |
| 找不到某个参考视图 | 当前快照不包含对应数据集 | 查看 `duckdb status` 的 `datasets`，重新构建快照 |
| 股票日线日期落后 | MySQL 日线尚未终态或快照未重建 | 先确认上游日线，再运行 `snapshot:freshness` |
| 指数接口断连 | 第三方公开接口瞬时波动 | 已有缓存时任务会保留旧数据；查看日志并等待下一触发器 |
| 分红完成率较低 | 全市场历史仍按批次回补 | 运行 `reference:status`；不要把空结果等同于无分红 |
| 成分权重合计略偏离 100 | 来源文件精度和四舍五入 | 查看 `weightSumPct`，不要自行等比例改写 |
| 分钟文件查不到 | 路径、年份或交易日文件名不正确 | 检查分钟湖 `manifest.json` 和实际 Parquet 路径 |
| 持久表没有更新 | 使用了物化表而不是视图 | 重新执行 `CREATE OR REPLACE TABLE`，或改用视图 |

任一快照文件验证失败时，发布流程不会切换 `current.json`。旧的已验证快照仍可继续查询。

## 14. 注意事项

- `bars` 是日线快照视图，不包含分钟数据；分钟表需要显式 `read_parquet(...)` 或自行创建视图。
- 分钟数据跨来源存在 240/241 根时间轴差异，应以 `trade_time` 为准。
- `vol`、`amount` 分别使用股、元口径；不要把科创板日线库中的已知成交量倍率反向应用到分钟数据。
- `manifest.json` 是分钟湖已发布日期的目录，不要查询 `.partial` 或 `.tdx-partial` 临时文件。
- 使用 `--db` 持久化本地结果时，应与权威 MySQL 数据和 Parquet 数据湖区分开。
- `duckdb status` 中的 `maxDate` 只代表股票日线；其他视图应分别查询自己的日期范围。
- 分红空值、指数权重空值和估值空值均有业务含义，不要无条件使用 `COALESCE(..., 0)`。
- 指数成分查询应指定 `snapshotId` 或有效日期，避免混合多个来源批次。
- 研究快照通过 `current.json` 原子发布；不要手工把 CLI 指向尚未验证的临时目录。
