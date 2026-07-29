# 13 因子策略实验

复现社交媒体“13 因子”选股逻辑，并进行公告日约束、行业/市值中性化、
五日调仓、交易成本、分层、反向组合与类别消融检验。

## 运行

```powershell
python -m pip install -r scripts/experiments/thirteen_factor/requirements.txt
python scripts/experiments/thirteen_factor/run_experiment.py
```

脚本读取 `server/data/research-snapshots/current.json` 指向的本地研究快照。
所有运行缓存和完整明细写入被 Git 忽略的
`tmp_output/thirteen_factor_experiment/`。

可提交的最终报告和核心汇总位于 `output/thirteen-factor-experiment/`。
