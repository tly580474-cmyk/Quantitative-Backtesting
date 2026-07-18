# DuckDB 与研究快照使用说明

本文档说明本项目中 DuckDB 与 Parquet 研究快照的用途、目录结构、日常更新方式、校验方式、前端使用方式和常见维护操作。

## 1. 设计目标

研究快照用于把 MySQL 权威行情库中的 `daily_bars_v2` 与相关指标数据导出为 Parquet 文件，并通过 DuckDB 执行高性能横截面研究查询。

核心目标：

- MySQL 作为权威写入库。
- Parquet 快照作为不可变研究数据版本。
- DuckDB 作为本地嵌入式分析引擎。
- 因子研究任务只读取已发布、已校验的当前快照。
- 日常新增交易日时优先只追加缺失日期，避免每天重写全量历史数据。

## 2. 数据流

```text
MySQL daily_bars_v2 / daily_stock_metrics
  -> snapshot:build
  -> Parquet research snapshot
  -> current.json 指向当前快照
  -> DuckDB read_parquet 查询
  -> 因子研究 / 快照扫描 API
```

## 3. 关键目录

默认研究快照目录由环境变量控制：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
```

在 `server` 目录下，默认结构类似：

```text
server/data/research-snapshots/
  current.json
  <snapshot-id>/
    manifest.json
    bars/
      year=2000/
        data.parquet
      ...
      year=2026/
        data.parquet
        date=2026-07-09.parquet
```

说明：

- `current.json`：当前已发布快照指针。
- `<snapshot-id>/manifest.json`：快照 manifest，记录行数、日期范围、分区、文件大小和 SHA-256。
- `bars/year=YYYY/data.parquet`：年度分区文件。
- `bars/year=YYYY/date=YYYY-MM-DD.parquet`：日级追加分区文件。

## 4. 环境变量

常用配置：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
RESEARCH_QUERY_MAX_ROWS=10000
```

如果需要使用前端「更新快照」按钮，后端必须能连接 MySQL，并正常读取以下数据库配置：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your-password
DB_NAME=quant_backtest
```

## 5. 日常快照更新

进入后端目录：

```bash
cd server
```

检查快照状态：

```bash
npm run snapshot:freshness
```

日常更新快照：

```bash
npm run snapshot:build
npm run snapshot:verify
npm run snapshot:freshness
```

默认 `snapshot:build` 会按以下顺序处理：

1. 读取当前已发布快照。
2. 对比 MySQL 权威库的总行数、最大交易日和年度摘要。
3. 如果只是新增了当前快照最大日期之后的交易日，只生成这些交易日的日级 Parquet 分区。
4. 其余历史分区使用硬链接复用。
5. 如果检测到历史年份数据发生变化，才按受影响年份重建。
6. 校验行数与 manifest 后发布为新的当前快照。

## 6. 全量重建

只有在需要彻底重建历史快照时才使用全量模式：

```bash
npm run snapshot:build -- --full
npm run snapshot:verify
```

全量重建会重新导出所有年份数据，会占用较多磁盘写入和时间。日常更新不建议使用。

## 7. 指定年份重建

如果明确知道某个年份的数据被修正，可以只重建指定年份：

```bash
npm run snapshot:build -- --years 2026
npm run snapshot:verify
```

也可以指定多个年份：

```bash
npm run snapshot:build -- --years 2025,2026
```

未指定的年份会复用当前快照中的已校验分区。

## 8. 校验快照

独立校验当前快照：

```bash
npm run snapshot:verify
```

校验内容包括：

- `current.json` 与 manifest 指向一致。
- 每个 Parquet 文件存在。
- 文件大小与 manifest 一致。
- SHA-256 与 manifest 一致。
- DuckDB 可以正常读取 Parquet。
- 分区行数与全快照行数一致。

## 9. 快照新鲜度

检查 MySQL 权威库与当前研究快照是否一致：

```bash
npm run snapshot:freshness
```

可能状态：

| 状态 | 含义 | 建议 |
| --- | --- | --- |
| `current` | 快照已追平 MySQL | 可以运行因子研究 |
| `stale` | 快照落后于 MySQL | 执行 `snapshot:build` 或前端点击「更新快照」 |
| `inconsistent` | 快照领先或行数不一致 | 暂停研究，检查 MySQL 与快照来源 |
| `unavailable` | 没有可用快照 | 先构建快照 |

当前后端也提供 API：

```text
GET /api/research-snapshots/freshness
```

当快照落后时，响应会尽量返回缺失交易日列表 `missingDates`。

## 10. 前端更新快照

在「因子研究」页面顶部可以查看研究快照状态。

当状态为「待更新」或「不可用」时，可以点击「更新快照」。

前端按钮调用：

```text
POST /api/research-snapshots/update
```

后端会执行：

1. 检查当前 freshness。
2. 运行日级追加优先的快照构建。
3. 执行快照校验。
4. 返回更新后的 freshness。

## 11. DuckDB 查询方式

后端通过 DuckDB 读取当前快照的 Parquet 文件：

```sql
SELECT market, symbol, tradeDate, close, volume
FROM read_parquet('<snapshot-root>/<snapshot-id>/bars/year=*/*.parquet', hive_partitioning = true)
WHERE tradeDate BETWEEN $startDate AND $endDate
ORDER BY tradeDate, instrumentKey
LIMIT $limit
```

项目中封装在：

```text
server/src/research/duckdbResearchService.ts
```

主要接口：

```text
GET /api/research-snapshots/current
GET /api/research-snapshots/scan
```

示例：

```text
/api/research-snapshots/scan
  ?startDate=2026-07-03
  &endDate=2026-07-03
  &fields=market,symbol,tradeDate,close,volume
  &markets=SH,SZ
  &limit=1000
