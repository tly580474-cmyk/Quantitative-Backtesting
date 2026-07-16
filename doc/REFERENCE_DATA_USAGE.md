# DuckDB 参考数据使用与更新说明

## 1. 已接入的数据

当前研究快照除股票日线 `bars` 外，还会自动注册以下 DuckDB 视图：

| 视图 | 内容 |
| --- | --- |
| `stock_valuations` | 股票收盘价、PE、PB、PS 和市值 |
| `adjustment_factors` | 当前已发布复权参数，包含乘数与价格偏移 |
| `index_bars` | 核心指数日线行情 |
| `index_constituent_snapshots` | 指数成分来源批次和权重批次 |
| `index_constituents` | 指数成分明细与权重 |
| `index_constituents_scd` | 按来源推导的成分有效期视图 |
| `dividend_events` | 分红、送股和转增事件 |

DuckDB 只读取已通过校验并由 `current.json` 指向的 Parquet 快照。MySQL 仍是权威事实层。

## 2. 常用查询

查询湖南黄金最近估值：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, close, peTtm, pb FROM stock_valuations WHERE symbol='002155' ORDER BY tradeDate DESC LIMIT 10"
```

查询湖南黄金复权参数：

```powershell
npm run duckdb -- query --sql "SELECT effectiveDate, factor, priceOffset, factorVersion FROM adjustment_factors WHERE symbol='002155' ORDER BY effectiveDate"
```

复权价格使用仿射变换：

```text
adjusted_price = raw_price × factor + priceOffset
```

查询沪深300行情：

```powershell
npm run duckdb -- query --sql "SELECT tradeDate, open, high, low, close, volume, amount FROM index_bars WHERE indexCode='000300' ORDER BY tradeDate DESC LIMIT 20"
```

查询沪深300最新已留存成分批次：

```powershell
npm run duckdb -- query --sql "SELECT constituentDate, weightDate, memberCount, weightSumPct, sourceKey FROM index_constituent_snapshots WHERE indexCode='000300' ORDER BY constituentDate DESC"
```

查询某一权重批次的前十大成分：

```powershell
npm run duckdb -- query --sql "SELECT constituentCode, constituentName, weightPct FROM index_constituents WHERE indexCode='000300' AND weightDate IS NOT NULL ORDER BY weightPct DESC LIMIT 10"
```

查询湖南黄金分红历史：

```powershell
npm run duckdb -- query --sql "SELECT reportPeriod, exDate, cashDividendPerShare, bonusSharePerShare, transferSharePerShare, planStatus FROM dividend_events WHERE symbol='002155' ORDER BY reportPeriod DESC"
```

## 3. 数据日期口径

`constituentDate`、`weightDate` 和 `fetchedAt` 含义不同：

- `constituentDate`：来源文件声明的成分日期；
- `weightDate`：权重文件声明的日期，无权重时为 `NULL`；
- `fetchedAt`：本机抓取时间。

成分与权重日期不一致时不会静默合并。`index_stock_cons_csindex` 没有任意历史日期参数，系统只会从首次上线开始持续留存来源批次；更早历史需要独立官方文件回补。

分红接口中的现金、送股和转增比例原始单位为“每 10 股”，入库统一转换为“每股”。缺失日期和权重保留 `NULL`。

## 4. 手动更新与状态

```powershell
npm run index:update
npm run index:constituents:update
npm run dividend:current:update
npm run dividend:update
npm run snapshot:build
npm run snapshot:verify
npm run reference:status
```

首次指数历史回补：

```powershell
npm run index:backfill -- --end-date 20260715
```

单独核验湖南黄金分红：

```powershell
npm run dividend:probe
```

`reference:status` 会分别显示分红从未处理、待重试、终态无数据、完成和轮换刷新数量，以及指数行情和成分快照覆盖范围。

## 5. 自动更新

注册研究快照计划任务：

```powershell
npm run snapshot:schedule:register
```

任务名为 `QuantBacktest-ResearchSnapshot`，每天 18:00 执行，18:30 自动重试。执行顺序为：

```text
指数行情增量
  → 指数成分与权重批次抓取
  → 分红历史分片回补
  → 股票日线、复权和参考数据快照构建
  → 文件大小、行数和 SHA-256 校验
  → 原子切换 current.json
```

日志位置：

```text
server/.logs/research-snapshot/research-update.log
```

指数成分接口设置请求超时。若第三方接口临时不可用但数据库已有已发布批次，任务保留已有批次并记录警告，不会删除历史数据。

分红更新分成两条链路：

- `dividend:current:update` 按当前可用报告期读取全市场方案，每天更新最新公告、登记日、除权日和方案状态；
- `dividend:update` 使用单股明细接口继续历史回补，每轮默认处理 200 只未抓取证券、20 只到期失败项和 20 只旧记录轮换刷新项。

历史回补使用 8 路受控并发。失败项采用指数退避，单只证券失败不会回滚其他成功证券。已退市证券连续两次得到明确的上游无明细错误后标记为 `no_data`，不再无限重试；活跃证券仍保持可重试状态。

全市场接口和单股明细接口可能返回同一业务事件。发布前按“证券、报告期、除权日、现金分红、送股、转增”业务键合并，优先补全公告日期、方案状态和原始方案文本，不会因为来源指纹不同而保留重复事件。

## 6. 质量约束

- 正式 Parquet 主键重复数应为 0；
- 指数 OHLC 必须满足价格区间约束；
- 指数权重必须非负，权重合计应接近 100%；
- 指数成员必须映射到证券主表，无法映射时不得伪造内部键；
- 分红比例不得为负，空值不得转换成 0；
- 分红业务键重复数必须为 0；
- 复权参数必须同时保留 `factor` 和 `priceOffset`；
- 同一来源校验和不变时不得创建重复来源批次；
- 任一快照文件校验失败时不得切换当前版本指针。
