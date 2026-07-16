# 本地 DuckDB CLI 使用说明

本文档说明如何在不启动后端服务的情况下，通过 `server` 提供的 DuckDB CLI 查询两类本地 Parquet 数据：

- 已发布的日线研究快照，自动挂载为 `bars` 视图；
- 2010 年至今的 1 分钟行情湖，通过 `read_parquet(...)` 按日期直接读取。

CLI 支持直接 SQL、SQL 文件、JSON/CSV 输出和持久 DuckDB 文件，适合临时研究、数据核验与批量导出。

## 1. 入口位置

进入后端目录：

```powershell
cd server
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

### 2.1 日线研究快照

CLI 默认读取：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
```

如果存在已发布快照，会自动把以下 Parquet 挂载为只读视图 `bars`：

```text
<RESEARCH_SNAPSHOT_ROOT>/<snapshot-id>/bars/year=*/*.parquet
```

因此日线查询不需要手写 `read_parquet(...)`：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, symbol, close FROM bars LIMIT 10"
```

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

### 查看当前日线快照状态

```powershell
npm run duckdb -- status
```

输出包括 `snapshotId`、`publishedAt`、`rowCount`、`instrumentCount`、日期范围和分区数。该命令只描述日线研究快照，不描述分钟湖；分钟湖范围以 `manifest.json` 或 HTTP 目录接口为准。

### 查看日线字段结构

```powershell
npm run duckdb -- schema
```

该命令等价于 `DESCRIBE bars`。查看分钟字段时直接执行：

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

## 7. 分钟行情查询示例

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

## 8. 性能建议

- 分钟湖体量较大，优先指定单日文件或较窄的文件通配符，不要默认扫描 `year=*/*.parquet`。
- 查询必须尽量包含 `code`、日期范围和必要的 `LIMIT`。
- 多日查询优先明确列出文件，或按年月使用 `202607*.parquet`，让文件裁剪发生在扫描前。
- 只选择需要的列，避免 `SELECT *` 导出全市场分钟明细。
- 大查询可使用 `--threads` 和 `--max-memory` 控制资源，例如 `--threads 8 --max-memory 4GB`。
- CLI 会把最终结果读入 Node.js 后再格式化；聚合可交给 DuckDB，但不要把数千万明细行直接输出到终端或 JSON。

## 9. 使用持久 DuckDB 文件

默认 `--db` 为 `:memory:`。需要保存表、视图或中间结果时可指定数据库文件：

```powershell
npm run duckdb -- query --db ./data/local-research.duckdb --sql "CREATE OR REPLACE TABLE latest AS SELECT * FROM bars WHERE tradeDate = (SELECT MAX(tradeDate) FROM bars)"
```

持久库中的物化表不会随 Parquet 自动更新；视图会在下次查询时读取路径中的最新文件。

## 10. DuckDB 的自动更新行为

DuckDB 在本项目中是查询层，不是行情采集器。它不会主动连接通达信、Tushare 或 MySQL，也不会自行生成 Parquet。所谓“自动看到新数据”，取决于查询对象是视图还是物化表：

| 查询对象 | 新数据是否自动可见 | 实际行为 |
| --- | --- | --- |
| CLI 默认的日线 `bars` 视图 | 是，下次执行 CLI 时可见 | 每次命令都会重新读取当前快照指针，并为本次连接注册最新已发布快照 |
| SQL 中直接 `read_parquet(...)` | 是，下次查询时可见 | 每次查询重新读取指定路径；精确文件路径只读取该文件，通配符会匹配当时存在的文件 |
| 持久库中的 `minute_bars` 视图 | 是 | 视图只保存 SQL 和路径，不复制数据；新发布且符合通配符的 Parquet 会在后续查询中被读取 |
| `CREATE TABLE ... AS SELECT ...` 物化表 | 否 | 创建时复制一份结果，之后不会随 Parquet 或研究快照变化 |
| 导出的 CSV/JSON | 否 | 属于静态文件，需要重新执行导出命令 |

### 10.1 日线快照刷新

日线 `bars` 是 CLI 连接内的临时视图。每次运行：

```powershell
npm run duckdb -- query --sql "SELECT MAX(tradeDate) FROM bars"
```

CLI 都会重新读取 `RESEARCH_SNAPSHOT_ROOT` 下的当前快照指针。因此新的研究快照完成发布后，无需修改 DuckDB 文件或重建 CLI 视图，下一次命令会自动查询新快照。

如果某个长时间运行的程序一直保持同一个 DuckDB 连接，则应在快照切换后重新注册视图或重启该进程；本 CLI 每条命令都会新建并关闭连接，不存在这个问题。

### 10.2 分钟湖刷新

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

### 10.3 物化结果刷新

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

### 10.4 自动任务的职责边界

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

## 11. 与数据更新流程的关系

DuckDB CLI 只负责读取，不构建数据。

日线研究快照更新：

```powershell
npm run snapshot:build
npm run snapshot:verify
npm run snapshot:freshness
```

分钟湖盘后更新无需人工下载：

```powershell
npm run minute:online:probe
npm run minute:online:health
npm run minute:online:dry-run
npm run minute:online:update
```

分钟数据的完整接入、对账、时间轴和自动任务说明见 `doc/MINUTE_DATA_USAGE.md`。

## 12. 注意事项

- `bars` 是日线快照视图，不包含分钟数据；分钟表需要显式 `read_parquet(...)` 或自行创建视图。
- 分钟数据跨来源存在 240/241 根时间轴差异，应以 `trade_time` 为准。
- `vol`、`amount` 分别使用股、元口径；不要把科创板日线库中的已知成交量倍率反向应用到分钟数据。
- `manifest.json` 是分钟湖已发布日期的目录，不要查询 `.partial` 或 `.tdx-partial` 临时文件。
- 使用 `--db` 持久化本地结果时，应与权威 MySQL 数据和 Parquet 数据湖区分开。
