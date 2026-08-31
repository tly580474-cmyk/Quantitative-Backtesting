# 历史 1 分钟行情接入

## 数据范围与存储

- 历史年份：2010 年至今。
- 年度压缩包：`1m_price_zip/<year>.zip`。
- 查询数据湖：`1m_price_parquet/year=<year>/<YYYYMMDD>.parquet`。
- 查询引擎：DuckDB；MySQL 只提供股票、交易日和最终日线对账数据，不保存分钟明细。
- 2026-04-10 之后由在线分钟源自动增量更新；当前固定使用 TDX TCP 作为主源，新浪在线源和通达信本地 `.lc1` 作为故障回补源。

在 `server/.env` 中可覆盖路径：

```dotenv
MINUTE_DATA_ZIP_ROOT=../../所有股票的历史数据/1m_price_zip
MINUTE_DATA_ROOT=../../所有股票的历史数据/1m_price_parquet
TDX_DATA_ROOT=D:/tdx
MINUTE_QUERY_MAX_ROWS=100000
MINUTE_TDX_TCP_ENABLED=true
MINUTE_TDX_TCP_SHADOW_ENABLED=true
MINUTE_TDX_TCP_WORKERS=2
MINUTE_UPDATE_LOCK_FILE=.logs/minute-data/update.lock
```

相对路径以 `server/` 为工作目录解析。

## 准备年度数据

```powershell
cd server
npm run minute:prepare
```

准备命令会生成 `manifest.json`。写文件采用临时文件加原子替换；重复执行时会保留已由增量更新器发布、但不在年度 ZIP 内的日文件。

## 在线盘后自动更新（推荐）

每日主流程直接从在线分钟源拉取真实 OHLC、成交量和成交额，不要求人工打开通达信执行“盘后数据下载”：

```powershell
cd server
npm run minute:online:probe
npm run minute:online:health
npm run minute:online:dry-run
npm run minute:online:update
```

在线更新器会以数据库最终日线进行独立对账，保留 09:31–15:00 的 240 根时间轴；覆盖率低于阈值、收盘价不一致或源数据内部不自洽时拒绝发布。写盘仍采用临时文件、Parquet 校验和 manifest 原子更新。

## TDX TCP 在线源（正式主源）

TDX TCP 通过通达信真实行情协议获取沪、深、北交所原生 240 根分钟线，不要求本机通达信客户端下载 `.lc1`。首期复用 `pytdx 1.72`，运行环境可用下列命令验证：

```powershell
cd server
python -m pip install -r src/minuteData/requirements.txt
npm run minute:tdx-online:probe
npm run minute:tdx-online:health
npm run minute:tdx-online:dry-run
npm run minute:tdx-online:shadow
```

更新器会真实探测多个行情节点，使用两个持久连接抓取；连接或协议失败时切换节点。原始响应写入 `.logs/minute-data/checkpoints` 的 SQLite 检查点，影子任务中断后可复用。字段、时间轴或日线对账异常的股票会从另一节点二次获取，仍不合格时计入缺失且不放宽 99.5% 覆盖率门槛。

影子模式只打印并记录覆盖率、行数、缺失股票和日线对账结果，不写 Parquet 或 `manifest.json`。如需继续运行独立影子校验，可注册每日 16:00 影子任务：

```powershell
npm run minute:tdx-online:shadow:register
```

日志位于 `server/.logs/minute-data/tdx-shadow.log`，进度位于 `tdx-shadow-progress.json`。当前正式更新顺序固定为 TDX TCP → 新浪 → 本地 `.lc1`；不会因为单次 TDX 失败自动永久切回新浪主源。正式写入器共用 `MINUTE_UPDATE_LOCK_FILE`，避免多个来源同时改写分钟湖。

完整批准计划见 `plan/TDX_TCP_MINUTE_PROVIDER_PLAN.md`。

## 通达信本地回补

先在通达信客户端完成“盘后数据下载”的 1 分钟数据更新，确认 `vipdoc/sh/minline`、`vipdoc/sz/minline` 和 `vipdoc/bj/minline` 中的 `.lc1` 文件已刷新，然后运行：

```powershell
cd server
npm run minute:tdx:dry-run
npm run minute:tdx:probe
npm run minute:tdx:import
```

