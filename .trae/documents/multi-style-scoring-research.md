# 多风格选股评分研究计划

## 摘要

在现有"评分规则探索"项目基础上,新增 4 种投资风格的评分研究(价值投资/成长型/趋势型/短线打板),与现有"逆向抄底"风格并列对比。研究采用"主观方向 + 数据驱动权重"混合方法,允许新增 8 个纯 K 线可算的衍生因子(不引入新数据源)。最终产出一份多风格对比研究报告,作为现有 SCORE_RESEARCH_REPORT_FINAL.md 的姊妹篇。

**核心约束**:不修改任何现有文件(包括 `src/factors/technical.py`、`fundamental.py`、`vectorized.py`、`composite.py` 等),所有新增代码放在新目录中。

---

## 一、现状分析(基于 Phase 1 探索)

### 1.1 现有评分系统本质

现有 27 个因子 + `CompositeScorer` 经 5 年全量评估,被数据驱动校准为"A 股主板中期反转/量价"单一风格:
- horizon=5d 多空价差 +0.43%,单调性 0.83
- horizon=10d 多空价差 +0.93%,单调性 0.88
- horizon=20d 多空价差 +1.77%,单调性 0.94
- horizon=1d 多空价差 -0.04%,单调性 -0.77(失效)

27 个因子的 `direction` 字段是数据驱动校准的结果,本质反映"反转"理念:return_20d=lower、breakout_20d=lower、ma60_slope_5d=lower 等。

### 1.2 数据源硬约束

DuckDB 快照可用字段(经 `src/data/loader.py` 的 `_DUCKDB_FIELDS` 确认):
- 标识:`instrumentKey, market, symbol, name, industry, tradeDate`
- OHLCV:`open, high, low, close, volume, amount`
- 基本面(6 个):`turnoverRatePct, totalMarketCap, floatMarketCap, peTtm, pb, psTtm`

**不可得数据**:`dividend_yield`(死代码)、`ROE`、营收增速、净利润、涨停标识、龙虎榜、北向资金、研报评级。

### 1.3 关键架构发现

- `src/factors/base.py`:`FactorBase` / `FactorDefinition` / `FactorDirection` / `FactorRegistry` 接口清晰
- `src/scoring/composite.py`:`CompositeScorer` 通过 `factor_directions` 参数接受方向,可在调用时覆盖因子默认 direction
- `src/panel/vectorized.py`:`build_all_factor_panels_vectorized` 一次性构造所有面板
- `src/evaluation/ic.py` + `layered.py`:与 horizon 解耦,可复用
- 现有测试 202 个全过

### 1.4 风格覆盖差距

| 风格 | 现有覆盖 | 关键缺口 |
|---|---|---|
| 逆向抄底(现有) | 完全覆盖 | - |
| 价值投资 | 4 估值因子,但方向是"价值陷阱"(higher) | 需主观翻转为 lower;缺 dividend_yield |
| 成长型 | 几乎无覆盖 | 缺营收/利润增速;可用 60 日动量代理成长性 |
| 趋势型 | 4 趋势因子但方向是反转(lower) | 需主观翻转为 higher;缺 ATR/海龟突破/多头排列强度 |
| 短线打板 | 量能因子但方向是反转 | 缺连板数/KDJ/BIAS/日内强度;horizon=1d 复合评分已失效 |

---

## 二、研究设计

### 2.1 5 种投资风格定义

| 风格 | 风险等级 | 目标 horizon | 核心理念 | 因子来源 |
|---|---|---|---|---|
| 逆向抄底(进取) | 高 | 5d | 跌深反弹、超卖修复、放量后回调 | 现有 26 因子(基线) |
| 价值投资(稳健) | 低 | 20d | 低估值、大盘稳健、低换手 | 现有估值/规模/流动性/风险(方向主观翻转) |
| 成长型(稳中求进) | 中 | 20d | 高动量、高估值、放量上涨 | 现有动量/估值/量能(方向主观翻转)+ 新增 momentum_60d |
| 趋势型(进取) | 高 | 20d | 均线多头、突破信号、趋势延续 | 现有趋势/动量(方向主观翻转)+ 新增 3 个趋势因子 |
| 短线打板(激进) | 极高 | 1d~3d | 涨停接力、量价齐升、强势延续 | 现有量能/动量(方向翻转)+ 新增 5 个短线因子 |

