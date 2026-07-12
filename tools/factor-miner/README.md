# 自动因子挖掘运行时

本目录是量化回测项目内置的遗传规划因子挖掘运行时。服务端通过独立 Python
进程调用 `worker_entry.py`，候选结果先进入候选库；冻结、锁定测试、人工批准和
发布仍由主项目负责。

## 本地运行

```powershell
python -m pip install -r requirements.txt
python run_mining.py --config factor_miner/config/default.yaml
```

服务端会覆盖任务对应的快照、日期边界、随机种子和资源预算。默认配置仅供独立
调试使用，数据来源为主项目发布的只读研究快照。

该目录只包含运行所需源码、配置和测试；实验输出、缓存、探针文件及本地凭据均
未迁入。原实验目录仍保留，作为迁移期回滚参考。