```

查询限制：

- 字段必须在白名单内。
- 日期跨度最多 366 天。
- 返回行数受 `RESEARCH_QUERY_MAX_ROWS` 限制。
- 普通 API 不适合直接返回多年全市场明细。

## 12. 因子研究如何使用快照

因子研究运行前会检查快照 freshness。

如果当前快照不是 `current`，因子任务会拒绝启动，避免基于落后数据生成研究结果。

因子研究读取路径大致为：

```text
factorRunner / compositeRunner
  -> readCurrentSnapshot
  -> DuckDB read_parquet
  -> 计算因子矩阵、标签、IC、分层收益
  -> 写入 factor-research 报告产物
```

相关文件：

```text
server/src/factorResearch/engine/factorRunner.ts
server/src/factorResearch/engine/compositeRunner.ts
server/src/factorResearch/repositories/factorRepository.ts
```

## 13. 备份建议

快照只是研究读模型，MySQL 仍是权威库。进入重要研究或长期回测前，建议保留一份 MySQL dump 与当前快照备份。

常用命令：

```bash
npm run backup:create
npm run backup:verify -- --path ./data/backups/<backup-id>
```

完整恢复演练：

```bash
npm run backup:restore-check -- --path ./data/backups/<backup-id> --database quant_backtest_restore_check --confirm-drop quant_backtest_restore_check --cleanup true
```

## 14. 自动保留与磁盘维护

盘后任务在新快照通过 `snapshot:verify` 后自动执行安全清理。默认策略为：

- 始终保留 `current.json` 指向的当前快照。
- 始终保留最近 7 个快照。
- 最近 30 天每天至少保留 1 个快照。
- 快照目录内存在 `.retain` 文件时永久保留，适合重要研究节点。
- `.building-*`、manifest 缺失或校验失败的未知目录不会自动删除。

配置项：

```dotenv
RESEARCH_SNAPSHOT_RETENTION_ENABLED=true
RESEARCH_SNAPSHOT_RETAIN_LATEST=7
RESEARCH_SNAPSHOT_RETAIN_DAILY_DAYS=30
```

人工检查候选项时默认仅预览；只有显式传入 `--apply` 才会删除：

```bash
npm run snapshot:prune
npm run snapshot:prune -- --apply
```

删除旧目录只会解除该版本的 NTFS 硬链接，不会破坏仍被其他快照引用的 Parquet 文件。

定时任务启动前还会检查中国交易日。周末、`trading_calendar` 标记的休市日，以及日历缺失且当日权威日线不存在的日期都会安全跳过，不执行上游更新或快照构建。

## 15. 常见问题

### 快照落后怎么办？

优先在前端「因子研究」页面点击「更新快照」，或在后端执行：

```bash
npm run snapshot:build
npm run snapshot:verify
```

### 为什么不每天全量重建？

全量重建会反复写入 2000 年以来的历史 Parquet 文件，对磁盘不友好。当前默认更新模式会优先只追加缺失交易日。

### 什么时候需要 `--full`？

只有在快照格式变化、历史数据大规模重算、或怀疑历史分区整体损坏时才需要。

### DuckDB 数据不是最新怎么办？

先检查：

```bash
npm run snapshot:freshness
```

如果状态不是 `current`，先更新并校验快照。

### 前端查询结果太少怎么办？

检查：

- `limit` 参数。
- `RESEARCH_QUERY_MAX_ROWS`。
- 日期跨度是否超过限制。
- 查询字段是否在白名单内。