### 2.2 新增 K 线衍生因子(8 个)

纯 K 线可算,不引入新数据源,放在 `src/factors/style_specific/` 新目录。

| factor_id | 类别 | 公式 | 默认 direction | 主要服务风格 |
|---|---|---|---|---|
| `atr_20` | 风险/趋势 | ATR(20) = MA(TR, 20), TR=max(H-L, \|H-C_prev\|, \|L-C_prev\|) | higher | 趋势型 |
| `turtle_breakout_20` | 趋势 | (close - high_20d_prev) / high_20d_prev,突破为正 | higher | 趋势型 |
| `ma_alignment_strength` | 趋势 | 加权多头排列强度:0.4×(MA5>MA10)+0.3×(MA10>MA20)+0.3×(MA20>MA60),按距离加权 | higher | 趋势型 |
| `limit_up_consecutive` | 短线 | 连续涨停天数(涨幅>=9.5% 视为涨停,主板 10% 限制) | higher | 短线打板 |
| `kdj_j` | 短线/振荡 | 标准 KDJ(9,3,3) 的 J=3K-2D | higher | 短线打板 |
| `bias_6` | 短线 | (close - MA6) / MA6 | higher | 短线打板 |
| `momentum_60d` | 成长/动量 | close / close_60d_ago - 1 | higher | 成长型 |
| `intraday_strength` | 短线 | (close - open) / (high - low),收盘在日内位置 | higher | 短线打板 |

### 2.3 风格因子配置(5 种)

每种风格定义:`factor_ids`(因子子集)、`directions`(覆盖默认方向)、`target_horizon`(评估用)、`weight_horizon`(权重计算用)。

#### 2.3.1 逆向抄底(基线,直接复用现有评分)
- 因子集:现有 26 个有效因子(排除 dividend_yield)
- 方向:使用因子文件中的 `direction`(数据驱动校准结果)
- target_horizon:5d
- 权重:|rank_ic_ir@5d| 归一化

#### 2.3.2 价值投资(稳健)
- 因子集(8 个):
  - 估值:pe_ttm, pb, ps_ttm, pe_change_5d
  - 规模:log_market_cap, log_float_market_cap
  - 流动性:turnover_rate
  - 风险:drawdown_20d
- 方向(主观,与现有数据驱动方向不同):
  - pe_ttm = lower(低估值好)
  - pb = lower
  - ps_ttm = lower
  - pe_change_5d = lower(PE 回落=估值修复)
  - log_market_cap = higher(大盘稳健)
  - log_float_market_cap = higher
  - turnover_rate = lower(低换手=长期持有者多)
  - drawdown_20d = lower(低回撤=稳健)
- target_horizon:20d
- 权重:|rank_ic_ir@20d| 归一化

#### 2.3.3 成长型(稳中求进)
- 因子集(10 个):
  - 动量(代理成长):return_20d, momentum_60d
  - 估值(高估值=成长股):pe_ttm, pe_change_5d
  - 量能(放量=资金关注):volume_ratio, amount_20d_avg
  - 趋势:ma60_slope_5d, price_above_ma20
  - 强势:breakout_20d, return_10d
- 方向(主观,全部 higher,体现成长延续):
  - return_20d = higher
  - momentum_60d = higher
  - pe_ttm = higher(高估值=成长预期)
  - pe_change_5d = higher(PE 上升=预期强化)
  - volume_ratio = higher
  - amount_20d_avg = higher
  - ma60_slope_5d = higher
  - price_above_ma20 = higher
  - breakout_20d = higher
  - return_10d = higher
- target_horizon:20d
- 权重:|rank_ic_ir@20d| 归一化

