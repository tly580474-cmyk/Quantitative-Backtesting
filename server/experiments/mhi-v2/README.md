# MHI v2 基本面增量验证

本实验冻结 MHI v1 纯技术基线，不根据历史结果重新调权。新增三个独立观察轴：

- `fundamental_health`：盈利能力与盈利增长；
- `valuation_pressure`：全市场聚合 PE/PB 相对自身历史的压力；
- `market_structure_health`：MHI v1 的纯技术基线，重命名后作为结构状态。

另提供两个仅用于比较的预先声明合成值：技术/基本面等权，以及技术/基本面/估值支持
三轴等权。它们不代表推荐的最终 MHI 公式。

财报只能在 `announcementDate` 当日及以后使用，同一报告期的后续更正保留其更晚公告日。
季度利润与上年同期同季度累计值比较；ROE 按季度累计利润简单年化。现金流质量因季度
覆盖不连续，仅作为诊断项，不进入本轮 FHI。股票需要至少 120 个历史交易观测才能进入
市场横截面。所有未来收益标签先在完整交易日历上生成，再与基本面序列连接。

运行：

```powershell
cd server
npm run duckdb -- pipeline --file ./experiments/mhi-v2/pipeline.json `
  --out-dir ../output/mhi-v2 --threads 8 --max-memory 8GB
```

首次完整验证结论见 [`RESULTS-20260829.md`](./RESULTS-20260829.md)。
