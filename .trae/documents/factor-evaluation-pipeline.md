# 评分规则探索 — 因子评估与复合评分流水线

## Summary

实现从 DuckDB 快照加载真实市场数据、跨股票 × 跨日期批量计算因子面板、用 IC/ICIR/分层收益评估单因子有效性、并基于 ICIR 加权合成最终评分的端到端流水线。本计划在已完成的项目骨架（27 个因子 + IC/分层评估器 + 未来函数检测）之上补齐数据加载、面板构造、评估编排、复合评分四层，并提供示例脚本与配置。

## Current State Analysis

### 已实现（src/factors/, src/evaluation/, src/utils/, src/lookahead/）
- 27 个因子（19 技术 + 8 基本面），通过 62 个测试
- IC（Pearson + Spearman Rank）、ICIR（年化）、分层收益（NTILE + 多空价差 + 单调性）实现完成，等待 `factor_panel`（行=tradeDate, 列=instrumentKey）与 `return_panel`（同形状，未来收益）输入
- 未来函数检测三道防线：静态扫描 + 运行时断言 + Walk-forward 校验
- 交易日历工具与统计工具完整

### 待实现（缺口）
- `src/data/` 4 个文件全空（`connection.py`、`schema.py`、`loader.py`、`__init__.py`）
- 无面板计算模块（factor_panel / return_panel 构造）
- 无评估编排器（loader + panel + ic + layered 的端到端串联）
- 无复合评分模块（基于 ICIR 加权）
- `pyproject.toml`、`config.yaml`、`README.md` 均为空占位
- `tests/` 下无 `test_data.py`、`test_panel.py`、`test_evaluation.py`、`test_scoring.py`

### 关键约束（来自用户决策）
1. **时间范围**：近 5 年（2021-07-25 ~ 2026-07-24）
2. **股票池**：A股主板（SH+60开头 / SZ+00开头），不含创业板(300)/科创板(688)/北交所(8xx)
3. **流动性过滤**：日成交额 ≥ 1000 万（`DEFAULT_MIN_DAILY_AMOUNT`）
4. **收益口径**：T+1 开盘 → T+N 收盘（horizon=5，与原 selectionScore 回测口径一致，前视偏差防护最严）
5. **无 CLI**，仅 Python API + 示例脚本

### 上游 DuckDB 快照系统（来自 Phase 1 探索）
- 路径模式：`${root}/${snapshotId}/bars/year=*/*.parquet`，Hive 分区
- 指针文件 `current.json`（snapshotId, publishedAt）+ `manifest.json`（rowCount, instrumentCount, minDate, maxDate, partitions, datasets, SHA-256）
- DuckDB 字段为 **camelCase**：`tradeDate, instrumentKey, market, symbol, name, industry, open, high, low, close, previousClose, volume, amount, turnoverRatePct, totalMarketCap, floatMarketCap, peTtm, pb, psTtm, volumeRatio`
- 当前快照：5,824 只股票，2000-01-04 ~ 2026-07-24，1,711 万行
- DuckDB 字段 `volumeRatio` 是市场量比指标（与因子 `volume_ratio` 同名异义，**不加载**）

### 字段映射差异（关键）
| DuckDB（camelCase） | Python（snake_case，因子依赖） | 类别 |
|---|---|---|
| tradeDate | tradeDate（保留） | 标识 |
| instrumentKey | instrumentKey（保留） | 标识 |
| market/symbol/name/industry | 同名 | 标识 |
| open/high/low/close/volume/amount | 同名 | K线 |
| turnoverRatePct | turnover_rate | 衍生 |
| totalMarketCap | market_cap | 基本面 |
| floatMarketCap | float_market_cap | 基本面 |
| peTtm | pe_ttm | 基本面 |
| pb | pb | 基本面 |
| psTtm | ps_ttm | 基本面 |
| —（缺失） | dividend_yield | 基本面（独立 dividend_events 数据集） |

## Proposed Changes

### 阶段 1：数据加载层（`src/data/`，最关键）

