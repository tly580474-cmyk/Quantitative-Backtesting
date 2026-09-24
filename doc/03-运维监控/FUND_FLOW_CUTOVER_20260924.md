# 个股资金流补数与来源切换验收（2026-09-24）

服务器：`root@192.168.2.218`，项目：`/opt/quant-backtest`。本次范围为补齐现有库缺失的整个交易日，保留已有记录，之后仅更新独立的新来源。

## 已执行结果

| 历史缺失日 | 补入行数 | 本地日线证券数 |
| --- | ---: | ---: |
| 2026-08-20 | 5,541 | 5,541 |
| 2026-09-23 | 5,557 | 5,556 |
| 2026-09-24 | 5,558 | 5,557 |

合计新增 **16,656** 行。历史源标识为 `tushare_gateway_eastmoney`，版本为 `jiaoch:moneyflow_dc-v1-wanyuan-to-yuan`。通过用户指定的临时网关取得 `moneyflow_dc` 数据，金额由万元转换为元。新增行使用普通 INSERT，三个日期在同一事务提交；不执行覆盖更新。

原来源数量保持不变：`tinyshare_moneyflow` 13,889,865 行，`akshare_eastmoney` 156,198 行。旧表合计 14,062,719 行；2010-01-04 至 2026-09-24 的整个交易日缺口为零。这不代表历史上每只股票、每个字段都完整。

9 月 23、24 日比日线多出的各一行均为 `688496.SH`，五类资金净额全部为零，保留来源实际返回的正数收盘价。接口中 B 股与零报价且全部净额为零的占位行已排除；未知活跃 A 股、非零资金流却零报价、重复证券、错日期等情况会阻断整个导入。每个补数日期覆盖本地日线全部证券。

新来源 `eastmoney_web_datacenter` 已独立写入 `stock_fund_flows_web_datacenter`：2026-09-24 共 **5,199 行**，版本 `RPT_DMSK_TS_STOCKNEW-v1-yuan-main=elg+lg`。该接口仍属东方财富，是与 push2/clist 不同的接口体系，不是真正跨厂商容灾。

## 验证证据及边界

- 历史接口与旧库 2026-09-22 的 5,209 只股票逐股比较：主力、超大单、大单、中单、小单净额均在 50 元误差内，符合 0.01 万元取整精度；收盘价、涨跌幅完全一致。
- 新接口的 5,199 行主力净额也与同日历史接口逐股比较，均符合上述取整精度；新表 `main_net_in = super_large_net_in + large_net_in` 最大误差为 0。
- 新来源只提供最新交易日，系统从切换日起逐日积累；历史缺失不自动用旧来源回填。
- 新来源不含 BJ，不含中单、小单、资金净额占比。这些未提供字段保留 NULL，未使用买入占比代替净额占比。
- 当日 4 行缺收盘价、16 行缺涨跌幅，保留 NULL，未以其他来源补值。
- 对照本地沪深日线，有 23 只股票未被新来源覆盖；按证券交集计算覆盖率为 **99.56%**。名单见同目录验收 JSON 的 `webMissingFromDailyBars`。新来源另有一条不在当日日线内的零资金流记录，因此总行数差并不等于逐股缺失数。

## 更新与查询

旧 AKShare 日更和旧 Tinyshare 回补入口已停用；旧表采集写入受 `.logs/fund-flow/legacy-frozen.json` 冻结标记保护。一次性离线导入器也会拒绝在冻结后再次执行。

每日原定北京时间 16:20 的任务现在只调用新来源，单次尝试；取消原 17:20 自动重试。失败后由人工处理，下一交易日的正常计划仍保留，不自动切回 AKShare。Windows 注册脚本也改为单个每日触发器；本次实际部署的是 Linux 服务器。

手动更新（在服务器的 server 目录执行，项目虚拟环境）：

```bash
/opt/quant-backtest/.venv/bin/python src/fundFlow/update.py daily --dry-run
/opt/quant-backtest/.venv/bin/python src/fundFlow/update.py daily
```

上游不提供过去日期，因此不能用此命令补过去漏采日；缺失必须保留并另行核验。默认查询仅使用新来源，历史来源通过单个 `--source` 显式选择，禁止跨源 UNION、拼接或合计：

```bash
# 项目根目录：新来源
node server/scripts/researchData.mjs fund-flows --end 2026-09-24 --days 1
# 仅查询此次历史补数来源
node server/scripts/researchData.mjs fund-flows --end 2026-09-24 --days 3 --source tushare_gateway_eastmoney
# 仅查询原 AKShare 历史
node server/scripts/researchData.mjs fund-flows --end 2026-09-22 --days 3 --source akshare_eastmoney
```

生产查询验收：默认新来源仅返回 9 月 24 日；旧 AKShare 仅返回 9 月 22 日；历史补数来源返回 9 月 23、24 日。各自缺失日期显式返回，没有静默补齐或混算。来源版本、样本数、采集时区随结果返回。管理台显示新来源名称及完成状态。

## 留档与验证

服务器目录 `/opt/quant-backtest/server/.cache/fund-flow-cutover-20260924/`：

- `code-before.tar.gz`：本次涉及文件、原管理台构建和资金流进度的部署前备份。
- `gateway-*.json`、`web-2026-09-24.json`：原始响应。
- `import-plan.json`、`import-applied.json`：导入前表结构、原来源行数、原始响应 SHA-256、排除项统计、逐字段交叉验证和事务结果。旧日期原本为空，未覆盖原业务记录；本次未复制整个 1,404 万行旧表。
- `acceptance.json`、`query-*.json`：入库和来源隔离验收。

临时凭据文件 `/run/quant-fund-flow-backfill-auth` 已删除；未将凭据写入源码、报告或长期配置。此操作不等于撤销网关侧凭据。

通过 Python 11 项测试、资金流查询/目录/报告核验 17 项测试、服务端 TypeScript 检查及管理台生产构建；生产 Python 测试通过。新迁移 `0046_fund_flow_web_datacenter.sql` 已应用，后端已重启，健康检查返回数据库连接正常。Linux 定时器保持运行。

本地验收数据：`fund_flow_cutover_acceptance_20260924.json`。
