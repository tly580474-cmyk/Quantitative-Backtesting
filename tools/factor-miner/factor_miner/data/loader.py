"""数据接入层：从本地 MySQL 读取 → 过滤 → 组织 MultiIndex 面板 → 生成标签。

所有操作均为只读 SELECT。严格防未来函数：
  * 时间序列算子只在引擎侧消费 t 及之前的数据；
  * 适应度标签（forward return）使用 t 日之后的收益，天然滞后；
  * 复权因子在 M2 才引入，本期使用 raw 价先跑通。

返回结构::

    {
      "full":  <MultiIndex(symbol, date) 全量面板，含 forward_ret>,
      "train": <训练切片>,
      "valid": <验证切片>,
      "test":  <测试切片>,
    }
"""
from __future__ import annotations

import logging
import os
import random
from datetime import datetime

import numpy as np
import pandas as pd
from sqlalchemy import create_engine, text

from factor_miner.data import schema
from factor_miner.utils.decorators import db_retry

logger = logging.getLogger("factor_miner")


def _make_url(cfg: dict) -> str:
    d = cfg["data"]
    pwd = os.environ.get("FACTOR_MINER_DB_PASSWORD", d.get("password") or "")
    return (f"mysql+pymysql://{d['user']}:{pwd}@{d['host']}:{d['port']}/"
            f"{d['database']}?read_timeout=60&charset=utf8mb4")


@db_retry()
def _fetch_raw(cfg: dict) -> pd.DataFrame:
    url = _make_url(cfg)
    engine = create_engine(url, pool_pre_ping=True)
    sql = schema.build_query(
        cfg["data"].get("start_date", "2010-01-01"),
        n_sample=int(cfg["data"].get("sample_symbols", 0) or 0),
        seed=cfg["data"].get("sample_seed"),
    )
    with engine.connect() as conn:
        df = pd.read_sql(text(sql), conn, params={"start_date": cfg["data"]["start_date"]})
    logger.info("原始数据读取完成: %d 行", len(df))
    return df


