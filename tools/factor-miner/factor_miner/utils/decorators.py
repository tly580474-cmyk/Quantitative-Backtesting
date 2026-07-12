"""数值保护与异常容错装饰器。

所有算子经由 :func:`protect` 统一做：
  * 把 inf / -inf 变为 NaN（便于后续按截面剔除）
  * 把有限值裁剪到 [-CLIP, CLIP]，避免溢出污染后续计算

数据库只读查询使用 :func:`db_retry` 做有限次退避重试。
"""
from __future__ import annotations

import functools
import logging
import random
import time

import numpy as np
import pandas as pd

logger = logging.getLogger("factor_miner")

CLIP = 1e8


def _sanitize(series):
    if isinstance(series, pd.Series):
        s = series.replace([np.inf, -np.inf], np.nan)
        return s.clip(-CLIP, CLIP)
    arr = np.asarray(series, dtype="float64")
    arr = np.where(np.isfinite(arr), arr, np.nan)
    return np.clip(arr, -CLIP, CLIP)


def protect(func):
    """保护算子输出：除零 / log 负值 / 溢出等异常结果被裁剪为有限值。"""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            out = func(*args, **kwargs)
            return _sanitize(out)
        except Exception as exc:  # pragma: no cover - 防御性兜底
            logger.debug("算子 %s 求值异常: %s", getattr(func, "__name__", "?"), exc)
            # 返回与首个 Series 参数同形的全 NaN
            for a in args:
                if isinstance(a, pd.Series):
                    return pd.Series(np.nan, index=a.index, dtype="float64")
            return np.nan
    return wrapper


def db_retry(max_attempts: int = 3, base_delay: float = 1.0):
    """数据库查询重试：指数退避，超过次数后抛出异常。"""
    def deco(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            last = None
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except Exception as exc:  # 仅网络/连接类异常需重试，这里保守全重试
                    last = exc
                    if attempt == max_attempts:
                        break
                    time.sleep(base_delay * (2 ** (attempt - 1)) * (0.5 + random.random()))
            logger.error("数据库操作失败 (%s): %s", getattr(func, "__name__", "?"), last)
            raise last
        return wrapper
    return deco
