# 13 因子实验结果

结论：**部分证实——排序有效，等权 13 因子组合未战胜合格股票等权基准。**

- 综合 Rank IC：0.044
- Q5−Q1 平均五日收益差：0.31%
- Top100 成本后 CAGR：9.74%
- 合格股票等权 CAGR：10.08%
- 表现最好的子类别为低换手率，成本后 CAGR 为 31.53%

文件说明：

- `report.html`：自包含实验报告
- `run_metadata.json`：数据快照、参数、环境与最终结论
- `strategy_metrics.csv`：策略级绩效指标
- `factor_ic.csv`：逐调仓日、逐因子的 Rank IC 与覆盖率
- `period_returns.csv`：逐调仓期的策略收益、换手和成本

大体积信号面板、持仓明细、Parquet 缓存和本地 Python 依赖保留在
`tmp_output/thirteen_factor_experiment/`，不进入 Git。