#### 2.3.4 趋势型(进取)
- 因子集(10 个):
  - 趋势:ma60_slope_5d, ma20_above_ma60, price_above_ma20, short_ma_slope, ma_alignment_strength
  - 突破:turtle_breakout_20, breakout_20d
  - 动量:return_20d, return_10d
  - 波动:atr_20
- 方向(主观,全部 higher,趋势延续):
  - 全部 = higher
- target_horizon:20d
- 权重:|rank_ic_ir@20d| 归一化

#### 2.3.5 短线打板(激进)
- 因子集(10 个):
  - 涨停:limit_up_consecutive
  - 量能:volume_ratio, amount_20d_avg, breakout_20d
  - 强势:bias_6, kdj_j, intraday_strength
  - 动量:return_10d, return_20d
  - 振荡:rsi_14
- 方向(主观,全部 higher,强势股延续):
  - 全部 = higher
- target_horizon:1d(若 1d 全失效,退化为 3d)
- 权重:|rank_ic_ir@1d| 归一化(若 1d 失效,改用 3d)

### 2.4 评估方法

对每种风格:
1. 构造风格因子面板(含新增因子的向量化实现)
2. 在目标 horizon 下计算各因子 IC/Rank IC/ICIR
3. 用 |rank_ic_ir| 归一化作为权重
4. 应用风格特定方向(覆盖因子默认 direction)
5. 调用 `CompositeScorer` 构造复合评分
6. 评估分层收益、多空价差、单调性

---

## 三、文件改动清单

### 3.1 新增文件(全部在新目录,不动现有文件)

| 文件路径 | 类型 | 内容 |
|---|---|---|
| `D:\github_public_repo\评分规则探索\src\factors\style_specific\__init__.py` | 模块初始化 | 导出 STYLE_SPECIFIC_FACTORS 列表 + build_style_registry() |
| `D:\github_public_repo\评分规则探索\src\factors\style_specific\trend.py` | 趋势因子(3 个) | AtrFactor / TurtleBreakoutFactor / MaAlignmentStrengthFactor |
| `D:\github_public_repo\评分规则探索\src\factors\style_specific\shortterm.py` | 短线因子(4 个) | LimitUpConsecutiveFactor / KdjJFactor / Bias6Factor / IntradayStrengthFactor |
| `D:\github_public_repo\评分规则探索\src\factors\style_specific\growth.py` | 成长因子(1 个) | Momentum60dFactor |
| `D:\github_public_repo\评分规则探索\src\panel\vectorized_styles.py` | 向量化实现 | 8 个新增因子的 pandas 向量化计算(与 vectorized.py 同风格) |
| `D:\github_public_repo\评分规则探索\src\styles\__init__.py` | 模块初始化 | 导出 STYLE_DEFINITIONS |
| `D:\github_public_repo\评分规则探索\src\styles\definitions.py` | 风格定义 | 5 种风格的 StyleSpec dataclass(factor_ids, directions, target_horizon, weight_horizon) |
| `D:\github_public_repo\评分规则探索\src\styles\style_scorer.py` | 风格评分器 | StyleScorer 类:接收 StyleSpec + 因子面板 + 收益面板 → 复合评分 + 评估报告 |
| `D:\github_public_repo\评分规则探索\scripts\run_style_comparison.py` | 主脚本 | 加载 K 线 → 构造 35 因子面板 → 评估 5 风格 → 生成对比报告 |
| `D:\github_public_repo\评分规则探索\tests\test_style_factors.py` | 单元测试 | 8 个新增因子的 compute() + 向量化一致性测试 |
| `D:\github_public_repo\评分规则探索\tests\test_styles.py` | 风格定义测试 | 5 种风格配置完整性、因子集有效性测试 |
| `d:\github_public_repo\量化回测\tmp_output\STYLE_COMPARISON_REPORT.md` | 最终研究报告 | 多风格对比研究报告(10 章) |

### 3.2 复用现有文件(只读,不修改)

