# 趋势动量选股验证

固定研究快照上验证“均线趋势 + 相对沪深300动量 + 量价确认 + MA60
止损”，并通过逐步加入规则的四组消融实验识别各环节的真实边际贡献。

执行：

```powershell
$py = 'C:\Users\qjmzc\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $py scripts/experiments/trend_momentum/run_experiment.py
```

全部中间表、选股、交易、逐期收益和报告保存在
`tmp_output/trend_momentum_experiment/`；唯一结论报告同步复制到
`output/trend_momentum_validation_report.html`。

交易口径为信号日收盘后计算、下一交易日开盘成交，每20个交易日调仓。
收益价格使用 `close / previousClose` 逐日链式合成；`previousClose` 是行情源已按
除权除息重置的昨收。这样既保留可交易收益，又避免线性前复权价格接近零时产生
畸变的跨期百分比收益。