也可指定区间或单股探针：

```powershell
python src/minuteData/tdx_import.py --start-date 2026-04-13 --end-date 2026-04-13
python src/minuteData/tdx_import.py --probe-symbol 002155
```

导入器会：

1. 从 `manifest.json` 末日之后寻找数据库中已终态的交易日；
2. 直接解析沪、深、北市场 `.lc1`，不依赖行情服务器或 Token；
3. 保留通达信原生 240 根时间轴（09:31–11:30、13:01–15:00），不伪造 09:30；
4. 以最终日线收盘价逐股逐日强对账，并核对成交量、成交额；收盘不一致会中止，数据库量额口径异常会保留源值并列入未完全对账清单；集合竞价可能导致分钟聚合的开盘价或极值与日线不同；
5. 跳过无最终日线且全天零成交的停牌占位线；
6. 检查当日全部有成交股票的覆盖率、行数和字段后原子发布 Parquet；
7. 最后原子更新 `manifest.json`，半成品不会进入查询目录。

通达信和旧年度源的分钟分配口径不同：旧湖通常为 241 根并含 09:30，通达信为 240 根并从 09:31 开始。跨源研究不应按固定行号拼接，应使用 `trade_time`；日级 OHLCV 聚合可用于连续性校验。

当前数据库的科创板日线成交量存在已确认的 100 倍口径差，而成交额正确。导入器仍保留 TDX 的“股”口径，并在对账时识别该已知倍率，不会把错误倍率写入分钟湖。

若数据库显示某股有成交但本地缺少对应 `.lc1`，导入器会发布其余真实数据并在结果中报告 `coverageMissing` 和样例；补下载缺失股票后可用 `--overwrite` 重建相关日期。

## Tushare 备用更新器

`minute:update` 使用 Tushare `stk_mins`，需要单独开通历史分钟权限。配置 `TUSHARE_TOKEN` 后运行：

```powershell
npm run minute:update:dry-run
npm run minute:update
```

该更新器会补齐与旧湖一致的 241 根时间轴，适合 TDX 本地文件不可用时回补。不要把 `MINUTE_UPDATE_REQUESTS_PER_MINUTE` 设置得高于账户限额。

## Windows 自动执行

确认在线探针成功后，注册每天 16:30 的主任务和 17:30 的自动重试：

```powershell
cd server
npm run minute:schedule:register
```

默认计划任务优先运行 `minute:tdx-online:update`；TDX TCP 失败时降级到新浪在线源，再失败才尝试本地 TDX 回补。每日主流程不依赖人工下载 `.lc1`。任务使用 `StartWhenAvailable` 和 `IgnoreNew`，任务名为 `QuantBacktest-MinuteUpdate`。

后台的“跳过非交易时段”开关（`SCHEDULE_SKIP_NON_TRADING_PERIODS=true`）默认开启。
自动任务会依据 A 股交易日历跳过周末和休市日；手动执行上述 npm 命令不受影响。

自动任务日志写入 `server/.logs/minute-data/minute-update.log`。注册后无需额外刷新 DuckDB；下一次查询会直接读取新发布的 Parquet。

## API

```http
GET /api/market-data/minute/catalog
GET /api/market-data/stocks/600519/minute?startDate=2024-12-31
GET /api/market-data/stocks/600519/minute?startDate=2024-12-01&endDate=2024-12-31&limit=10000
GET /api/market-data/stocks/600519/kline?period=intraday&tradeDate=2024-12-31
```

- `startDate` 必填，`endDate` 默认与其相同。
- `limit` 最大值由 `MINUTE_QUERY_MAX_ROWS` 控制。
- `includeZeroVolume=false` 可排除零成交分钟。
- 单次最多扫描 366 个自然日。
- K 线接口不传 `tradeDate` 时仍使用腾讯当日分时接口。

## 数据约定

- 价格、成交量和成交额沿用源数据精度与股/元口径。
- `pre_close`、`change`、`pct_chg` 是分钟环比；当日第一根以数据库的上一日收盘价为基准。
- API 通过 `isTradable` 标记分钟是否可用于撮合。
- 消费端不得假定每天固定为 241 根，应按 `trade_time` 和实际交易日处理。
