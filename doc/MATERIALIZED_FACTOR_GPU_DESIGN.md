# 复杂因子物化与 GPU 计算设计

## 决策

嵌套时间序列或截面算子不是无效公式，只是不适合编译成单条 DuckDB 窗口 SQL。
此类公式进入 `materialized` 路径；简单公式继续使用现有 `sql` 路径。

## 统一数据契约

```text
factor_values/
  snapshot=<snapshot_id>/
    factor=<candidate_or_version_id>/
      year=YYYY/data.parquet
      manifest.json
```

Parquet 固定字段：

- `tradeDate: DATE`
- `instrumentKey: BIGINT`
- `factorValue: DOUBLE`

`manifest.json` 记录公式 checksum、快照 ID、日期范围、行数、分区校验和、计算后端、
耗时、软件版本和 CPU/GPU 一致性抽检结果。物化目录写入 staging，校验通过后原子发布。

## 执行流程

1. Python 挖掘并冻结公式，不因嵌套窗口丢弃候选。
2. 冻结后创建物化任务，读取不可变研究快照及必要预热区间。
3. 按年份或日期块计算 `(tradeDate, instrumentKey, factorValue)`，批量写 Parquet。
4. Node 锁定测试将行情与物化值按双键 JOIN，不再编译复杂公式。
5. 正式发布后沿用同一物化产物；新快照只追加新日期并保留版本血缘。

锁定测试只能消费公式冻结后生成、checksum 匹配且覆盖完整测试区间的物化产物。

## GPU 路径

配置采用 `compute.backend = auto | cpu | gpu`：

- `auto`：GPU worker 健康且显存预算满足时使用 GPU，否则回退 CPU；
- `gpu`：GPU 不可用时任务失败，不静默改变后端；
- `cpu`：使用 pandas/Dask 分块执行。

Windows 主服务不直接安装 RAPIDS。GPU worker 部署在 WSL2 Ubuntu 的独立 Python 环境，
通过任务 JSON 和 Parquet 目录与主服务交互。当前 RTX 4060 Laptop 只有 8GB 显存，必须按
日期/股票块流式执行，不能一次装载全市场矩阵。

GPU 上线门槛：

- 每个算子具有 CPU/GPU 对照测试；
- 固定样本上 `NaN` 位置一致，有限值误差满足配置容差；
- GPU OOM 自动缩小块大小，`auto` 模式才允许回退 CPU；
- manifest 明确记录实际后端，禁止把混合后端结果标成纯 GPU；
- 基准至少覆盖深层嵌套、滚动窗口、截面排序和中性化四类公式。

## 实施顺序

1. CPU 物化 worker、manifest 与原子 Parquet 发布；
2. Node 物化值 JOIN、候选状态和进度接口；
3. 增量分区、缓存、恢复与清理；
4. WSL2 RAPIDS worker；
5. CPU/GPU 一致性和吞吐基准后再开放 `auto`。
