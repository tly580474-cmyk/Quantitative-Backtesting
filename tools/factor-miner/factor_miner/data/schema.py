"""数据源 schema 与 SQL 片段。

库：本地 MySQL ``quant_backtest``（只读账号）。
核心表：
  * daily_bars_v2       日频 OHLCV（raw 未复权）
  * instruments         标的元数据 / 过滤
  * daily_stock_metrics 市值 / 估值 / ST 标记
"""
from __future__ import annotations

BARS = "daily_bars_v2"
INSTRUMENTS = "instruments"
METRICS = "daily_stock_metrics"

# 面板最终包含的基础列（终端集消费这些列）
PANEL_BASE_COLS = [
    "open", "high", "low", "close", "volume", "amount",
    "vwap", "turnover", "market_cap", "pe_ttm", "pb", "ps_ttm",
    "returns", "industry", "log_mktcap",
]

# 由原始列派生出的列
DERIVED_COLS = ["vwap", "returns", "log_mktcap"]

# 输出面板必须存在的列集合（供算子库校验）
REQUIRED_PANEL_COLS = set(PANEL_BASE_COLS)

SELECT_COLS = """
    i.symbol            AS symbol,
    i.industry          AS industry,
    i.type              AS inst_type,
    i.list_date         AS list_date,
    i.delist_date       AS delist_date,
    b.trade_date        AS trade_date,
    b.open              AS open,
    b.high              AS high,
    b.low               AS low,
    b.close             AS close,
    b.volume            AS volume,
    b.amount            AS amount,
    b.turnover_rate_pct AS turnover,
    m.total_market_cap  AS market_cap,
    m.pe_ttm            AS pe_ttm,
    m.pb                AS pb,
    m.ps_ttm            AS ps_ttm,
    m.is_st             AS is_st
"""


def build_query(start_date: str, n_sample: int = 0, seed: int | None = None) -> str:
    """构造取数 SQL（仅 SELECT）。基础过滤推到 SQL 层以减传输量。

    n_sample>0 时在 SQL 侧随机抽 N 个标的，避免传输全市场 16M 行。
    seed 不为 None 时用 RAND(seed) 保证抽样可复现。
    """
    sample_join = ""
    if n_sample and n_sample > 0:
        # MySQL 不支持 IN (子查询 LIMIT)，改用 JOIN 派生表（允许 LIMIT）
        rand_clause = f"RAND({int(seed)})" if seed is not None else "RAND()"
        sample_join = (
            f" JOIN (SELECT instrument_key FROM {INSTRUMENTS} "
            f"WHERE type <> 'index' ORDER BY {rand_clause} LIMIT {int(n_sample)}) samp "
            f"ON b.instrument_key = samp.instrument_key"
        )
    return f"""
    SELECT {SELECT_COLS}
    FROM {BARS} b
    JOIN {INSTRUMENTS} i ON b.instrument_key = i.instrument_key
    {sample_join}
    LEFT JOIN {METRICS} m
        ON b.instrument_key = m.instrument_key
       AND b.trade_date = m.trade_date
    WHERE b.trade_date >= :start_date
      AND i.type <> 'index'
      AND b.volume > 0
    """
