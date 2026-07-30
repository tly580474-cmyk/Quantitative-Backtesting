# 趋势动量卖出策略验证

在趋势动量实验完全相同的入场信号上，对照五种卖出规则：

1. 仅20日调仓复核；
2. 收盘跌破MA60；
3. MA60或连续两日收盘跌破MA20；
4. MA60或浮盈达到15%后的8%最高收盘回撤；
5. 上述三种风险退出的组合。

所有卖出均在收盘触发后的下一可交易日开盘执行。停牌则顺延；后续不再有
报价的退市仓位按损失100%处理。

先运行基础实验，再运行本实验：

```powershell
$py = 'C:\Users\qjmzc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $py scripts/experiments/trend_momentum/run_experiment.py
& $py scripts/experiments/trend_momentum_exit/run_experiment.py
```

完整产物写入 `tmp_output/trend_momentum_exit_experiment/`，结论报告同步复制到
`output/trend_momentum_sell_strategy_report.html`。
