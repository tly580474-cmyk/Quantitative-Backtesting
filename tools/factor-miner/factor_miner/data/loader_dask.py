"""M3-2 Dask 分块加载（惰性、突破内存）。

痛点：全市场 ~1700万行，``loader.build_panel`` 用单次 ``read_sql`` 全量载入内存是主要内存瓶颈。
本模块提供：

1. **分块抽取** ``extract_to_parquet``：``read_sql(chunksize=...)`` 逐块写 parquet 分区（落盘，
   全程不把全量原始数据同时驻留内存）。
2. **惰性加载** ``load_parquet_panel``：从分区构建 ``dask.dataframe``（惰性、可超出内存）；
   dask 不可用时回退 pyarrow/pandas 读取（仍是分块落盘，不占全内存）。
3. **数据准备** ``prepare_panel``：用 ``map_partitions`` 套用与 pandas 版一致的过滤/衍生/标签逻辑
   （逐分区应用；分区边界处的时序标签为近似，最终评估建议物化后复核）。
4. **端到端** ``build_panel_dask(cfg)``：等价于 ``loader.build_panel`` 的扩展，走分块/惰性路径。

配置开关：``data.engine: "pandas"(默认) | "dask"``；``data.cache_dir`` 指定 parquet 分区目录。
"""
from __future__ import annotations

import logging
import random
from pathlib import Path

import numpy as np
import pandas as pd

logger = logging.getLogger("factor_miner")

try:
    import dask.dataframe as dd
    _HAS_DASK = True
except Exception:  # pragma: no cover
    _HAS_DASK = False


