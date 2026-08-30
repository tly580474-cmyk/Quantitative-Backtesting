# 因子研究口径

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

## 研究工件

因子挖掘缓存与报告默认写入 `tmp_output/factor-miner`，不进入 Git。