def _apply_filters(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    u = cfg["data"]["universe"]
    n0 = len(df)
    if u.get("exclude_index", True):
        df = df[df["inst_type"] != "index"]
    if u.get("exclude_st", True):
        df = df[df["is_st"].fillna(0) != 1]
    if u.get("exclude_suspended", True):
        df = df[df["volume"] > 0]
    if u.get("exclude_delisted", True):
        ld = pd.to_datetime(df["list_date"])
        dd = pd.to_datetime(df["delist_date"])
        td = pd.to_datetime(df["trade_date"])
        df = df[(ld.isna() | (td >= ld)) & ((dd.isna()) | (td <= dd))]
    recent = int(u.get("recent_listing_days", 0) or 0)
    if recent > 0:
        td = pd.to_datetime(df["trade_date"])
        ld = pd.to_datetime(df["list_date"])
        df = df[ld.notna() & ((td - ld).dt.days >= recent)]
    if u.get("exclude_limit", False):
        # 涨跌停过滤（M2）：按日收益近似判定（主板上限于 +limit_pct，下限于 -limit_pct）。
        # 较「close==high」更稳健——后者会误删所有收在最高/最低价的正常交易日。
        lim = float(u.get("limit_pct", 0.095))
        r = df.groupby("symbol")["close"].pct_change()
        up = r >= lim
        down = r <= -lim
        df = df[~(up | down)]
    logger.info("过滤后剩余 %d 行 (剔除 %d)", len(df), n0 - len(df))
    return df


def _label_windows(cfg: dict) -> list[int]:
    """解析多窗口标签配置；缺省回退到单一 label_window。"""
    ws = cfg["data"].get("label_windows")
    if isinstance(ws, (list, tuple)) and len(ws) > 0:
        return [int(w) for w in ws]
    return [int(cfg["data"].get("label_window", 5))]


def _build_derived(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    # 按标的排序，便于逐标的时序计算
    df = df.sort_values(["symbol", "trade_date"]).reset_index(drop=True)
    g = df.groupby("symbol", group_keys=False)

    # 衍生量价
    vol = df["volume"].replace(0, np.nan)
    df["vwap"] = (df["amount"] / vol).fillna(df["close"])
    df["returns"] = g["close"].pct_change()

    # 多窗口收益标签：T 日收盘后产生信号，T+1 开盘进入，T+h 收盘退出。
    # 与主项目 factorRunner 的 LEAD(open, 1) / LEAD(close, horizon) 保持一致。
    windows = _label_windows(cfg)
    entry_volume = g["volume"].shift(-1)
    entry_raw_open = g["open"].shift(-1)
    limit_pct = float(cfg["data"].get("universe", {}).get("limit_pct", 0.095))
    entry_tradable = ((entry_volume > 0)
                      & ((entry_raw_open / df["close"] - 1.0).abs() < limit_pct))
    if cfg["data"].get("use_adjusted", False) and "adj_factor" in df.columns:
        # 后复权：adj_close = close * adj_factor / 每只标的末日 adj_factor
        last_af = g["adj_factor"].transform("last")
        df["close_adj"] = df["close"] * df["adj_factor"] / last_af
        df["returns"] = g["close_adj"].pct_change()
        df["open_adj"] = df["open"] * df["adj_factor"] / last_af
        entry = g["open_adj"].shift(-1)
        for w in windows:
            df[f"forward_ret_{w}"] = g["close_adj"].shift(-w) / entry - 1.0
            df.loc[~entry_tradable, f"forward_ret_{w}"] = np.nan
        logger.info("已启用后复权收益（adj_factor）生成标签")
    else:
        entry = g["open"].shift(-1)
        for w in windows:
            df[f"forward_ret_{w}"] = g["close"].shift(-w) / entry - 1.0
            df.loc[~entry_tradable, f"forward_ret_{w}"] = np.nan

    # 规模中性化控制变量：对数市值（clip 防止 <=0 取 log 出错）
    df["log_mktcap"] = np.log(df["market_cap"].clip(lower=1.0))

    # 缺失值处理：横截面中位数填充（量价/估值类），避免爆破 NaN
    for col in ["market_cap", "pe_ttm", "pb", "ps_ttm", "vwap", "turnover", "log_mktcap"]:
        if col in df.columns:
            df[col] = df.groupby("trade_date")[col].transform(
                lambda s: s.fillna(s.median()))
    return df


def _to_panel(df: pd.DataFrame) -> pd.DataFrame:
    df["trade_date"] = pd.to_datetime(df["trade_date"])
    df = df.set_index(["symbol", "trade_date"])
    df = df.sort_index()
    # 清理无穷 / 异常
    df = df.replace([np.inf, -np.inf], np.nan)
    return df


def _sample_symbols(df: pd.DataFrame, cfg: dict, n: int | None = None) -> pd.DataFrame:
    """按标的抽样面板（用于限制 GP 求值规模）。

    n 优先显式传入；否则读 ``data.gp_panel_symbols``（GP 面板标的数），
    回退到 ``data.sample_symbols``（抽取侧抽样，兼容 --quick）。
    0/负数表示不抽样（全市场，内存占用高）。
    """
    if n is None:
        n = int(cfg["data"].get("gp_panel_symbols") or cfg["data"].get("sample_symbols") or 0)
    n = int(n)
    if n <= 0:
        return df
    syms = df.index.get_level_values(0).unique()
    if n >= len(syms):
        return df
    rng = random.Random(cfg["evolution"].get("seed", 0))
    pick = set(rng.sample(list(syms), n))
    return df[df.index.get_level_values(0).isin(pick)]


def build_panel(cfg: dict) -> dict:
    """端到端构建训练/验证/测试面板。"""
    if str(cfg.get("data", {}).get("source", "mysql")).lower() == "snapshot":
        from factor_miner.data.snapshot import read_published_snapshot
        raw, lineage = read_published_snapshot(cfg)
        raw = _build_derived(raw, cfg)
        raw = _apply_filters(raw, cfg)
        panel = _to_panel(raw)
        result = _split_panel(panel, cfg)
        result["lineage"] = lineage
        result["data_kind"] = "published_snapshot"
        return result
    if str(cfg.get("data", {}).get("engine", "pandas")).lower() == "dask":
        from factor_miner.data.loader_dask import build_panel_dask
        return build_panel_dask(cfg)
    raw = _fetch_raw(cfg)
    raw = _build_derived(raw, cfg)
    raw = _apply_filters(raw, cfg)
    panel = _to_panel(raw)

    result = _split_panel(panel, cfg)
    logger.info("面板构建完成 | train=%d valid=%d test=%d | 标的=%d",
                len(result["train"]), len(result["valid"]), len(result["test"]),
                panel.index.get_level_values(0).nunique())
    return result


def _split_panel(panel: pd.DataFrame, cfg: dict) -> dict:
    """按交易时间严格切分，供 MySQL 与已发布快照共用。"""
    te = cfg["data"].get("train_end")
    ve = cfg["data"].get("valid_end")
    dates = panel.index.get_level_values(1)
    train = panel[dates <= pd.Timestamp(te)]
    valid = panel[(dates > pd.Timestamp(te)) & (dates <= pd.Timestamp(ve))]
    test = panel[dates > pd.Timestamp(ve)]

    # Purged chronological split：边界前最后 h 个信号的标签会使用下一分区价格，
    # 必须从训练/验证统计中剔除，避免标签跨区间泄漏。
    embargo = max(_label_windows(cfg))
    train = _purge_tail_dates(train, embargo)
    valid = _purge_tail_dates(valid, embargo)

    train = _sample_symbols(train, cfg)
    return {"full": panel, "train": train, "valid": valid, "test": test}


def _purge_tail_dates(panel: pd.DataFrame, periods: int) -> pd.DataFrame:
    unique = panel.index.get_level_values(1).unique().sort_values()
    if periods <= 0 or len(unique) <= periods:
        return panel.iloc[0:0] if len(unique) <= periods else panel
    cutoff = unique[-periods - 1]
    return panel[panel.index.get_level_values(1) <= cutoff]


def make_synthetic_panel(n_symbols: int = 50, n_dates: int = 500,
                         seed: int = 42, label_window: int = 5,
                         label_windows: list[int] | None = None) -> dict:
    """构造带信号的可复现合成面板，用于无数据库的单元测试 / 快速验证。

    数据生成方式：每个标的用带漂移的随机游走；构造一个潜因子
    ``latent = ts_mean(returns,5)`` 决定未来收益，使遗传规划能挖出与之相关的表达式。
    M2：支持多窗口标签（label_windows）。
    """
    rng = np.random.default_rng(seed)
    start = pd.Timestamp("2015-01-05")
    dates = pd.date_range(start, periods=n_dates, freq="B")
    dates = dates[:n_dates]
    # 控制横截面规模
    n_symbols = min(n_symbols, 200)

    windows = list(label_windows) if label_windows else [int(label_window)]
    frames = []
    for s in range(n_symbols):
        ret = rng.normal(0.0003, 0.02, size=n_dates)
        close = 10 * np.cumprod(1 + ret)
        vol = rng.lognormal(10, 0.6, size=n_dates) * (1 + np.abs(ret) * 20)
        vol = vol.astype("float64")
        amount = vol * close * rng.uniform(0.8, 1.2, size=n_dates)
        high = close * (1 + np.abs(rng.normal(0, 0.01, n_dates)))
        low = close * (1 - np.abs(rng.normal(0, 0.01, n_dates)))
        open_ = close * (1 + rng.normal(0, 0.005, n_dates))
        industry = f"IND{s % 5}"
        # 潜因子：过去 label_window 日收益均值（可被 GP 学到的真实信号）
        lat = pd.Series(ret).rolling(int(label_window), min_periods=2).mean().to_numpy()
        fwd = {}
        for w in windows:
            w = int(w)
            fut = np.full(n_dates, np.nan)
            for t in range(n_dates - w):
                sig = 0.0 if np.isnan(lat[t]) else lat[t]
                fut[t] = 5.0 * sig + rng.normal(0, 0.02)
            fwd[f"forward_ret_{w}"] = fut
        sym = f"S{s:03d}"
        frames.append(pd.DataFrame({
            "symbol": sym,
            "trade_date": dates,
            "open": open_, "high": high, "low": low, "close": close,
            "volume": vol, "amount": amount,
            "vwap": amount / vol,
            "turnover": rng.uniform(0.5, 5.0, n_dates),
            "market_cap": close * rng.uniform(1e8, 1e10, n_dates),
            "pe_ttm": rng.uniform(5, 50, n_dates),
            "pb": rng.uniform(0.5, 8, n_dates),
            "ps_ttm": rng.uniform(1, 20, n_dates),
            "returns": ret,
            "industry": industry,
            **fwd,
        }))
    df = pd.concat(frames, ignore_index=True)
    df["is_st"] = 0
    df["inst_type"] = "stock"
    # 规模中性化控制变量（合成数据同样提供，保证算子可测）
    df["log_mktcap"] = np.log(df["market_cap"].clip(lower=1.0))
    df["list_date"] = start - pd.Timedelta(days=1000)
    df["delist_date"] = pd.NaT
    panel = _to_panel(df)
    # 合成数据也必须遵守时间顺序切分，否则流程测试会掩盖验证/测试泄漏。
    # 60/20/20 只用于程序正确性回归，不构成真实 OOS 证据。
    unique_dates = panel.index.get_level_values(1).unique().sort_values()
    train_pos = max(1, int(len(unique_dates) * 0.6))
    valid_pos = max(train_pos + 1, int(len(unique_dates) * 0.8))
    valid_pos = min(valid_pos, len(unique_dates) - 1)
    train_end = unique_dates[train_pos - 1]
    valid_end = unique_dates[valid_pos - 1]
    dates_idx = panel.index.get_level_values(1)
    result = {
        "full": panel,
        "train": panel[dates_idx <= train_end],
        "valid": panel[(dates_idx > train_end) & (dates_idx <= valid_end)],
        "test": panel[dates_idx > valid_end],
        "data_kind": "synthetic",
    }
    result["train"] = _purge_tail_dates(result["train"], int(label_window))
    result["valid"] = _purge_tail_dates(result["valid"], int(label_window))
    return result