| 文件路径 | 复用内容 |
|---|---|
| `src/factors/base.py` | FactorBase / FactorDefinition / FactorDirection 接口 |
| `src/factors/registry.py` | DEFAULT_REGISTRY(获取现有 27 因子) |
| `src/scoring/composite.py` | CompositeScorer(fit/score/evaluate) |
| `src/scoring/normalizer.py` | zscore_normalize / adjust_direction |
| `src/evaluation/ic.py` | compute_daily_ic / summarize_ic |
| `src/evaluation/layered.py` | compute_layered_returns |
| `src/evaluation/runner.py` | FactorEvaluationReport 数据类 |
| `src/panel/returns.py` | build_return_panel |
| `src/panel/vectorized.py` | build_all_factor_panels_vectorized(现有 27 因子) |
| `src/data/loader.py` | load_candles |
| `src/data/connection.py` | open_duckdb_session |

---

## 四、实施步骤

### Step 1:创建新增因子定义(3 个文件)

在 `src/factors/style_specific/` 下创建:
- `trend.py`:AtrFactor / TurtleBreakoutFactor / MaAlignmentStrengthFactor
- `shortterm.py`:LimitUpConsecutiveFactor / KdjJFactor / Bias6Factor / IntradayStrengthFactor
- `growth.py`:Momentum60dFactor

每个因子继承 `FactorBase`,实现 `definition()` + `compute(candles, signal_date)`。`compute()` 严格使用 `_candles_up_to` 截断 + `assert_point_in_time` 断言。

**关键实现细节**:
- `limit_up_consecutive`:涨幅阈值 9.5%(主板 10% 限制,留 0.5% 缓冲)
- `kdj_j`:标准 KDJ(9,3,3),J=3K-2D,J>100 超买,J<0 超卖
- `ma_alignment_strength`:0.4×sign(MA5>MA10)×dist + 0.3×sign(MA10>MA20)×dist + 0.3×sign(MA20>MA60)×dist,dist=(ma_short-ma_long)/ma_long
- `turtle_breakout_20`:用前 20 日(不含当日)的 high 作为突破基准

### Step 2:创建向量化实现

在 `src/panel/vectorized_styles.py` 中为 8 个新增因子提供 pandas 向量化实现,函数签名与 `vectorized.py` 一致:
```python
def build_style_factor_panel_vectorized(factor_id: str, candles_long: pd.DataFrame) -> pd.DataFrame
def build_all_style_factor_panels_vectorized(candles_long, factor_ids=None) -> dict[str, pd.DataFrame]
```

**关键**:确保向量化实现与 `compute()` 语义一致(避免现有 `vectorized.py` 与 `technical.py` 不一致的问题重演)。每个因子在 `tests/test_style_factors.py` 中有"逐行 vs 向量化"一致性测试。

### Step 3:创建风格定义

在 `src/styles/definitions.py` 中定义:
```python
@dataclass(frozen=True)
class StyleSpec:
    style_id: str                    # "contrarian", "value", "growth", "trend", "short_term"
    style_name: str                  # 中文风格名
    risk_level: str                  # 稳健/稳中求进/进取/激进
    target_horizon: int             # 评估用 horizon
    weight_horizon: int             # 权重计算用 horizon(通常=target_horizon)
    factor_ids: tuple[str, ...]    # 因子子集
    directions: dict[str, str]      # 覆盖因子默认 direction
    description: str

STYLE_DEFINITIONS: dict[str, StyleSpec] = {
    "contrarian": StyleSpec(...),   # 现有基线
    "value": StyleSpec(...),
    "growth": StyleSpec(...),
    "trend": StyleSpec(...),
    "short_term": StyleSpec(...),
}
```

### Step 4:创建风格评分器

在 `src/styles/style_scorer.py` 中:
```python
class StyleScorer:
    def __init__(self, spec: StyleSpec): ...
    def evaluate(self, all_factor_panels, candles_long, layers=5, min_samples=30) -> StyleEvaluationResult:
        # 1. 选择风格因子子集
        # 2. 构造对应 horizon 收益面板
        # 3. 计算各因子 IC/ICIR
        # 4. 提取 |rank_ic_ir| 作为权重
        # 5. 调用 CompositeScorer(factor_directions=spec.directions).fit(weights).score().evaluate()
        # 6. 返回 StyleEvaluationResult(reports, weights, composite_report, style_spec)
```