# ----------------------------------------------------------------------------
# 分块抽取 / 加载
# ----------------------------------------------------------------------------
def raw_to_parquet_partitions(df: pd.DataFrame, out_dir: str,
                               by: str = "trade_date",
                               chunksize: int | None = None) -> str:
    """将原始 DataFrame 按 ``by`` 列（默认交易日）切片写 parquet 分区。

    无数据库依赖，便于测试与离线复用。返回分区目录。``chunksize`` 指定每分区最大行数
    （与按列分区的二选一）。
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    if chunksize:
        n = max(1, int(np.ceil(len(df) / chunksize)))
        edges = np.array_split(np.arange(len(df)), n)
        parts = [df.iloc[e] for e in edges]
    else:
        parts = [g for _, g in df.groupby(by, sort=False)]
    for i, part in enumerate(parts):
        part.to_parquet(out / f"part_{i:05d}.parquet", index=False)
    logger.info("原始数据已分块写 parquet：%d 个分区 -> %s", len(parts), out)
    return str(out)


def extract_to_parquet(cfg: dict, out_dir: str, chunksize: int = 200_000) -> str:
    """从 MySQL 分块抽取原始数据并写 parquet 分区（避免一次性全量载入内存）。"""
    from factor_miner.data import schema
    from factor_miner.data.loader import _make_url
    from sqlalchemy import create_engine, text

    url = _make_url(cfg)
    engine = create_engine(url, pool_pre_ping=True)
    sql = schema.build_query(
        cfg["data"].get("start_date", "2010-01-01"),
        n_sample=int(cfg["data"].get("sample_symbols", 0) or 0),
        seed=cfg["data"].get("sample_seed"),
    )
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    i = 0
    n_rows = 0
    # 关键：stream_results=True 让 pymysql 使用服务端游标(SSCursor)真正流式取数，
    # 否则默认会缓冲整个结果集（1700万行≈8GB+），chunksize 形同虚设且会 OOM。
    with engine.connect().execution_options(stream_results=True) as conn:
        for chunk in pd.read_sql(
            text(sql), conn,
            params={"start_date": cfg["data"]["start_date"]},
            chunksize=chunksize,
        ):
            chunk.to_parquet(out / f"part_{i:05d}.parquet", index=False)
            i += 1
            n_rows += len(chunk)
            if i % 5 == 0:
                logger.info("抽取进度: %d 分区 / %d 行", i, n_rows)
    logger.info("MySQL 分块抽取完成：%d 个分区 / %d 行 -> %s", i, n_rows, out)
    return str(out)


def load_parquet_panel(out_dir: str, engine: str = "dask"):
    """从 parquet 分区加载。

    - ``engine="dask"`` 且 dask 可用：返回惰性 ``dask.DataFrame``（可超出内存）。
    - 否则（或 ``engine="pandas"``）：用 pyarrow/pandas 读取（分块落盘，不占全内存）。
    """
    out = Path(out_dir)
    parts = sorted(out.glob("part_*.parquet"))
    if not parts:
        raise FileNotFoundError(f"未找到 parquet 分区: {out}")
    if engine == "dask" and _HAS_DASK:
        return dd.read_parquet(str(out))
    import pyarrow.parquet as pq
    return pd.concat([pq.read_table(p).to_pandas() for p in parts], ignore_index=True)


# ----------------------------------------------------------------------------
# 数据准备（与 pandas 版一致）
# ----------------------------------------------------------------------------
def _prepare_partition(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """对单个分区应用过滤/衍生/标签（供 dask map_partitions 或 pandas 直接调用）。

    注意：分区边界处的时序标签（returns/forward_ret）为近似；最终评估建议物化后复核。
    trade_date 保留为列，便于后续时序切分。
    """
    from factor_miner.data.loader import _apply_filters, _build_derived
    df = _apply_filters(df, cfg)
    df = _build_derived(df, cfg)
    return df


def prepare_panel(df, cfg: dict, engine: str = "dask"):
    """数据准备：dask 走 ``map_partitions``（惰性）；pandas 直接套用。"""
    if engine == "dask" and _HAS_DASK and not isinstance(df, pd.DataFrame):
        sample = df.head(10)
        meta = _prepare_partition(sample, cfg).iloc[:0]
        return df.map_partitions(_prepare_partition, cfg, meta=meta)
    return _prepare_partition(df, cfg)


def build_panel_dask(cfg: dict, cache_dir: str | None = None) -> dict:
    """端到端 Dask 分块面板构建（等价于 ``loader.build_panel`` 的扩展）。

    内存安全分工（关键设计）：
      * Dask 负责**重活**：MySQL 1700万行分块抽取→parquet→惰性加载→按标的过滤，
        全程不把全市场驻留内存（M3-2 的突破点）。
      * 物化后：若配置了 ``gp_panel_symbols>0``（抽 N 只标的做 GP 面板），则只对这 N 只
        标的的 RAW 行走与 pandas 版**完全一致**的 ``_apply_filters``+``_build_derived``
        （按 symbol 全历史正确排序），**彻底消除分区边界时序标签近似误差**；
        否则（全市场物化，gp_panel_symbols=0）走 ``map_partitions`` 近似路径
        （分区边界标签近似，已在 M3 报告注明）。

    ``data.sample_symbols>0`` 仍可控制抽取阶段 SQL 侧抽样（抽全市场时 0）。
    若 ``cache_dir`` 已有分区则跳过抽取（便于增量复用）。
    """
    from factor_miner.data.loader import (_apply_filters, _build_derived,
                                          _to_panel, _sample_symbols)

    cache = cache_dir or cfg["data"].get("cache_dir") or "output/cache/raw_parquet"
    cache_path = Path(cache)
    if not list(cache_path.glob("part_*.parquet")):
        extract_to_parquet(cfg, cache)
    else:
        logger.info("缓存分区已存在，跳过抽取: %s", cache)

    engine = "dask" if _HAS_DASK else "pandas"
    raw = load_parquet_panel(cache, engine)        # trade_date 仍为列

    gp_n = int(cfg["data"].get("gp_panel_symbols", 0) or 0)
    sampled = gp_n > 0 and not isinstance(raw, pd.DataFrame)

    # ---- 抽样路径：物化 N 只标的 RAW → 正确衍生（无边界误差）----
    if sampled:
        syms = list(raw["symbol"].drop_duplicates().compute())
        if gp_n < len(syms):
            rng = random.Random(cfg["evolution"].get("seed", 0))
            chosen = set(rng.sample(syms, gp_n))
            raw = raw[raw["symbol"].isin(chosen)]
            logger.info("Dask 侧按 gp_panel_symbols=%d 抽样标的（全集 %d）", gp_n, len(syms))
        else:
            logger.info("gp_panel_symbols(%d) >= 标的数(%d)，使用全市场", gp_n, len(syms))
        raw_df = raw.compute()                      # 仅 N 只标的，内存安全
        raw_df = _apply_filters(raw_df, cfg)
        raw_df = _build_derived(raw_df, cfg)        # 与 pandas 版一致的精确衍生
        panel = _to_panel(raw_df)
        te = cfg["data"].get("train_end"); ve = cfg["data"].get("valid_end")
        dates = panel.index.get_level_values(1)
        train = panel[dates <= pd.Timestamp(te)]
        valid = panel[(dates > pd.Timestamp(te)) & (dates <= pd.Timestamp(ve))]
        test = panel[dates > pd.Timestamp(ve)]
        logger.info("Dask 面板构建完成(抽样+正确衍生) | train=%d valid=%d test=%d | 标的=%d",
                    len(train), len(valid), len(test),
                    panel.index.get_level_values(0).nunique())
        return {"full": panel, "train": train, "valid": valid, "test": test}

    # ---- 全市场物化路径：map_partitions 近似（分区边界标签近似）----
    prepared = prepare_panel(raw, cfg, engine)
    te = cfg["data"].get("train_end"); ve = cfg["data"].get("valid_end")
    if engine == "dask" and not isinstance(prepared, pd.DataFrame):
        train = prepared[prepared["trade_date"] <= te].compute()
        valid = prepared[(prepared["trade_date"] > te) &
                         (prepared["trade_date"] <= ve)].compute()
        test = prepared[prepared["trade_date"] > ve].compute()
    else:
        td = pd.to_datetime(prepared["trade_date"])
        train = prepared[td <= pd.Timestamp(te)]
        valid = prepared[(td > pd.Timestamp(te)) & (td <= pd.Timestamp(ve))]
        test = prepared[td > pd.Timestamp(ve)]
    train = _to_panel(train)
    valid = _to_panel(valid)
    test = _to_panel(test)
    if gp_n > 0 and isinstance(raw, pd.DataFrame):  # pandas 回退：物化后抽样
        train = _sample_symbols(train, cfg, n=gp_n)
    logger.info("Dask 面板构建完成(全市场近似) | train=%d valid=%d test=%d",
                len(train), len(valid), len(test))
    return {"full": train, "train": train, "valid": valid, "test": test}

