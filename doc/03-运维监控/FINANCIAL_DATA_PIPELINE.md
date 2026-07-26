# 财务报表与 ROE 数据链路

## 数据源与原则

- 主接入：Tushare Pro（配置 `TUSHARE_TOKEN` 后可用于单股探针和授权范围内的批量更新）。
- 免 Token 备用源：AKShare 封装的新浪财经三大财务报表与财务分析指标。
- 不使用东方财富财务接口作为本地财务库的数据源。
- MySQL 按 `证券 + 报告期 + 公告日` 保存公告版本，支持回测按当时已知信息查询，避免未来函数。
- ROE 优先级：加权披露 ROE → 披露 ROE → 系统估算 ROE。估算值与计算方法单独保存。

## MySQL 表

表名：`financial_reports`

主要字段：

- 标识：`instrument_key`、`report_period`、`announcement_date`、`report_type`
- 利润表：`total_revenue`、`revenue`、`operating_cost`、`operating_profit`、
  `total_profit`、`net_profit`、`net_profit_parent`
- 资产负债表：`total_assets`、`total_liabilities`、`total_equity`、
  `equity_parent`、流动资产/负债、货币资金、应收账款、存货、商誉和借款
- 现金流量表：经营、投资、筹资现金流，资本开支和自由现金流
- 指标：ROE、ROA、毛利率、净利率、资产负债率、流动/速动比率、
  周转率、经营现金流收入比、营收增速和净利润增速
- 治理：`source_key`、`source_version`、`source_fingerprint`、`fetched_at`

## 更新命令

```powershell
cd server

# 单股端到端探针；未配置 Token 时自动使用新浪备用源
npm run financial:probe

# 一批未覆盖或最久未刷新的股票，适合反复执行和断点续跑
npm run financial:backfill

# 最近公告增量；有 Token 的单股调用可显式指定 Tushare
npm run financial:update -- --provider tushare --symbol 002155 --lookback-days 730

# 查看覆盖率
npm run reference:status
```

## 自动更新

后台配置项：

```dotenv
FINANCIAL_DATA_ENABLED=true
FINANCIAL_DATA_UPDATE_TIME=19:00
FINANCIAL_DATA_LOOKBACK_DAYS=21
```

自动任务每天处理最多 200 只“未覆盖或最久未刷新”的股票，4 路并发，失败会记录在
`market_data_collector_runs`。开启 `SCHEDULE_SKIP_NON_TRADING_PERIODS` 时，休市日跳过，
下一个交易日继续按最旧更新时间轮换，因此不会丢失待更新证券。

## DuckDB

研究快照发布两个视图：

- `financial_reports`：保留所有公告版本。
- `financial_reports_latest`：每个证券、每个报告期选择最新公告版本。

查询示例：

```powershell
npm run duckdb -- query --sql "SELECT symbol, reportPeriod, announcementDate, revenue, netProfitParent, netOperatingCashFlow, COALESCE(roeWeightedPct, roePct, roeCalculatedPct) AS roe, grossMarginPct, debtToAssetsPct FROM financial_reports_latest WHERE symbol='002155' ORDER BY reportPeriod DESC"
```

因子回测若需要严格时点数据，应查询 `financial_reports`，并约束
`announcementDate <= tradeDate`，不能直接使用 `financial_reports_latest`。
