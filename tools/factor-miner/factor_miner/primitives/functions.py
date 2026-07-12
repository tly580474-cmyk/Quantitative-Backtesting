"""算子库（函数集 / Function Set）。

所有算子接收、返回 ``pandas.Series``（面板 MultiIndex(symbol, date)）。
约定：
  * 横截面算子：沿 level=1（日期）跨标的计算；
  * 时间序列算子：沿 level=0（标的）按时间窗口计算；
  * 带窗口参数的算子（window_last=True）最后一个子节点为窗口整数常数。

所有算子经 :func:`protect` 做除零 / log 负值 / 溢出保护。
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from factor_miner.utils.decorators import protect

logger = logging.getLogger("factor_miner")

# 窗口参数候选集（生成树时随机选取）
WINDOWS = [3, 5, 10, 20, 60]


class Primitive:
    """算子元信息。"""

    def __init__(self, name: str, arity: int, func, category: str,
                 window_last: bool = False, commutative: bool = False,
                 needs_panel: bool = False, requires_nonneg: bool = False):
        self.name = name
        self.arity = arity                      # 子节点总数
        self.func = func
        self.category = category
        self.window_last = window_last          # 末位子节点是窗口常数
        self.commutative = commutative
        self.needs_panel = needs_panel          # 求值时需注入面板（如取 industry 列）
        self.requires_nonneg = requires_nonneg  # 子节点必须非负（生成器自动包 abs）
        # 真正的"子树"子节点数（不含窗口常数）
        self.n_series_args = arity - (1 if window_last else 0)

    def __repr__(self):
        return f"Primitive({self.name},arity={self.arity},cat={self.category})"


# ----------------------------------------------------------------------------
# 工具
# ----------------------------------------------------------------------------
def _mp(w: float) -> int:
    """滚动窗口最小样本数。"""
    w = max(1, int(round(w)))
    return max(2, int(w * 0.6))


def _ts_transform(series: pd.Series, w: float, roll_func):
    """按标的分组后对每列做滚动计算。"""
    w = max(1, int(round(w)))
    return series.groupby(level=0, group_keys=False).transform(
        lambda s: roll_func(s.rolling(w, min_periods=_mp(w))))


# ----------------------------------------------------------------------------
# 标量 / 算术
# ----------------------------------------------------------------------------
@protect
def _add(a, b):
    return a + b

@protect
def _sub(a, b):
    return a - b

@protect
def _mul(a, b):
    return a * b

@protect
def _div(a, b):
    eps = 1e-9
    denom = b.where(b.abs() > eps, 1.0)
    return a / denom

@protect
def _neg(a):
    return -a

@protect
def _abs(a):
    return a.abs()

@protect
def _log(a):
    # 有符号对数：log1p(|x|) 保留量级、sign(x) 保留方向，全程有限，
    # 杜绝 log(负数)→NaN 与退化常量；跨标的变化，不塌缩。
    return np.sign(a) * np.log1p(a.abs())

@protect
def _sqrt(a):
    # 非负平方根：恒有限、跨标的变化，避免负值→NaN 与常量塌缩。
    # NaN 经 abs 仍保留，np.sqrt(NaN) 会触发 RuntimeWarning；局部忽略，
    # 结果由 protect 统一清洗为有限值。
    with np.errstate(invalid="ignore"):
        return np.sqrt(a.abs())

@protect
def _sign(a):
    return np.sign(a)

@protect
def _inv(a):
    eps = 1e-9
    denom = a.where(a.abs() > eps, np.nan)
    return 1.0 / denom

@protect
def _power(a, b):
    base = a.clip(-1e6, 1e6)
    exp = b.clip(-5, 5)
    return np.sign(base) * np.power(base.abs().clip(1e-9, 1e9), exp)

@protect
def _min2(a, b):
    return np.minimum(a, b)

@protect
def _max2(a, b):
    return np.maximum(a, b)


# ----------------------------------------------------------------------------
# 横截面
# ----------------------------------------------------------------------------
@protect
def _cs_rank(x):
    return x.groupby(level=1, group_keys=False).rank(pct=True)

@protect
def _cs_scale(x):
    eps = 1e-12
    return x.groupby(level=1, group_keys=False).transform(
        lambda s: s / (s.abs().sum() + eps))

@protect
def _cs_zscore(x):
    mean = x.groupby(level=1, group_keys=False).transform("mean")
    std = x.groupby(level=1, group_keys=False).transform("std")
    return (x - mean) / std.replace(0, np.nan)

@protect
def _cs_mean(x):
    return x.groupby(level=1, group_keys=False).transform("mean")

@protect
def _cs_std(x):
    return x.groupby(level=1, group_keys=False).transform("std")

@protect
def _cs_min(x):
    return x.groupby(level=1, group_keys=False).transform("min")

@protect
def _cs_max(x):
    return x.groupby(level=1, group_keys=False).transform("max")


# ----------------------------------------------------------------------------
# 中性化（M2）：剔除风格/行业暴露，压制多空回撤
# ----------------------------------------------------------------------------
@protect
def _cs_neutralize(y, x):
    """横截面 OLS 残差：剔除 y 对控制变量 x 的线性暴露（含截距）。

    向量化实现（按日期分组）：先各自去均值，再 ``beta = cov/var``，
    残差 ``y - beta*x`` 即对 x 中性化后的因子。规模中性时 x=log_mktcap。
    """
    xm = x - x.groupby(level=1, group_keys=False).transform("mean")
    ym = y - y.groupby(level=1, group_keys=False).transform("mean")
    cov = (xm * ym).groupby(level=1, group_keys=False).transform("sum")
    var = (xm * xm).groupby(level=1, group_keys=False).transform("sum")
    beta = (cov / var.replace(0, np.nan)).fillna(0.0)
    return ym - beta * xm


@protect
def _cs_indneutral(y, panel=None):
    """行业内中性化：每个交易日，减去个股所在行业内的横截面均值。

    需要面板 ``industry`` 列（经 needs_panel 注入）；缺省退化为普通横截面去均值。
    """
    if panel is None or "industry" not in getattr(panel, "columns", []):
        return y - y.groupby(level=1, group_keys=False).transform("mean")
    ind = panel["industry"].fillna("UNK")
    keys = [ind.reindex(y.index), y.index.get_level_values(1)]
    return y - y.groupby(keys, group_keys=False).transform("mean")


# ----------------------------------------------------------------------------
# 时间序列
# ----------------------------------------------------------------------------
@protect
def _ts_delay(x, w):
    return x.groupby(level=0, group_keys=False).shift(int(round(w)))

@protect
def _ts_delta(x, w):
    return x - x.groupby(level=0, group_keys=False).shift(int(round(w)))

@protect
def _ts_mean(x, w):
    return _ts_transform(x, w, lambda r: r.mean())

@protect
def _ts_std(x, w):
    return _ts_transform(x, w, lambda r: r.std())

@protect
def _ts_min(x, w):
    return _ts_transform(x, w, lambda r: r.min())

@protect
def _ts_max(x, w):
    return _ts_transform(x, w, lambda r: r.max())

@protect
def _ts_sum(x, w):
    return _ts_transform(x, w, lambda r: r.sum())

@protect
def _ts_product(x, w):
    return _ts_transform(x, w, lambda r: r.apply(np.prod, raw=True))

@protect
def _ts_rank(x, w):
    def _rank_last(a):
        return (a < a[-1]).mean()
    return _ts_transform(x, w, lambda r: r.apply(_rank_last, raw=True))

@protect
def _ts_argmax(x, w):
    return _ts_transform(x, w, lambda r: r.apply(lambda a: float(np.argmax(a)), raw=True))

@protect
def _ts_argmin(x, w):
    return _ts_transform(x, w, lambda r: r.apply(lambda a: float(np.argmin(a)), raw=True))

@protect
def _ts_corr(x, y, w):
    w = max(1, int(round(w)))
    g = lambda s: s.groupby(level=0, group_keys=False).transform(
        lambda z: z.rolling(w, min_periods=_mp(w)).sum())
    cnt = x.groupby(level=0, group_keys=False).transform(
        lambda z: z.rolling(w, min_periods=_mp(w)).count())
    Sx, Sy = g(x), g(y)
    Sxy = g(x * y)
    Sxx, Syy = g(x * x), g(y * y)
    num = cnt * Sxy - Sx * Sy
    den = np.sqrt((cnt * Sxx - Sx * Sx) * (cnt * Syy - Sy * Sy))
    return num / den.replace(0, np.nan)

@protect
def _ts_cov(x, y, w):
    w = max(1, int(round(w)))
    g = lambda s: s.groupby(level=0, group_keys=False).transform(
        lambda z: z.rolling(w, min_periods=_mp(w)).sum())
    cnt = x.groupby(level=0, group_keys=False).transform(
        lambda z: z.rolling(w, min_periods=_mp(w)).count())
    Sx, Sy = g(x), g(y)
    Sxy = g(x * y)
    return Sxy - Sx * Sy / cnt.replace(0, np.nan)

@protect
def _cs_decay_linear(x, w):
    w = max(1, int(round(w)))
    def _decay(a):
        L = len(a)
        if L < 2:
            return np.nan
        wts = np.arange(1, L + 1, dtype="float64")
        return np.dot(a, wts) / wts.sum()
    return x.groupby(level=0, group_keys=False).transform(
        lambda s: s.rolling(w, min_periods=max(2, int(w * 0.6))).apply(_decay, raw=True))


# ----------------------------------------------------------------------------
# 条件
# ----------------------------------------------------------------------------
@protect
def _greater(a, b):
    return (a > b).astype("float64")

@protect
def _lesser(a, b):
    return (a < b).astype("float64")

@protect
def _if_else(c, a, b):
    return np.where(c > 0, a, b)


# ----------------------------------------------------------------------------
# 注册表
# ----------------------------------------------------------------------------
def _register() -> dict:
    regs = [
        # 标量
        Primitive("add", 2, _add, "scalar", commutative=True),
        Primitive("sub", 2, _sub, "scalar"),
        Primitive("mul", 2, _mul, "scalar", commutative=True),
        Primitive("div", 2, _div, "scalar"),
        Primitive("neg", 1, _neg, "scalar"),
        Primitive("abs", 1, _abs, "scalar"),
        Primitive("log", 1, _log, "scalar", requires_nonneg=True),
        Primitive("sqrt", 1, _sqrt, "scalar", requires_nonneg=True),
        Primitive("sign", 1, _sign, "scalar"),
        Primitive("inv", 1, _inv, "scalar"),
        Primitive("power", 2, _power, "scalar"),
        Primitive("min", 2, _min2, "scalar", commutative=True),
        Primitive("max", 2, _max2, "scalar", commutative=True),
        # 横截面
        Primitive("cs_rank", 1, _cs_rank, "cross"),
        Primitive("cs_scale", 1, _cs_scale, "cross"),
        Primitive("cs_zscore", 1, _cs_zscore, "cross"),
        Primitive("cs_mean", 1, _cs_mean, "cross"),
        Primitive("cs_std", 1, _cs_std, "cross"),
        Primitive("cs_min", 1, _cs_min, "cross"),
        Primitive("cs_max", 1, _cs_max, "cross"),
        Primitive("cs_decay_linear", 2, _cs_decay_linear, "cross", window_last=True),
        # 中性化（M2）
        Primitive("cs_neutralize", 2, _cs_neutralize, "neutral"),
        Primitive("cs_indneutral", 1, _cs_indneutral, "neutral", needs_panel=True),
        # 时间序列
        Primitive("ts_delay", 2, _ts_delay, "ts", window_last=True),
        Primitive("ts_delta", 2, _ts_delta, "ts", window_last=True),
        Primitive("ts_mean", 2, _ts_mean, "ts", window_last=True),
        Primitive("ts_std", 2, _ts_std, "ts", window_last=True),
        Primitive("ts_min", 2, _ts_min, "ts", window_last=True),
        Primitive("ts_max", 2, _ts_max, "ts", window_last=True),
        Primitive("ts_sum", 2, _ts_sum, "ts", window_last=True),
        Primitive("ts_product", 2, _ts_product, "ts", window_last=True),
        Primitive("ts_rank", 2, _ts_rank, "ts", window_last=True),
        Primitive("ts_argmax", 2, _ts_argmax, "ts", window_last=True),
        Primitive("ts_argmin", 2, _ts_argmin, "ts", window_last=True),
        Primitive("ts_corr", 3, _ts_corr, "ts", window_last=True),
        Primitive("ts_cov", 3, _ts_cov, "ts", window_last=True),
        # 条件
        Primitive("greater", 2, _greater, "cond"),
        Primitive("lesser", 2, _lesser, "cond"),
        Primitive("if_else", 3, _if_else, "cond"),
    ]
    return {p.name: p for p in regs}


FUNCTIONS = _register()


def get_function(name: str) -> Primitive:
    return FUNCTIONS[name]


def functions_by_arity() -> dict:
    """按子树参数数量分组（生成器用）。"""
    d: dict[int, list[Primitive]] = {}
    for p in FUNCTIONS.values():
        d.setdefault(p.n_series_args, []).append(p)
    return d


def enabled_functions(cfg: dict) -> list[Primitive]:
    """按配置过滤启用的算子（默认全开）。"""
    names = cfg.get("primitives", {}).get("functions")
    if not names:
        return list(FUNCTIONS.values())
    return [FUNCTIONS[n] for n in names if n in FUNCTIONS]
