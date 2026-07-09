# 本地 DuckDB CLI 使用说明

本文档说明 `server` 侧新增的本地 DuckDB CLI 入口。它用于在不启动后端服务的情况下，直接通过 DuckDB 查询当前研究快照、查看字段结构、执行本地 SQL 文件，并把结果导出为 JSON 或 CSV。

## 1. 入口位置

进入后端目录：

```bash
cd server
```

查看帮助：

```bash
npm run duckdb -- help
```

CLI 源码位于：

```text
server/src/research/duckdbCli.ts
```

## 2. 默认数据模型

CLI 默认会读取环境变量中的研究快照目录：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
```

如果当前目录下存在已发布快照，CLI 会自动把快照 Parquet 文件挂载为 DuckDB 视图：

```sql
bars
```

因此查询当前研究快照时不需要手写 `read_parquet(...)`：

```bash
npm run duckdb -- query --sql "SELECT tradeDate, symbol, close FROM bars LIMIT 10"
```

`bars` 视图对应当前快照的路径：

```text
<RESEARCH_SNAPSHOT_ROOT>/<snapshot-id>/bars/year=*/*.parquet
```

## 3. 命令列表

### 查看当前快照状态

```bash
npm run duckdb -- status
```

输出内容包括：

- `snapshotId`
- `status`
- `publishedAt`
- `sourceVersion`
- `sourcePublishedAt`
- `rowCount`
- `instrumentCount`
- `minDate`
- `maxDate`
- `partitions`

如果没有已发布快照，会返回 `unavailable`。

### 查看字段结构

```bash
npm run duckdb -- schema
```

该命令等价于：

```sql
DESCRIBE bars
```

常用于确认可查询字段名和 DuckDB 类型。

### 执行 SQL

直接传入 SQL：

```bash
npm run duckdb -- query --sql "SELECT market, COUNT(*) AS rows FROM bars GROUP BY market"
```

从文件读取 SQL：

```bash
npm run duckdb -- query --file ./queries/latest-close.sql
```

如果 `query` 命令没有传入 `--sql` 或 `--file`，CLI 会默认查询最近 20 条行情记录，方便快速确认快照是否可读。

## 4. 输出格式

默认输出为表格：

```bash
npm run duckdb -- query --sql "SELECT symbol, close FROM bars LIMIT 5"
```

输出 JSON：

```bash
npm run duckdb -- query --format json --sql "SELECT symbol, close FROM bars LIMIT 5"
```

输出 CSV：

```bash
npm run duckdb -- query --format csv --sql "SELECT symbol, close FROM bars LIMIT 5"
```

导出到文件：

```bash
npm run duckdb -- query --sql "SELECT * FROM bars LIMIT 1000" --out ./out/sample.csv
```

当 `--out` 后缀为 `.csv` 或 `.json` 时，CLI 会自动推断输出格式。

## 5. 常用参数

| 参数 | 说明 |
| --- | --- |
| `--sql`, `-q` | 直接传入 SQL |
| `--file` | 从文件读取 SQL |
| `--out`, `-o` | 写入结果文件 |
| `--format`, `-f` | 输出格式：`table`、`json`、`csv` |
| `--db` | DuckDB 数据库路径，默认 `:memory:` |
| `--snapshot-root` | 研究快照目录，默认读取 `RESEARCH_SNAPSHOT_ROOT` |
| `--no-snapshot-view` | 不自动创建 `bars` 视图 |
| `--threads` | DuckDB 线程数，默认 `4` |
| `--max-memory` | DuckDB 内存上限，例如 `1GB` |

## 6. 使用持久 DuckDB 文件

默认 `--db` 是 `:memory:`，每次执行都是临时数据库。

如果需要在本地 DuckDB 文件中创建临时表、物化结果或索引，可以指定数据库文件：

```bash
npm run duckdb -- query --db ./data/local-research.duckdb --sql "CREATE TABLE latest AS SELECT * FROM bars WHERE tradeDate = (SELECT MAX(tradeDate) FROM bars)"
```

随后继续查询：

```bash
npm run duckdb -- query --db ./data/local-research.duckdb --sql "SELECT COUNT(*) AS rows FROM latest"
```

## 7. 查询示例

查看最近交易日：

```bash
npm run duckdb -- query --sql "SELECT MAX(tradeDate) AS latestTradeDate FROM bars"
```

按市场统计行数：

```bash
npm run duckdb -- query --sql "SELECT market, COUNT(*) AS rows FROM bars GROUP BY market ORDER BY market"
```

导出某一天的收盘价：

```bash
npm run duckdb -- query --out ./out/close-2026-07-09.csv --sql "SELECT market, symbol, name, tradeDate, close FROM bars WHERE tradeDate = '2026-07-09' ORDER BY market, symbol"
```

筛选成交额前 50：

```bash
npm run duckdb -- query --sql "SELECT symbol, name, tradeDate, amount FROM bars WHERE tradeDate = (SELECT MAX(tradeDate) FROM bars) ORDER BY amount DESC LIMIT 50"
```

## 8. 与快照流程的关系

本 CLI 只负责读取当前已发布研究快照，不负责构建或校验快照。

日常更新仍使用：

```bash
npm run snapshot:build
npm run snapshot:verify
npm run snapshot:freshness
```

当 `status` 显示没有可用快照，或查询 `bars` 报错时，先检查：

```bash
npm run snapshot:freshness
```

必要时重新构建并校验快照。

## 9. 注意事项

- CLI 会把查询结果读入 Node.js 进程后再输出，不建议直接导出多年全市场明细。
- 大结果集建议在 SQL 中显式添加 `WHERE` 和 `LIMIT`，或按日期分批导出。
- `bars` 是只读视图，来源是当前研究快照 Parquet 文件。
- 使用 `--db` 持久化本地 DuckDB 文件时，请把临时分析结果与权威 MySQL 数据区分开。