#### 1.1 `src/data/connection.py` — DuckDB 连接工厂
**做什么**：封装 DuckDB 连接与快照定位
**为什么**：所有下游模块依赖统一的连接入口；需要正确读取 `current.json` + `manifest.json` 才能定位 Parquet glob
**怎么做**：
- `SnapshotInfo` dataclass：`snapshot_id, manifest: dict, bars_glob: str, datasets: dict, root: Path`
- `read_current_snapshot(root: Path) -> SnapshotInfo`：读 `current.json` → 读 `${snapshotId}/manifest.json` → 校验 `schemaVersion==1 && status=='validated'` → 构造 `bars_glob = "${root}/${snapshotId}/bars/year=*/*.parquet"`
- `DuckDBSession` 类：持有 `duckdb.connect()` 句柄，配置 `PRAGMA threads=<N>` / `PRAGMA memory_limit='<X>'`，提供 `execute(sql, params)`、`close()`、上下文管理器（`__enter__`/`__exit__`）
- `open_duckdb_session(snapshot_root: Path | str, snapshot_id: str | None = None, threads: int = 4, max_memory: str = "2GB") -> DuckDBSession`：若 `snapshot_id` 为 None，调 `read_current_snapshot` 自动定位
- 引用：参考 [duckdbResearchService.ts](file:///d:/github_public_repo/量化回测/server/src/research/duckdbResearchService.ts) 第 62-85 行 `queryResearchSnapshot` 与 [duckdbRuntime.ts](file:///d:/github_public_repo/量化回测/server/src/research/duckdbRuntime.ts) 第 26-56 行连接管理
- 依赖：`pip install duckdb`（在阶段 5.1 加入 pyproject.toml）

#### 1.2 `src/data/schema.py` — 字段契约与映射
**做什么**：定义 DuckDB 字段 → Python 列名的映射、主板过滤逻辑
**为什么**：因子声明依赖 `snake_case`（如 `pe_ttm`），但 DuckDB 字段是 `camelCase`（如 `peTtm`），必须在 loader 层统一转换；主板过滤需要明确的 SQL 片段
**怎么做**：
- `DUCKDB_TO_PYTHON: dict[str, str]` 字典：完整字段映射表（见上方"字段映射差异"表）
- `REQUIRED_KLINE_FIELDS: tuple[str, ...]`：因子依赖的字段集合（tradeDate, instrumentKey, open, high, low, close, volume, amount, turnover_rate, market_cap, float_market_cap, pe_ttm, pb, ps_ttm）
- `MAIN_BOARD_MARKETS: tuple[str, ...] = ("SH", "SZ")`
- `MAIN_BOARD_PREFIXES: tuple[str, ...] = ("60", "00")`
- `MAIN_BOARD_FILTER_SQL: str`：`"market IN ('SH', 'SZ') AND (symbol LIKE '60%' OR symbol LIKE '00%')"`
- `is_main_board(market: str, symbol: str) -> bool`：Python 端过滤函数

#### 1.3 `src/data/loader.py` — K 线加载与未来收益计算
**做什么**：从 DuckDB 加载 K 线长表，做股池过滤与流动性过滤，计算未来收益
**为什么**：评估层需要 (1) 按股票切片的 K 线 DataFrame 供因子 compute 调用；(2) 与 factor_panel 对齐的 return_panel
**怎么做**：
- `load_candles(session, start_date, end_date, markets=("SH","SZ"), min_daily_amount=10_000_000) -> pd.DataFrame`
  - SQL: `SELECT instrumentKey, market, symbol, name, industry, tradeDate, open, high, low, close, volume, amount, turnoverRatePct, totalMarketCap, floatMarketCap, peTtm, pb, psTtm FROM read_parquet('<bars_glob>', hive_partitioning=true) WHERE tradeDate BETWEEN ? AND ? AND <MAIN_BOARD_FILTER_SQL> AND amount >= ? ORDER BY instrumentKey, tradeDate`
  - 加载后用 `df.rename(columns=DUCKDB_TO_PYTHON)` 转列名为 snake_case
  - 输出长表（long format）：tradeDate, instrumentKey, OHLC, volume, amount, turnover_rate, market_cap, float_market_cap, pe_ttm, pb, ps_ttm
- `load_candles_for_instrument(session, instrument_key, end_date, lookback_days=120) -> pd.DataFrame`
  - 加载单只股票截至 end_date 的 lookback_days 天 K 线（供单因子 compute 调用，避免全量加载）
- `compute_forward_returns(candles_long: pd.DataFrame, horizon: int = 5) -> pd.DataFrame`
  - 按 instrumentKey 分组，按 tradeDate 排序
  - 计算 `forward_return = close.shift(-horizon) / open.shift(-1) - 1`
  - 注意：T 日的 forward_return 用 T+1 开盘与 T+horizon 收盘，**不使用 T 当日数据**，严格无前视偏差
  - 输出：在原长表上增加一列 `forward_return_{horizon}d`
- 引用：参考 [duckdbResearchService.ts](file:///d:/github_public_repo/量化回测/server/src/research/duckdbResearchService.ts) 第 126-168 行 `buildResearchQuery` 的字段白名单与 SQL 编译

#### 1.4 `src/data/__init__.py` — 公共 API
导出：`DuckDBSession, SnapshotInfo, read_current_snapshot, open_duckdb_session, load_candles, load_candles_for_instrument, compute_forward_returns, DUCKDB_TO_PYTHON, REQUIRED_KLINE_FIELDS, MAIN_BOARD_FILTER_SQL, is_main_board`

#### 1.5 `tests/test_data.py`
**做什么**：测试连接、字段映射、股池过滤、未来收益计算
**怎么做**：
- `test_field_mapping`：验证 DUCKDB_TO_PYTHON 覆盖所有因子依赖字段
- `test_is_main_board`：SH+60 通过、SZ+00 通过、SZ+300（创业板）拒绝、SH+688（科创板）拒绝、BJ+8 拒绝
- `test_compute_forward_returns_no_lookahead`：构造合成 K 线，扩展数据后历史日期的 forward_return 不变
- `test_compute_forward_returns_known_value`：T 日 open=10/close=11、T+1 open=10.5/close=12、T+5 close=13 → forward_return_5d = 13/10.5 - 1 ≈ 0.238
- `test_load_candles_with_synthetic_parquet`：在临时目录构造小 Parquet 快照（5 只股票 × 30 日），验证 loader 加载结果形状与字段
- 注意：不依赖真实快照（CI 友好），用 `tmp_path` fixture + `pyarrow.parquet` 写测试数据

### 阶段 2：因子面板计算（新建 `src/panel/`）

#### 2.1 `src/panel/builder.py` — 跨股票批量计算因子值
**做什么**：输入 K 线长表，输出因子宽表（行=tradeDate, 列=instrumentKey, 值=因子值）
**为什么**：IC/分层评估器要求宽表面板输入；逐 (instrument, date) 调用 factor.compute 时需复用 K 线切片以减少重复加载
**怎么做**：
- `build_factor_panel(candles_long: pd.DataFrame, factor_id: str, registry: FactorRegistry = DEFAULT_REGISTRY) -> pd.DataFrame`
  - 按 instrumentKey 分组，每组按 tradeDate 升序
  - 对每只股票：从首个 tradeDate 开始滑动窗口，对每个 T 调 `factor.compute(candles_up_to_T, T)`，收集 factor_value
  - 输出 `pd.DataFrame`，index=tradeDate, columns=instrumentKey, values=factor_value
  - 缺失值（数据不足或计算返回 None）填充为 NaN
- `build_all_factor_panels(candles_long: pd.DataFrame, factor_ids: list[str], registry: FactorRegistry = DEFAULT_REGISTRY) -> dict[str, pd.DataFrame]`
  - 单次遍历 K 线，对每个 (instrument, date) 调用所有因子 compute，收集到各自的 panel
  - 避免重复加载与切片

#### 2.2 `src/panel/returns.py` — 未来收益面板
**做什么**：构造与 factor_panel 对齐的 return_panel
**为什么**：IC 评估器要求 factor_panel 与 return_panel 形状、索引、列完全一致（见 [ic.py](file:///D:/github_public_repo/评分规则探索/src/evaluation/ic.py) 第 44-51 行硬校验）
**怎么做**：
- `build_return_panel(candles_long: pd.DataFrame, horizon: int = 5) -> pd.DataFrame`
  - 调 `loader.compute_forward_returns(candles_long, horizon)`
  - pivot 为宽表：index=tradeDate, columns=instrumentKey, values=`forward_return_{horizon}d`
  - 与 factor_panel 自动对齐（同一份 candles_long 派生，索引/列天然一致）

#### 2.3 `src/panel/__init__.py`
导出：`build_factor_panel, build_all_factor_panels, build_return_panel`

#### 2.4 `tests/test_panel.py`
- `test_factor_panel_shape`：合成 5 股 × 30 日数据，验证 panel 形状为 (30, 5)
- `test_factor_panel_alignment`：factor_panel 与 return_panel 的 shape/index/columns 完全一致
- `test_factor_panel_no_lookahead`：扩展 K 线数据后，历史 tradeDate 的因子值不变（沿用 test_factors.py 的 TestNoLookaheadBias 风格）
- `test_factor_panel_handles_insufficient_data`：当某股数据不足 warmup_days 时，对应列为 NaN，不抛异常

### 阶段 3：评估流水线（扩展 `src/evaluation/`）

#### 3.1 `src/evaluation/runner.py` — 单因子评估编排
**做什么**：编排 loader + panel + ic + layered，端到端评估单个因子
**为什么**：当前 ic.py/layered.py 已实现，但需要编排器把数据加载、面板构造、IC 计算、分层计算串起来，并提供统一返回结构
**怎么做**：
- `FactorEvaluationReport` dataclass：`factor_id, factor_name, direction, sample_count, trading_days, ic_summary: ICSummary, layered_report: LayeredReport, evaluated_at: str`
- `evaluate_single_factor(factor_id: str, candles_long: pd.DataFrame, horizon: int = 5, layers: int = 5, min_samples: int = 30, registry: FactorRegistry = DEFAULT_REGISTRY) -> FactorEvaluationReport`
  - 调 `build_factor_panel(candles_long, factor_id, registry)` → factor_panel
  - 调 `build_return_panel(candles_long, horizon)` → return_panel
  - 调 `compute_daily_ic(factor_panel, return_panel, min_samples)` → daily_metrics
  - 调 `summarize_ic(daily_metrics)` → ic_summary
  - 调 `compute_layered_returns(factor_panel, return_panel, layers, min_samples)` → layered_report
  - 包装为 FactorEvaluationReport
- `evaluate_all_factors(candles_long, horizon, layers, min_samples, factor_ids=None, registry=DEFAULT_REGISTRY) -> dict[str, FactorEvaluationReport]`
  - 复用同一份 candles_long 与 return_panel（避免重复构造）
  - factor_ids 默认为 `list_all_factor_ids()`

#### 3.2 `src/evaluation/report.py` — 报告格式化
**做什么**：把 FactorEvaluationReport 渲染为人类可读文本与汇总表
**为什么**：示例脚本需要打印汇总结果，便于人工审阅
**怎么做**：
- `format_report(report: FactorEvaluationReport) -> str`：单因子详细文本（含 IC/ICIR/分层明细）
- `summarize_all(reports: dict[str, FactorEvaluationReport]) -> pd.DataFrame`：汇总表，列 = `[factor_id, direction, avg_ic, avg_rank_ic, rank_ic_ir, long_short_spread, monotonicity, sample_count, trading_days]`
- `format_summary_table(df: pd.DataFrame) -> str`：Markdown 表格

#### 3.3 `src/evaluation/__init__.py` 更新
追加导出：`evaluate_single_factor, evaluate_all_factors, FactorEvaluationReport, format_report, summarize_all, format_summary_table`

#### 3.4 `tests/test_evaluation.py`
- `test_evaluate_single_factor_synthetic`：合成 50 股 × 100 日数据，某因子与未来收益强正相关（如 `return_5d` 因子），验证 avg_ic > 0.3
- `test_evaluate_single_factor_random`：合成随机数据，验证 |avg_ic| < 0.2（无显著相关性）
- `test_evaluate_all_factors_returns_dict`：批量评估返回 dict，键为 factor_id
- `test_summarize_all_columns`：汇总表包含所有预期列

### 阶段 4：复合评分（新建 `src/scoring/`）

#### 4.1 `src/scoring/normalizer.py` — 因子值横截面标准化
**做什么**：将每个 tradeDate 的因子值横截面标准化
**为什么**：不同因子量纲差异巨大（如 PE 是 10-40，return 是 -0.1~0.1），合成前必须标准化
**怎么做**：
- `zscore_normalize(panel: pd.DataFrame) -> pd.DataFrame`：按行（每个 tradeDate）减均值除标准差，clip 到 [-3, 3] 防极端值
- `rank_normalize(panel: pd.DataFrame) -> pd.DataFrame`：按行 rank，映射到 [-1, 1]
- 处理 NaN：标准化时忽略，结果仍为 NaN
- 处理方向：`adjust_direction(panel, direction) -> pd.DataFrame`：若 `direction == LOWER_IS_BETTER`，取负号；若 `RESEARCH`，原值保留（后续单独处理或排除）

#### 4.2 `src/scoring/composite.py` — ICIR 加权合成评分
**做什么**：用 |ICIR| 作为权重，合成多因子综合评分
**为什么**：替代原始 selectionScore 的固定分值规则；ICIR 是业界公认的因子有效性指标，加权后能突出强因子、抑制弱因子
**怎么做**：
- `CompositeScorer` 类：
  - `__init__(factor_directions: dict[str, str])`：因子 ID → direction 映射
  - `fit(ic_weights: dict[str, float])`：传入 `{factor_id: |rank_ic_ir|}`，归一化为权重（和为 1）
  - `score(factor_panels: dict[str, pd.DataFrame], normalize: str = "zscore") -> pd.DataFrame`
    - 输入：每个因子的 factor_panel
    - 步骤：(1) 按方向调整符号；(2) 标准化；(3) 加权求和
    - 输出：复合评分面板（行=tradeDate, 列=instrumentKey, 值=综合分）
  - `evaluate(composite_panel: pd.DataFrame, return_panel: pd.DataFrame, horizon: int = 5, layers: int = 5) -> LayeredReport`
    - 调 `compute_layered_returns(composite_panel, return_panel, layers)` 评估复合评分的预测能力

#### 4.3 `src/scoring/__init__.py`
导出：`CompositeScorer, zscore_normalize, rank_normalize, adjust_direction`

#### 4.4 `tests/test_scoring.py`
- `test_zscore_normalize`：合成面板，验证每行均值≈0、标准差≈1
- `test_rank_normalize`：验证 rank 映射到 [-1, 1]
- `test_composite_strong_factors_dominate`：构造 3 个因子（2 个强正相关 + 1 个随机），验证复合评分 IC 高于随机因子
- `test_composite_long_short_spread`：合成数据下，复合评分顶层的平均收益 > 底层

### 阶段 5：配置与示例脚本

#### 5.1 `pyproject.toml` — 依赖锁定
```toml
[project]
name = "score-rule-exploration"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = [
    "pandas>=2.0",
    "numpy>=1.24",
    "duckdb>=0.10",
    "pyarrow>=14.0",
    "python-dotenv>=1.0",
    "pyyaml>=6.0",
]

[project.optional-dependencies]
dev = ["pytest>=9.0", "pytest-cov>=4.0"]

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
addopts = "-v --tb=short"
```

#### 5.2 `config.yaml` — 静态查询参数
```yaml
evaluation:
  default_start_date: "2021-07-25"
  default_end_date: "2026-07-24"
  default_horizon: 5
  default_layers: 5
  default_min_daily_amount: 10000000
  markets: ["SH", "SZ"]
  main_board_prefixes: ["60", "00"]

duckdb:
  threads: 4
  max_memory: "2GB"

snapshot:
  root: "${SNAPSHOT_ROOT}"  # 由 .env 注入,默认指向量化回测项目快照
```

#### 5.3 `scripts/run_evaluation.py` — 单因子评估示例脚本
**做什么**：加载配置 → 加载 K 线 → 批量评估 27 个因子 → 打印汇总表 → 保存详细报告
**怎么做**：
- `python-dotenv` 加载 `.env`（参考 `.env.example`）
- `pyyaml` 加载 `config.yaml`
- 调 `open_duckdb_session` → `load_candles` → `evaluate_all_factors`
- 打印 `summarize_all(reports)` 的 Markdown 表格到 stdout
- 保存详细报告到 `output/factor_evaluation_<timestamp>.md`（含每个因子的 format_report）

#### 5.4 `scripts/run_composite.py` — 复合评分示例脚本
**做什么**：加载 K 线 → 评估所有因子 → 用 |rank_ic_ir| 作权重 → 合成复合评分 → 评估复合评分的分层收益
**怎么做**：
- 复用 `run_evaluation.py` 的加载逻辑
- 调 `evaluate_all_factors` 得到 `reports`
- 提取 `{factor_id: report.ic_summary.rank_ic_ir}` 作为权重
- 构造 `CompositeScorer(factor_directions={f: registry.get(f).definition().direction for f in factor_ids})`
- 调 `scorer.fit(weights)` → `scorer.score(factor_panels)` → `scorer.evaluate(composite_panel, return_panel)`
- 打印复合评分的 long_short_spread、monotonicity，与单因子对比

## Assumptions & Decisions

1. **时间范围**：近 5 年（2021-07-25 ~ 2026-07-24），用户决策
2. **股池**：A股主板（SH+60 / SZ+00），用户决策
3. **流动性过滤**：日成交额 ≥ 1000 万（`DEFAULT_MIN_DAILY_AMOUNT`）
4. **收益口径**：T+1 开盘 → T+5 收盘，最严格的前视偏差防护
5. **字段名映射**：DuckDB camelCase → Python snake_case，在 loader 层统一转换
6. **dividend_yield 缺失**：`DividendYieldFactor` 在评估时若该字段不存在则返回 None，因子值被排除；后续可扩展 loader 从 `dividend_events` 数据集计算
7. **DuckDB volumeRatio 列不加载**：避免与因子 `volume_ratio` 命名冲突（因子自己用 volume 算）
8. **CLI**：不实现，仅 Python API + 示例脚本（用户决策）
9. **复用现有量化回测项目的快照**：`SNAPSHOT_ROOT` 默认指向 `D:/github_public_repo/量化回测/server/data/research-snapshots`
10. **并行化**：首版单线程，若性能不足再加 multiprocessing（5 年主板约 3000 股 × 1200 日 = 360 万 compute 调用，单因子约 60 秒，27 因子约 30 分钟）
11. **复权处理**：首版使用未复权价（快照 `bars` 表原生数据），与原 selectionScore 行为一致；后续如需前复权，可改用快照的 `stock_prices_qfq` 视图（参考 [duckdbCli.ts](file:///d:/github_public_repo/量化回测/server/src/research/duckdbCli.ts) 第 763-978 行）
12. **行业中性化**：首版不做（裸评估），后续可扩展

## Verification Steps

### 单元测试（无需真实快照）
- `tests/test_data.py`：字段映射、股池过滤、未来收益无前视偏差、合成 Parquet 加载
- `tests/test_panel.py`：面板形状、对齐、无前视偏差
- `tests/test_evaluation.py`：合成数据端到端评估
- `tests/test_scoring.py`：复合评分在合成数据下的预期行为
- 全部用 `tmp_path` fixture + `pyarrow.parquet` 构造测试 Parquet，CI 友好

### 集成测试（需真实快照）
- 运行 `scripts/run_evaluation.py`，验证：
  - 27 个因子的 ICSummary 全部非空（除 `dividend_yield` 因字段缺失返回 None）
  - 至少 50% 因子的 |avg_rank_ic| > 0.02（弱有效）
  - 至少 1 个因子的 long_short_spread > 0.5%（年化约 5%）
- 运行 `scripts/run_composite.py`，验证：
  - 复合评分的 long_short_spread > 单因子的中位数
  - 复合评分的 monotonicity > 0.5

### 性能基线
- 单因子评估近 5 年主板（约 3000 股 × 1200 日）应在 60 秒内完成
- 27 个因子批量评估应在 30 分钟内完成
- 复合评分计算应在 10 秒内完成

### 回归测试
- 现有 91 个测试（test_factors + test_lookahead + test_stats）必须继续通过
- 新增测试需覆盖新模块的所有公共 API

## Implementation Order

1. **阶段 5.1（pyproject.toml）**：先补依赖声明，确保 duckdb 等可安装
2. **阶段 1.1-1.4**：数据加载层（最关键，所有下游依赖）
3. **阶段 1.5**：测试数据加载
4. **阶段 2.1-2.3**：面板计算
5. **阶段 2.4**：测试面板
6. **阶段 3.1-3.3**：评估流水线
7. **阶段 3.4**：测试评估
8. **阶段 4.1-4.3**：复合评分
9. **阶段 4.4**：测试复合评分
10. **阶段 5.2-5.4**：config.yaml + 两个示例脚本
11. **端到端验证**：用真实快照运行两个示例脚本，检查性能基线与有效性指标

## 风险与缓解

1. **风险**：DuckDB Python 包未在系统中安装
   **缓解**：阶段 5.1 先写 pyproject.toml，立即 `pip install -e .` 验证

2. **风险**：单线程性能不足（5 年主板 27 因子超过 30 分钟）
   **缓解**：先跑通正确性，性能不达标再加 `multiprocessing.Pool` 按 instrumentKey 并行

3. **风险**：真实快照路径不存在（用户机器未运行量化回测项目）
   **缓解**：示例脚本提供 `--snapshot-root` 参数；测试不依赖真实快照，用合成 Parquet

4. **风险**：因子 `dividend_yield` 字段缺失导致评估报错
   **缓解**：`DividendYieldFactor.compute` 已返回 None，loader 不加载该字段时该因子 panel 全 NaN，IC 计算自动跳过（min_samples 不达标）

5. **风险**：camelCase → snake_case 映射遗漏字段
   **缓解**：阶段 1.5 的 `test_field_mapping` 校验所有因子 dependencies 都在映射表中有对应
