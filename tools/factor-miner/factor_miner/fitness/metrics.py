"""适应度与统计量。

主适应度：截面 RankIC（因子值 vs 未来收益的日频 Spearman 均值）。
额外支持：
  * 复杂度惩罚：抑制过深/过大树（防过拟合、提升可读性）；
  * 相关性惩罚：鼓励产出与已入选因子低相关、互补的因子。

并提供 ICIR / IC-t / 互信息 等可解释统计量，供验收与排劣使用。
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from factor_miner.engine.evaluator import as_series, evaluate_tree
from factor_miner.tree.node import Node

logger = logging.getLogger("factor_miner")


# ---------------------------------------------------------------------------
# 基础统计量
# ---------------------------------------------------------------------------
# 标签截面 rank 缓存：同一面板 + 同一标签列只计算一次（标签固定，重复计算是浪费）
_LABEL_RANK_CACHE: dict = {}


def clear_label_rank_cache() -> None:
    """清空标签 rank 缓存（测试 / 面板重建后调用，避免跨面板串扰）。"""
    _LABEL_RANK_CACHE.clear()


def cross_section_rank(series: pd.Series) -> pd.Series:
    """逐交易日（level=1）横截面 rank（method=average）。

    与 pandas ``.corr(method="spearman")`` 内部使用的排序方式一致——
    Spearman 相关即「秩的 Pearson 相关」，故用平均秩即可严格等价。
    """
    return series.groupby(level=1, group_keys=False).rank()


def get_label_rank(panel: pd.DataFrame, fwd_col: str) -> pd.Series:
    """取某标签列的截面 rank，按 (面板对象 id, 列名) 缓存（面板在进化期内稳定）。"""
    key = (id(panel), fwd_col)
    lr = _LABEL_RANK_CACHE.get(key)
    if lr is None:
        lr = cross_section_rank(panel[fwd_col])
        _LABEL_RANK_CACHE[key] = lr
    return lr


def _pearson_by_date(x: pd.Series, y: pd.Series, min_n: int = 10) -> pd.Series:
    """逐交易日 Pearson 相关（向量化聚合，替代逐组 .apply + .corr）。

    等价于 pandas ``g["x"].corr(g["y"])``（ddof=1），但仅一次分组聚合、
    无 Python 层逐组循环，速度大幅领先。NaN 成对丢弃，与 pandas 行为一致。
    截面常量（方差≈0）或有效样本 < min_n 的交易日返回 NaN。
    """
    df = pd.DataFrame({"x": x, "y": y}).dropna()
    if df.empty:
        return pd.Series(dtype="float64")
    g = df.groupby(level=1)
    n = g.size()
    sx = g["x"].sum()
    sy = g["y"].sum()
    sxy = (df["x"] * df["y"]).groupby(level=1).sum()
    sx2 = (df["x"] ** 2).groupby(level=1).sum()
    sy2 = (df["y"] ** 2).groupby(level=1).sum()
    cov = sxy - sx * sy / n
    vx = sx2 - sx ** 2 / n
    vy = sy2 - sy ** 2 / n
    denom = np.sqrt((vx * vy).clip(lower=0))
    ic = cov / denom.replace(0.0, np.nan)
    ic = ic.where((n >= min_n) & (vx > 1e-12) & (vy > 1e-12))
    return ic


def rankic_series(factor: pd.Series, fwd: pd.Series | None = None,
                  label_rank: pd.Series | None = None,
                  factor_rank: pd.Series | None = None, min_n: int = 10) -> pd.Series:
    """逐交易日截面 RankIC（Spearman）。

    优先复用预计算的标签截面 rank（``label_rank``）与因子截面 rank（``factor_rank``），
    避免每个因子重复排序。RankIC = 因子秩 与 标签秩 的逐日 Pearson（与 pandas
    spearman 严格等价）。结果重新对齐到因子的全部交易日，索引覆盖与原实现一致。
    """
    if label_rank is None:
        if fwd is None:
            raise ValueError("rankic_series 需提供 fwd 或 label_rank")
        label_rank = cross_section_rank(fwd)
    if factor_rank is None:
        factor_rank = cross_section_rank(factor)
    ic = _pearson_by_date(factor_rank, label_rank, min_n=min_n)
    idx = factor.groupby(level=1, group_keys=False).size().index
    return ic.reindex(idx)


def mean_rankic(factor: pd.Series, fwd: pd.Series | None = None,
                label_rank: pd.Series | None = None,
                factor_rank: pd.Series | None = None) -> float:
    ic = rankic_series(factor, fwd, label_rank, factor_rank).dropna()
    return float(ic.mean()) if len(ic) else np.nan


def compute_metrics(factor: pd.Series, fwd: pd.Series | None = None,
                    label_rank: pd.Series | None = None,
                    factor_rank: pd.Series | None = None) -> dict:
    ic = rankic_series(factor, fwd, label_rank, factor_rank).dropna()
    if len(ic) < 2:
        return {"rankic": np.nan, "icir": np.nan, "ic_t": np.nan, "n_days": int(len(ic))}
    mean = ic.mean()
    std = ic.std()
    if std <= 1e-12:
        return {"rankic": float(mean), "icir": np.nan, "ic_t": np.nan, "n_days": int(len(ic))}
    icir = mean / std
    ic_t = mean / (std / np.sqrt(len(ic)))
    return {
        "rankic": float(mean),
        "icir": float(icir),
        "ic_t": float(ic_t),
        "n_days": int(len(ic)),
    }


def mutual_info(factor: pd.Series, fwd: pd.Series, n_bins: int = 10) -> float:
    """分箱互信息（捕捉非线性关联），取值 [0, log(n_bins)]。"""
    pair = pd.concat([factor, fwd], axis=1).dropna()
    if len(pair) < 100:
        return np.nan
    a = pd.qcut(pair.iloc[:, 0].rank(method="first"), n_bins, labels=False, duplicates="drop")
    b = pd.qcut(pair.iloc[:, 1].rank(method="first"), n_bins, labels=False, duplicates="drop")
    valid = (a.notna() & b.notna()).values
    a = a.values[valid].astype(int)
    b = b.values[valid].astype(int)
    n = len(a)
    pa = np.bincount(a, minlength=n_bins) / n
    pb = np.bincount(b, minlength=n_bins) / n
    pab = np.zeros((n_bins, n_bins))
    np.add.at(pab, (a, b), 1.0)
    pab /= n
    mi = 0.0
    for i in range(n_bins):
        for j in range(n_bins):
            if pab[i, j] > 0:
                mi += pab[i, j] * np.log(pab[i, j] / (pa[i] * pb[j] + 1e-12))
    return float(mi)


# ---------------------------------------------------------------------------
# 惩罚项
# ---------------------------------------------------------------------------
def correlation_penalty(factor: pd.Series, selected_arrays, subsample: int = 20000) -> float:
    """与已入选因子平均绝对相关（0~1）。空列表返回 0。"""
    if not selected_arrays:
        return 0.0
    if subsample and len(factor) > subsample:
        idx = factor.sample(subsample, random_state=0).index
        f = factor.loc[idx]
        sels = [s.loc[idx] for s in selected_arrays]
    else:
        f = factor
        sels = selected_arrays
    corrs = []
    for s in sels:
        pair = pd.concat([f, s], axis=1).dropna()
        if len(pair) < 10:
            continue
        c = pair.iloc[:, 0].corr(pair.iloc[:, 1])
        if np.isfinite(c):
            corrs.append(abs(c))
    return float(np.mean(corrs)) if corrs else 0.0


# ---------------------------------------------------------------------------
# 综合适应度
# ---------------------------------------------------------------------------
def fitness_of(node: Node, panel: pd.DataFrame, fwd_col: str, cfg: dict,
               selected_arrays=None, rolling_valid_dates=None) -> tuple[float, dict]:
    """计算个体适应度。

    fit = base + λ_icir·icir − λ_complex·complexity − λ_corr·corr_pen
              − λ_const·const_pen − λ_consistency·consistency_pen

    其中：
      * base：截面 RankIC 均值（预测力，主导项）；
      * icir 奖励：IC 信息比率越高越稳健（中性化因子天然占优）；
      * complexity / corr 惩罚：抑制过深树、鼓励因子多样性；
      * const_pen：近常量惩罚（横截面变异系数过小 → 退化表达式）；
      * consistency_pen：前后半样本 RankIC 符号反转惩罚（抗过拟合）。
    异常 / 全 NaN / 非有限 base → 适应度 -inf，并被进化器剔除。
    """
    fc = cfg.get("fitness", {})
    try:
        factor = evaluate_tree(node, panel)
    except Exception as exc:  # pragma: no cover
        logger.debug("evaluate_tree 失败: %s", exc)
        return -np.inf, {}
    factor = as_series(factor, panel)
    if factor.isna().all():
        return -np.inf, {}

    fwd = panel[fwd_col]
    label_rank = get_label_rank(panel, fwd_col)
    ic_series = rankic_series(factor, fwd, label_rank).dropna()
    base = float(ic_series.mean()) if len(ic_series) else np.nan
    if not np.isfinite(base):
        return -np.inf, {}

    # Walk-forward 选择适应度只需要按各验证窗聚合已经算好的“日频 RankIC”。
    # 旧路径会为每个个体再次求值整棵表达式，并在每一折重复做横截面排名；
    # 这里保持完全相同的统计口径，但复用上面的 factor rank / label rank。
    rolling = False
    rolling_base = None
    if rolling_valid_dates:
        fold_bases = []
        for dates in rolling_valid_dates:
            fold_ic = ic_series.reindex(dates).dropna()
            if len(fold_ic):
                fold_bases.append(float(fold_ic.mean()))
        if fold_bases:
            rolling_base = float(np.mean(fold_bases))
            rolling = True

    # ---- 复杂度惩罚 ----
    w_depth = float(fc.get("complexity_w_depth", 1.0))
    w_node = float(fc.get("complexity_w_node", 0.1))
    complexity = node.depth() * w_depth + node.size() * w_node
    lambda_c = float(fc.get("lambda_complexity", 5e-4))
    pen = lambda_c * complexity

    # ---- 相关性惩罚 ----
    corr_raw = correlation_penalty(
        factor, selected_arrays or [],
        subsample=int(fc.get("corr_subsample", 20000)))
    lambda_r = float(fc.get("lambda_corr", 0.1))
    corr_pen = lambda_r * corr_raw

    # ---- 近常量惩罚：横截面变异系数(CV)过小 → 退化表达式 ----
    lambda_const = float(fc.get("lambda_const", 0.0))
    const_pen = 0.0
    cv = 0.0
    if lambda_const > 0:
        cs_std = factor.groupby(level=1, group_keys=False).std().mean()
        abs_mean = factor.abs().mean()
        cv = float(cs_std / abs_mean) if abs_mean > 1e-12 else 0.0
        thresh = float(fc.get("const_cv_thresh", 0.01))
        if cv < thresh:
            const_pen = lambda_const * (1.0 - cv / thresh)

    # ---- ICIR 奖励：稳定性 ----
    lambda_icir = float(fc.get("lambda_icir", 0.0))
    icir = np.nan
    icir_reward = 0.0
    if lambda_icir > 0 and len(ic_series) >= 2:
        s = ic_series.std()
        icir = float(base / s) if s > 1e-12 else np.nan
        icir_reward = lambda_icir * (icir if np.isfinite(icir) else 0.0)

    # ---- 一致性惩罚：前后半样本 RankIC 符号反转（过拟合信号）----
    lambda_cons = float(fc.get("lambda_consistency", 0.0))
    consistency_pen = 0.0
    if lambda_cons > 0 and len(ic_series) >= 4:
        dts = ic_series.index
        mid = dts[len(dts) // 2]
        ic1 = float(ic_series[dts <= mid].mean())
        ic2 = float(ic_series[dts > mid].mean())
        if np.isfinite(ic1) and np.isfinite(ic2) and np.sign(ic1) != np.sign(ic2):
            consistency_pen = lambda_cons * (abs(ic1) + abs(ic2)) / 2.0

    fit = base + icir_reward - pen - corr_pen - const_pen - consistency_pen
    if rolling_base is not None:
        fit += rolling_base - base
    detail = {
        "base": float(rolling_base if rolling_base is not None else base),
        "icir": float(icir) if np.isfinite(icir) else None,
        "complexity": float(complexity),
        "corr_raw": float(corr_raw),
        "corr_penalty": float(corr_pen),
        "const_penalty": float(const_pen),
        "consistency_penalty": float(consistency_pen),
        "rolling": rolling,
    }
    return float(fit), detail
