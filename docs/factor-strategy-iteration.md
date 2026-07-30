# 优质因子与冠军/挑战者策略

## 固定研究口径

- 股票池：沪深非 ST、上市满 365 天、排除北交所与科创板、收盘价大于
  1.2 元、20 日平均成交额不低于 2,000 万元。
- 标签：T 日收盘生成信号，T+1 开盘成交，20 个交易日持有；训练
  2010–2021、验证 2022–2023、2024 至快照日为锁定测试。
- 财务终端只使用 `announcementDate <= signalDate` 的最近披露版本，并保留
  `financialReportPeriod`、`financialAnnouncementDate` 与
  `financialSourceVersion`。
- 横截面先做 1%/99% 缩尾和标准化，再做行业中性化；非规模因子额外做
  市值中性化。基本面缺失不填零。

## 组合优化工作器

`tools/factor-miner/portfolio_worker.py` 从 stdin 接收 JSON，并向 stdout 返回
JSON。Node 入口是 `POST /api/factor-strategies/optimize`。

输入至少包含：

- `assets`：`instrumentKey`、`alpha`、`industry`、`sizeExposure`、
  `liquidityExposure`、`adv20`、`priorWeight`、`benchmarkWeight`；
- `returns`：按资产列对齐的至少 20 行日收益（正式运行使用最近 120 日）；
- 可选 `benchmarkIndustryWeights` 与 `outsidePriorWeight`；
- 可选 `constraints`，未提供时使用方案中的正式默认值。

工作器先在综合分 Top50 上优化，再保留权重最大的 30 只并二次优化。协方差
使用 Ledoit–Wolf 收缩，求解器使用 SciPy SLSQP。响应包含目标权重、预测波动、
跟踪误差、换手和逐项约束余量。`status=failed` 时权重恒为空，调用方必须保持
原仓位并告警。

## 策略治理 API

- `POST /api/factor-strategies`：创建不可变的 draft 版本（5–8 个因子）。
- `POST /api/factor-strategies/:id/evaluate`：执行候选门禁并记录锁定测试。
- `POST /api/factor-strategies/:id/start-paper`：启动 100 万元模拟观察。
- `POST /api/factor-strategies/:id/observations`：写入逐调仓周期表现与违规。
- `GET /api/factor-strategies/:id/performance`：读取评估和模拟盘审计轨迹。
- `POST /api/factor-strategies/:id/promote`：人工批准晋级。

状态机为 `draft → validated → paper → champion/rejected`。晋级接口会以数据库
中实际记录的周期数和违规为准，至少观察 6 个周期，并同时检查合格池等权和
中证 500 的超额与信息比率。系统没有自动实盘发布接口。

迁移 `0035_factor_strategy_iteration.sql` 保存策略定义、评估、模拟观察和冠军
替换审计。因子挖掘缓存与报告默认写入 `tmp_output/factor-miner`，不进入 Git。
服务端调度器每月生成自包含 HTML 模拟盘汇总到 `tmp_output/strategy-reports`，
并在每个季度从当前冠军复制一个新的 draft 挑战者；复制不会自动验证或晋级。