### Step 5:创建对比评估脚本

`scripts/run_style_comparison.py`:
1. 加载 K 线(5 年)
2. 一次性构造 35 因子面板(现有 27 + 新增 8)
3. 对 5 种风格分别评估
4. 生成对比报告:
   - 各风格多空价差/单调性对比表
   - 各风格权重分布
   - 各风格分层细节
   - 风格相关性(复合评分面板的相关系数)
   - 推荐持有期与年化收益
5. 输出到 `output/style_comparison_<timestamp>.md`
6. 复制最终报告到 `d:/github_public_repo/量化回测/tmp_output/STYLE_COMPARISON_REPORT.md`

### Step 6:运行评估

```bash
cd D:\github_public_repo\评分规则探索
python scripts/run_style_comparison.py --start 2021-07-25 --end 2026-07-24
```

### Step 7:生成研究报告

整合评估结果到 `tmp_output/STYLE_COMPARISON_REPORT.md`,10 章结构:
1. 摘要
2. 研究背景与目标
3. 5 种投资风格定义
4. 新增 K 线衍生因子(8 个)
5. 评估方法
6. 各风格评估结果(5 节,每节含因子配置/IC 表/分层收益/多空价差)
7. 风格对比分析(多空价差/单调性/年化收益对比表 + 风格相关性矩阵)
8. 风格组合建议(哪些风格可组合、组合权重建议)
9. 风险提示与限制
10. 改进路线图

---

## 五、假设与决策

### 5.1 关键假设

1. **数据源**:仅使用现有 DuckDB 快照字段(OHLCV + amount + turnoverRatePct + totalMarketCap + floatMarketCap + peTtm + pb + psTtm),不引入 MySQL 或外部数据
2. **因子范围**:新增 8 个纯 K 线可算因子,不新增需新数据源的因子(如 ROE/北向资金)
3. **方向方法**:主观方向(符合风格理念)+ 数据驱动权重(|ICIR| 归一化)
4. **评估口径**:与现有研究一致,T+1 开盘 → T+horizon 收盘 forward return,5 分层
5. **不修改现有文件**:所有新增代码在新目录,现有 27 因子与 `CompositeScorer` 只读复用

### 5.2 设计决策

1. **新增因子默认 direction 设为 higher**:多数新因子(如 ATR、动量、连板)在"强势延续"语境下是 higher,具体方向由风格定义覆盖
2. **短线打板目标 horizon=1d**:多周期评估显示 1d 复合评分失效,但新增连板/KDJ/BIAS 因子可能改变结论。若仍失效,报告中说明并退化到 3d
3. **风格方向覆盖机制**:在 `StyleSpec.directions` 中显式指定方向,`CompositeScorer.factor_directions` 参数接收,不修改因子文件中的默认 direction
4. **权重计算 horizon**:与目标 horizon 一致(价值/成长/趋势用 20d,逆向抄底用 5d,短线打板用 1d)
5. **新增因子向量化实现**:放在独立文件 `vectorized_styles.py`,不混入现有 `vectorized.py`,避免污染

### 5.3 已知限制

1. **价值投资覆盖不足**:缺 dividend_yield(死代码)、ROE、ROA,只能用 PE/PB/PS + 规模/流动性代理
2. **成长型用动量代理成长性**:60 日动量是价格层面的代理,无法区分"业绩驱动"与"估值抬升"
3. **趋势型方向与数据驱动方向相反**:主观设定为 higher,但 5 年数据显示这些因子实际是 lower(反转)。报告会对比"主观方向 vs 数据驱动方向"的差异
4. **短线打板 horizon=1d 风险**:已知 1d 复合评分失效,新增因子能否扭转待验证
5. **未做中性化**:市值/行业因子可能干扰风格评估(研究报告会注明)

