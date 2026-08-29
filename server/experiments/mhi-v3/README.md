# MHI v3：宏观增量验证

本实验在 MHI v2 的市场结构、财务基本面和估值三轴之外，增加三条**不合成**的宏观轴：

- 增长景气：制造业 PMI 水平（60%）与三个月变化（40%）；
- 名义需求：PPI 同比（60%）与三个月变化（40%）；
- 货币活性：M1-M2 剪刀差（60%）与三个月变化（40%）。

权重在查看结果前固定。每个分项仅使用此前 60 个月历史分布归一化，至少需要 36 个月历史。

## 数据和时间口径

运行 `python experiments/mhi-v3/fetch_macro.py` 固化 AKShare 抓取结果及 manifest。当前 AKShare
三个接口的实际抓取页均为东方财富镜像，不是统计局/央行直连接口；官方网页用于定义、发布时间
和抽样核对。原始 CSV 是最新修订后的历史序列，不是逐月首发 vintage，因此仍可能存在修订偏差。

为降低明显的未来数据泄漏，实验使用保守可用日：PMI 为观察月结束次日，PPI 为次月 15 日，
货币供应为次月 20 日。发布后在下一交易日通过 ASOF join 生效。

人民银行从 2025 年 1 月起修订 M1 口径，而 AKShare 镜像中的 2024 年仍是旧口径。实验不做
人为拼接，货币活性轴只验证到 2024 年末；PMI 和 PPI 两轴继续覆盖后续时期。

## 运行

```powershell
cd server
python experiments/mhi-v3/fetch_macro.py
python experiments/mhi-v3/audit_macro.py
npm run experiment:mhi:v3 -- --out-dir ../output/mhi-v3
```

结论优先读取 `monthly-axis-validation.csv`。`daily-axis-validation.csv` 只描述投资者每天实际持有的
宏观状态，不应把重复的月度状态误认为独立观测。
