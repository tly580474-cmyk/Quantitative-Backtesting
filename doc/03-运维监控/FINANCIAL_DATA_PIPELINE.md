# 财务报表与 ROE 数据链路

## 数据源与原则

- 主接入：Tushare Pro（配置 `TUSHARE_TOKEN` 后可用于单股探针和授权范围内的批量更新）。
- 免 Token 备用源：AKShare 封装的新浪财经三大财务报表与财务分析指标。
- 不使用东方财富财务接口作为本地财务库的数据源。
- MySQL 按 `证券 + 报告期 + 公告日` 保存公告版本，支持回测按当时已知信息查询，避免未来函数。
- ROE 优先级：加权披露 ROE → 披露 ROE → 系统估算 ROE。估算值与计算方法单独保存。
- 系统仅在本期和上年末归母权益均为正时估算 ROE。任一期权益非正时，
  `roe_calculated_pct` 保持 `NULL`，并将 `roe_calculation_method` 记为
  `not_applicable_non_positive_parent_equity`，防止权益穿零产生无经济意义的极端 ROE。

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

# 全市场历史回补；耗时较长，建议单独运行并保留日志
npm run financial:update -- --provider sina --full --workers 8

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

管理台“数据更新进度”同时显示分钟湖、个股日 K 线和财务报表。采集结果状态语义：

- `completed`：本批目标全部成功；
- `partial`：已有数据写入，但至少一只证券失败，需要按失败代码补抓；
- `dry-run`：仅抓取和标准化，没有写库。

单股失败不会清除既有财报。全量回补完成后应重新构建并校验研究快照：

```powershell
npm run snapshot:build
npm run snapshot:verify
```

## 数据质量规则

- 披露 ROE 永远优先于系统估算值，不用估算值覆盖来源披露值。
- 负归母权益或权益穿零时，系统估算 ROE 记为不适用，不参与评分。
- 营收、净利润和经营现金流允许为负，但缺失值必须保持 `NULL`，不得转换为 0。
- 资产负债率和毛利率优先使用来源指标；来源缺失时才根据同一公告版本的报表字段推导。
- 年报未披露不等同于采集失败。验收时必须结合交易所或巨潮资讯公告确认。
- 回测必须使用公告日约束；报告期不能代替可用日期。

## 2026-07-27 全量回补验收基线

| 项目 | 验收结果 |
| --- | ---: |
| 活跃股票财务历史覆盖 | 5,486 / 5,486 |
| 公告版本总数 | 518,695 |
| 报告期范围 | 1989-12-31 ～ 2026-06-30 |
| 2025 年报已披露覆盖 | 5,484 / 5,486 |
| 2025 年报营收/净利润/经营现金流/负债率 | 100% |
| 2025 年报 ROE | 98.74% |
| 2025 年报毛利率 | 98.25% |
| 2025 年报极端 ROE（绝对值大于 10,000%） | 0 |
| 可比较年报的资产负债恒等式偏差超过 5% | 0 |

缺少 2025 年报的两只股票不是数据源漏抓：

- `002731 ST萃华`：截至验收日尚未按期披露 2025 年报，见
  [巨潮资讯公告](https://static.cninfo.com.cn/finalpage/2026-05-21/1225320415.PDF)；
- `688121 卓然股份`：无法按期披露 2025 年报并停牌，见
  [上海证券交易所公告](https://big5.sse.com.cn/site/cht/www.sse.com.cn/disclosure/listedinfo/announcement/c/new/2026-06-13/688121_20260613_89RJ.pdf)。

验收后发布的研究快照为
`eb260586-a8d0-4c24-9171-218b1222341c-20260726215752`，
其中 `financial_reports` 为 518,695 行；快照总行数为 17,118,231，已通过
manifest、行数和 SHA-256 校验。该 ID 是验收留档，不应在代码中写死为固定当前版本。

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