---

## 六、验证步骤

### 6.1 单元测试

- `tests/test_style_factors.py`:8 个新增因子的 compute() 边界条件 + 向量化一致性
  - 每个因子:足够 warmup / 不足 warmup / NaN 处理 / 逐行 vs 向量化数值一致
- `tests/test_styles.py`:5 种风格配置完整性
  - 因子集非空 / 方向覆盖所有因子 / horizon 合理 / StyleSpec 不可变性

运行:`python -m pytest tests/test_style_factors.py tests/test_styles.py -v`

### 6.2 集成验证

- 现有 202 个测试不破坏(不动现有文件,应自动通过)
- 新增测试通过
- 风格评估脚本可端到端运行

### 6.3 评估结果验证

每种风格必须产出:
- 单因子 IC/ICIR 表(在目标 horizon 下)
- 复合评分分层收益(5 层)
- 多空价差、单调性
- 权重分布

5 种风格对比表完整,数据准确。

### 6.4 报告完整性

`STYLE_COMPARISON_REPORT.md` 必须包含:
- 5 种风格的完整定义与因子配置
- 8 个新增因子的公式与实现说明
- 5 种风格的评估结果(分层、多空价差、单调性)
- 风格对比分析(对比表 + 相关性矩阵)
- 风格组合建议
- 风险提示与改进路线

---

## 七、执行顺序

1. 创建 `src/factors/style_specific/` 目录与 4 个文件(__init__.py, trend.py, shortterm.py, growth.py)
2. 创建 `src/panel/vectorized_styles.py`
3. 创建 `tests/test_style_factors.py` 并通过
4. 创建 `src/styles/` 目录与 3 个文件(__init__.py, definitions.py, style_scorer.py)
5. 创建 `tests/test_styles.py` 并通过
6. 创建 `scripts/run_style_comparison.py`
7. 运行评估脚本,生成原始数据
8. 整合为 `tmp_output/STYLE_COMPARISON_REPORT.md` 研究报告
9. 返回最终响应给用户

---

## 八、预期产出

| 产出 | 路径 |
|---|---|
| 新增因子源码 | `src/factors/style_specific/{trend,shortterm,growth}.py` |
| 向量化实现 | `src/panel/vectorized_styles.py` |
| 风格定义 | `src/styles/definitions.py` |
| 风格评分器 | `src/styles/style_scorer.py` |
| 评估脚本 | `scripts/run_style_comparison.py` |
| 单元测试 | `tests/test_style_factors.py` + `tests/test_styles.py` |
| 评估原始数据 | `output/style_comparison_<timestamp>.md` |
| **最终研究报告** | `d:/github_public_repo/量化回测/tmp_output/STYLE_COMPARISON_REPORT.md` |

---

## 九、产品落地状态（2026-07-26）

研究路线已落地到量化回测应用的即时选股评分，并根据 V3/V4 全市场实测结果做了以下调整：

1. 五种风格使用独立规则，不再复用逆向抄底方向：
   - 逆向抄底：20 日；
   - 价值投资、成长型、趋势型：60 日；
   - 短线打板：由已证伪的 1 日降级为 10 日。
2. 所有风格增加沪深 300 相对强弱因子。缺少基准时保留该因子权重，并按中性分占位。
3. 价值投资新增近 12 个月股息率、ROE，并将股息率设为最高权重（22%）；股息率来自本地已实施分红事件，不依赖单次在线接口。
4. 成长型优先使用营收同比、净利润同比、ROE，不再使用“高 PE = 高成长”的单一代理。
5. 缺失数据不再触发剩余因子权重膨胀。所有风格总权重固定为 100%，缺失因子按中性 50 分占位并降低数据覆盖率。
6. 自选股排名和个股详情都支持切换评分风格，评分缓存按“风格 + 股票”隔离。
7. 页面即时分仍是单股时间序列代理；V4 报告的 spread、单调性和 ICIR 来自全市场横截面研究，两者口径在界面和 README 中明确区分。
