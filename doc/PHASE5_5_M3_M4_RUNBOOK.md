# 5.5 阶段 M3/M4 运行手册

## 1. M3：v2 业务查询灰度

服务端通过以下环境变量控制行情事实层：

```dotenv
HISTORY_STORE_READ_MODE=prefer-v2
HISTORY_STORE_DUAL_WRITE=true
```

读取模式：

| 模式 | 行为 |
| --- | --- |
| `legacy` | 只读 `daily_candles`，用于紧急回滚 |
| `prefer-v2` | 优先读取 `daily_bars_v2`，无数据时回退旧表 |
| `v2` | 只读 v2，无数据时明确返回 404 |

`HISTORY_STORE_DUAL_WRITE=true` 时，增量更新同时写入 v2 和旧表；正式结束回滚观察期后
可设为 `false`，只写 v2。证券缺少 `instrument_key` 时，v2-only 写入会阻断并报告错误，
避免静默丢数据。

单证券 K 线接口：

```text
GET /api/instruments/:id/candles
```

- 单次最多 5,000 行；
- 前端会自动分页，长历史不会截断；
- 响应包含 `storage`、`adjustmentMode` 和 `factorVersion`；
- 前复权、后复权仍由服务端基于已发布因子按需计算。

回滚操作：

1. 将 `HISTORY_STORE_READ_MODE` 改为 `legacy`；
2. 保持 `HISTORY_STORE_DUAL_WRITE=true`；
3. 重启服务端；
4. 调用单证券接口，确认响应 `storage=legacy`。

> 现有旧表基线仅有 6 行、2 只证券；全量 17,036,064 行首次迁移时只进入了 v2。
> 因此 `legacy` 是旧系统已有数据的代码级紧急通道，不是全市场历史副本。
> 从本阶段开始保持 `HISTORY_STORE_DUAL_WRITE=true`，可建立后续增量的回滚窗口。
> 不建议为了形式上的全量回滚再向低效旧表复制 1,700 万行。

## 2. M4：Parquet 研究快照

默认目录：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
RESEARCH_QUERY_MAX_ROWS=10000
```

生成完整快照：

```bash
cd server
npm run snapshot:build
```

只重建受影响年份，并复用当前快照的其他分区：

```bash
npm run snapshot:build -- --years 2025,2026
```

生成器先写入 `.building-*` 暂存目录。全部年度行数与 MySQL 一致后，复制到新的不可变
版本目录，最后原子替换 `current.json`。发布失败不会切换当前版本。

Windows 上若生成已完成但发布步骤被文件句柄阻断，可在进程退出后恢复发布：

```bash
npm run snapshot:publish
```

独立复核当前快照：

```bash
npm run snapshot:verify
```

复核内容包括：

- manifest 与当前指针一致；
- 每个 Parquet 文件存在且大小一致；
- 每个文件 SHA-256 一致；
- 每个分区和全快照行数一致；
- 所有 Parquet 文件可被 DuckDB 正常读取。

运行一年全市场扫描基准：

```bash
npm run snapshot:benchmark
```

研究查询 API：

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

查询字段使用白名单，日期、市场和证券代码均参数化；普通 API 受
`RESEARCH_QUERY_MAX_ROWS`、最多 366 天日期跨度、2 个并发查询和 8 个排队任务限制，
不允许把全市场多年数据直接塞入普通 JSON。更长扫描应使用 CLI 或后续后台任务入口。

## 3. 首次发布结果

2026-07-05 首次发布并完成 2026 年增量重建演练：

- 当前快照：`9d62a095-19f9-4c04-a670-3f6e0ee8e46f-20260705100421`
- 来源批次：`9d62a095-19f9-4c04-a670-3f6e0ee8e46f`
- 日期：`2000-01-04 ~ 2026-07-03`
- 年度分区：27
- 行数：17,036,064
- 证券数：5,824
- 独立校验：通过
- 增量演练：只重建 2026 年，2000～2025 年复用已校验不可变分区
- 一年扫描：1,308,494 行，29.98 ms

基准只代表本次开发机热/冷缓存混合条件下的实测值；正式性能报告仍应同时记录硬件、
DuckDB 线程数、缓存状态和多次 P50/P95。
