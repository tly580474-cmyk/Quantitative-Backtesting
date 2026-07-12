"""单因子 IC 分析：训练 / 测试 IC、ICIR、IC-t，以及样本外衰减、滚动时序验证。"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from factor_miner.fitness.metrics import compute_metrics, cross_section_rank, mutual_info

logger = logging.getLogger("factor_miner")


def analyze_ic(factor, fwd_train, fwd_test=None, label_rank_train=None,
               label_rank_test=None, factor_rank=None, n_bins: int = 10) -> dict:
    if label_rank_train is None:
        label_rank_train = cross_section_rank(fwd_train)
    train = compute_metrics(factor, fwd_train, label_rank=label_rank_train,
                            factor_rank=factor_rank)
    out = {"train": train, "mi_train": mutual_info(factor, fwd_train, n_bins)}
    if fwd_test is not None:
        if label_rank_test is None:
            label_rank_test = cross_section_rank(fwd_test)
        test = compute_metrics(factor, fwd_test, label_rank=label_rank_test,
                               factor_rank=factor_rank)
        out["test"] = test
        out["mi_test"] = mutual_info(factor, fwd_test, n_bins)
        # 样本外 IC 衰减 = 1 - |IC_test|/|IC_train|
        if train["rankic"] not in (None, np.nan) and not np.isclose(train["rankic"], 0):
            out["oos_ic_decay"] = float(1 - abs(test["rankic"]) / abs(train["rankic"]))
    return out


def rolling_cv(factor: "pd.Series", fwd: "pd.Series", panel, n_splits: int = 5,
               label_rank: "pd.Series | None" = None,
               factor_rank: "pd.Series | None" = None) -> dict:
    """滚动时序验证：把测试期按时间顺序切成 n_splits 个窗口，逐窗计算 RankIC。

    返回各窗 RankIC 的均值 / 标准差 / 最小值，用于评估因子 OOS 稳定性
    （M2 关键验证指标：单点测试 IC 可能侥幸，逐窗稳定才是真信号）。

    优化：截面 rank 按日独立，故「全量标签 rank」「全量因子 rank」均可预计算后
    按窗口切片复用，无需每个窗口重新排序。
    """
    if label_rank is None:
        label_rank = cross_section_rank(fwd)
    if factor_rank is None:
        factor_rank = cross_section_rank(factor)

    dates = panel.index.get_level_values(1)
    uniq = dates.unique().sort_values()
    if len(uniq) < n_splits + 1:
        return {"mean": None, "std": None, "min": None, "windows": []}
    edges = np.linspace(0, len(uniq), n_splits + 1).astype(int)
    ics = []
    for i in range(n_splits):
        lo, hi = edges[i], edges[i + 1]
        if hi <= lo:
            continue
        half = max(1, (hi - lo) // 2)
        va = uniq[hi:min(hi + half, len(uniq))]
        if len(va) == 0:
            va = uniq[hi:hi + 1] if hi < len(uniq) else uniq[lo:hi]
        m = dates.isin(va)
        mtr = compute_metrics(factor[m], fwd[m], label_rank=label_rank[m],
                              factor_rank=factor_rank[m])
        ric = mtr["rankic"]
        if ric is not None and np.isfinite(ric):
            ics.append(float(ric))
    if not ics:
        return {"mean": None, "std": None, "min": None, "windows": []}
    arr = np.array(ics)
    return {"mean": float(arr.mean()), "std": float(arr.std()),
            "min": float(arr.min()), "windows": [float(x) for x in ics]}
