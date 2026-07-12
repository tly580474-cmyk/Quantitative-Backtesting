"""因子库去重：按与已入选因子的相关性，保留低相关的 Top 因子。

用于从进化产出的候选因子中筛出一组互补因子，避免冗余。
"""
from __future__ import annotations

import logging

import numpy as np
import pandas as pd

logger = logging.getLogger("factor_miner")


def _corr(a: pd.Series, b: pd.Series) -> float:
    pair = pd.concat([a, b], axis=1).dropna()
    if len(pair) < 10:
        return np.nan
    return float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))


def dedup_factors(items: list[dict], threshold: float = 0.7,
                  key: str = "rankic", top_k: int | None = None) -> list[dict]:
    """items: [{..., 'factor': Series, key_metric: float}, ...]。

    按 key 降序排序后贪心入选，跳过与已入选因子 |corr|>threshold 的因子。
    """
    ordered = sorted(items, key=lambda x: x.get(key, 0) or 0, reverse=True)
    accepted: list[dict] = []
    for it in ordered:
        f = it.get("factor")
        if f is None:
            continue
        ok = True
        for a in accepted:
            c = _corr(f, a["factor"])
            if np.isfinite(c) and abs(c) > threshold:
                ok = False
                break
        if ok:
            accepted.append(it)
            if top_k and len(accepted) >= top_k:
                break
    logger.info("去重筛选：%d 候选 → 入选 %d（阈值 %.2f）", len(items), len(accepted), threshold)
    return accepted
