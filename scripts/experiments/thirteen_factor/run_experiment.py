from __future__ import annotations

import json
import math
import os
import platform
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

SCRIPT_FILE = Path(__file__).resolve()
REPO_ROOT = next(
    parent for parent in SCRIPT_FILE.parents if (parent / "package.json").exists()
)
EXPERIMENT_DIR = REPO_ROOT / "tmp_output" / "thirteen_factor_experiment"
EXPERIMENT_DIR.mkdir(parents=True, exist_ok=True)
VENDOR_DIR = EXPERIMENT_DIR / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

import duckdb
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import plotly.io as pio
from jinja2 import Template


SNAPSHOT_ROOT = REPO_ROOT / "server" / "data" / "research-snapshots"
CURRENT_JSON = SNAPSHOT_ROOT / "current.json"
DB_PATH = EXPERIMENT_DIR / "experiment.duckdb"
PANEL_PATH = EXPERIMENT_DIR / "signal_panel_market_aligned.parquet"
SCORES_PATH = EXPERIMENT_DIR / "processed_scores_market_aligned.parquet"
SELECTIONS_PATH = EXPERIMENT_DIR / "portfolio_selections_market_aligned.csv"
PERIOD_PATH = EXPERIMENT_DIR / "period_returns_market_aligned.csv"
FACTOR_IC_PATH = EXPERIMENT_DIR / "factor_ic_market_aligned.csv"
METRICS_PATH = EXPERIMENT_DIR / "strategy_metrics_market_aligned.csv"
REPORT_PATH = EXPERIMENT_DIR / "thirteen_factor_experiment_report.html"
METADATA_PATH = EXPERIMENT_DIR / "run_metadata.json"
LOG_PATH = EXPERIMENT_DIR / "run.log"

START_DATE = "2015-01-05"
ROLLING_START_DATE = "2014-01-01"
REBALANCE_SESSIONS = 5
PORTFOLIO_SIZE = 100
MIN_FACTOR_COUNT = 10
COST_PER_TRADED_NOTIONAL = 0.0015  # 15 bp on each buy/sell notional
RANDOM_SEED = 20260729


def log(message: str) -> None:
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    print(line, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def qpath(path: Path) -> str:
    return path.resolve().as_posix().replace("'", "''")


def load_snapshot() -> tuple[str, Path, dict]:
    pointer = json.loads(CURRENT_JSON.read_text(encoding="utf-8"))
    snapshot_id = pointer["snapshotId"]
    snapshot_dir = SNAPSHOT_ROOT / snapshot_id
    manifest = json.loads((snapshot_dir / "manifest.json").read_text(encoding="utf-8"))
    return snapshot_id, snapshot_dir, manifest


def build_panel(con: duckdb.DuckDBPyConnection, snapshot_dir: Path) -> None:
    if PANEL_PATH.exists():
        log(f"复用信号面板缓存: {PANEL_PATH.name}")
        return

    bars_glob = qpath(snapshot_dir / "bars" / "**" / "*.parquet")
    fin_path = qpath(snapshot_dir / "financial_reports" / "data.parquet")
    panel_path = qpath(PANEL_PATH)

    sql = f"""
    COPY (
      WITH
      all_bars AS (
        SELECT * EXCLUDE(year)
        FROM read_parquet('{bars_glob}', hive_partitioning=true)
      ),
      listing AS (
        SELECT instrumentKey, min(tradeDate) AS listingDate
        FROM all_bars
        GROUP BY instrumentKey
      ),
      calendar_numbered AS (
        SELECT
          tradeDate,
          row_number() OVER (ORDER BY tradeDate) AS sessionNo
        FROM (
          SELECT DISTINCT tradeDate
          FROM all_bars
          WHERE tradeDate >= DATE '{ROLLING_START_DATE}'
        )
      ),
      calendar_all AS (
        SELECT
          *,
          max(sessionNo) OVER () AS maxSessionNo
        FROM calendar_numbered
      ),
      daily AS (
        SELECT
          b.instrumentKey, b.market, b.symbol, b.name, b.industry, b.tradeDate,
          b.close, b.previousClose, b.turnoverRatePct, b.totalMarketCap,
          l.listingDate, c.sessionNo, c.maxSessionNo - c.sessionNo AS marketFutureSessions,
          avg(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnover20,
          stddev_samp(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnoverStd20,
          count(b.turnoverRatePct) OVER (
            PARTITION BY b.instrumentKey ORDER BY b.tradeDate
            ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS turnoverObs20,
          coalesce(
            product(
              CASE
                WHEN b.previousClose > 0 AND b.close > 0
                  THEN greatest(0.01, b.close / b.previousClose)
                ELSE 1.0
              END
            ) OVER (
              PARTITION BY b.instrumentKey ORDER BY c.sessionNo
              RANGE BETWEEN 1 FOLLOWING AND {REBALANCE_SESSIONS} FOLLOWING
            ) - 1.0,
            0.0
          ) AS fwd5Return
        FROM all_bars b
        JOIN listing l USING (instrumentKey)
        JOIN calendar_all c USING (tradeDate)
        WHERE b.tradeDate >= DATE '{ROLLING_START_DATE}'
      ),
      calendar AS (
        SELECT
          tradeDate,
          row_number() OVER (ORDER BY tradeDate) AS sessionNo
        FROM (SELECT DISTINCT tradeDate FROM daily WHERE tradeDate >= DATE '{START_DATE}')
      ),
      signal_dates AS (
        SELECT tradeDate
        FROM calendar
        WHERE (sessionNo - 1) % {REBALANCE_SESSIONS} = 0
      ),
      eligible AS (
        SELECT d.*
        FROM daily d
        JOIN signal_dates s USING (tradeDate)
        WHERE d.market IN ('SH', 'SZ')
          AND d.symbol NOT LIKE '688%'
          AND d.symbol NOT LIKE '689%'
          AND upper(coalesce(d.name, '')) NOT LIKE '%ST%'
          AND d.close > 1.2
          AND date_diff('day', d.listingDate, d.tradeDate) >= 365
          AND d.turnoverObs20 >= 15
          AND d.marketFutureSessions >= {REBALANCE_SESSIONS}
          AND d.totalMarketCap > 0
      ),
      fin_raw AS (
        SELECT
          *,
          coalesce(roeWeightedPct, roePct, roeCalculatedPct) AS roeValue,
          coalesce(totalRevenue, revenue) AS revenueValue
        FROM read_parquet('{fin_path}')
        WHERE announcementDate IS NOT NULL
      ),
      fin_filled AS (
        SELECT
          instrumentKey, announcementDate, reportPeriod, updateFlag, fetchedAt,
          last_value(roeValue IGNORE NULLS) OVER w AS roe,
          last_value(grossMarginPct IGNORE NULLS) OVER w AS grossMargin,
          last_value(operatingCashFlowToRevenuePct IGNORE NULLS) OVER w AS ocfToRevenue,
          last_value(freeCashFlow IGNORE NULLS) OVER w AS freeCashFlow,
          last_value(debtToAssetsPct IGNORE NULLS) OVER w AS debtToAssets,
          last_value(receivablesTurnover IGNORE NULLS) OVER w AS receivablesTurnover,
          last_value(inventoryTurnover IGNORE NULLS) OVER w AS inventoryTurnover,
          last_value(revenueValue IGNORE NULLS) OVER w AS totalRevenue,
          last_value(totalAssets IGNORE NULLS) OVER w AS totalAssets,
          last_value(shortTermBorrowings IGNORE NULLS) OVER w AS shortTermBorrowings,
          last_value(longTermBorrowings IGNORE NULLS) OVER w AS longTermBorrowings,
          last_value(bondsPayable IGNORE NULLS) OVER w AS bondsPayable,
          last_value(cashAndEquivalents IGNORE NULLS) OVER w AS cashAndEquivalents
        FROM fin_raw
        WINDOW w AS (
          PARTITION BY instrumentKey
          ORDER BY announcementDate, reportPeriod, updateFlag, fetchedAt
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        )
      ),
      fin_daily AS (
        SELECT * EXCLUDE(rn)
        FROM (
          SELECT
            *,
            row_number() OVER (
              PARTITION BY instrumentKey, announcementDate
              ORDER BY reportPeriod DESC, updateFlag DESC, fetchedAt DESC
            ) AS rn
          FROM fin_filled
        )
        WHERE rn = 1
      ),
      joined AS (
        SELECT
          e.instrumentKey, e.market, e.symbol, e.name, e.industry, e.tradeDate,
          e.close, e.listingDate, e.totalMarketCap,
          e.turnoverRatePct AS turnover, e.turnover20, e.turnoverStd20,
          e.fwd5Return,
          f.announcementDate AS financialAsOf,
          f.roe, f.grossMargin, f.ocfToRevenue, f.freeCashFlow,
          f.debtToAssets, f.receivablesTurnover, f.inventoryTurnover,
          f.totalRevenue, f.totalAssets,
          (
            e.totalMarketCap
            + coalesce(f.shortTermBorrowings, 0)
            + coalesce(f.longTermBorrowings, 0)
            + coalesce(f.bondsPayable, 0)
            - coalesce(f.cashAndEquivalents, 0)
          ) AS enterpriseValue
        FROM eligible e
        ASOF LEFT JOIN fin_daily f
          ON e.instrumentKey = f.instrumentKey
         AND e.tradeDate >= f.announcementDate
      )
      SELECT
        *,
        CASE
          WHEN enterpriseValue > 0 THEN freeCashFlow / enterpriseValue
          ELSE NULL
        END AS fcfToEv,
        CASE WHEN totalMarketCap > 0 THEN ln(totalMarketCap) ELSE NULL END AS logMarketCap,
        CASE WHEN totalRevenue > 0 THEN ln(totalRevenue) ELSE NULL END AS logRevenue,
        CASE WHEN totalAssets > 0 THEN ln(totalAssets) ELSE NULL END AS logAssets
      FROM joined
      ORDER BY tradeDate, instrumentKey
    ) TO '{panel_path}' (FORMAT PARQUET, COMPRESSION ZSTD);
    """
    log("构建逐5交易日、公告时点约束的信号面板...")
    con.execute(sql)
    count, min_date, max_date = con.execute(
        f"SELECT count(*), min(tradeDate), max(tradeDate) FROM read_parquet('{panel_path}')"
    ).fetchone()
    log(f"信号面板完成: {count:,} 行, {min_date} 至 {max_date}")


@dataclass(frozen=True)
class Factor:
    key: str
    label: str
    category: str
    direction: int
    cap_neutral: bool


FACTORS = [
    Factor("roe", "ROE", "盈利", 1, True),
    Factor("grossMargin", "毛利率", "盈利", 1, True),
    Factor("ocfToRevenue", "经营现金流/营收", "现金流", 1, True),
    Factor("fcfToEv", "自由现金流/企业价值", "现金流", 1, True),
    Factor("debtToAssets", "资产负债率", "质量", -1, True),
    Factor("receivablesTurnover", "应收账款周转率", "质量", 1, True),
    Factor("inventoryTurnover", "存货周转率", "质量", 1, True),
    Factor("logMarketCap", "总市值(对数)", "规模", 1, False),
    Factor("logRevenue", "营业收入(对数)", "规模", 1, False),
    Factor("logAssets", "总资产(对数)", "规模", 1, False),
    Factor("turnover", "换手率", "换手率", -1, True),
    Factor("turnover20", "20日平均换手率", "换手率", -1, True),
    Factor("turnoverStd20", "20日换手率标准差", "换手率", -1, True),
]


def winsor_z(series: pd.Series) -> pd.Series:
    values = pd.to_numeric(series, errors="coerce").astype(float)
    valid = values.dropna()
    if len(valid) < 5:
        return pd.Series(np.nan, index=series.index)
    lo, hi = valid.quantile([0.01, 0.99])
    clipped = values.clip(lo, hi)
    sd = clipped.std(ddof=0)
    if not np.isfinite(sd) or sd < 1e-12:
        return pd.Series(np.nan, index=series.index)
    return (clipped - clipped.mean()) / sd


def neutralize(
    z: pd.Series, industries: pd.Series, cap_z: pd.Series, cap_neutral: bool
) -> pd.Series:
    industry = industries.fillna("未知").astype(str)
    residual = z - z.groupby(industry).transform("mean")
    if cap_neutral:
        cap_dm = cap_z - cap_z.groupby(industry).transform("mean")
        mask = residual.notna() & cap_dm.notna()
        denom = float(np.dot(cap_dm[mask], cap_dm[mask]))
        if denom > 1e-12:
            beta = float(np.dot(cap_dm[mask], residual[mask]) / denom)
            residual = residual - beta * cap_dm
    sd = residual.std(ddof=0)
    if not np.isfinite(sd) or sd < 1e-12:
        return pd.Series(np.nan, index=z.index)
    return (residual - residual.mean()) / sd


def spearman(x: pd.Series, y: pd.Series) -> float:
    mask = x.notna() & y.notna()
    if mask.sum() < 20:
        return float("nan")
    return float(x[mask].rank().corr(y[mask].rank()))


def process_scores(con: duckdb.DuckDBPyConnection) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    if SCORES_PATH.exists() and SELECTIONS_PATH.exists() and FACTOR_IC_PATH.exists():
        log("复用已处理得分、选股与IC缓存")
        scores = con.execute(f"SELECT * FROM read_parquet('{qpath(SCORES_PATH)}')").fetchdf()
        selections = pd.read_csv(SELECTIONS_PATH, parse_dates=["tradeDate"])
        factor_ic = pd.read_csv(FACTOR_IC_PATH, parse_dates=["tradeDate"])
        return scores, selections, factor_ic

    panel = f"read_parquet('{qpath(PANEL_PATH)}')"
    years = [row[0] for row in con.execute(f"SELECT DISTINCT year(tradeDate) FROM {panel} ORDER BY 1").fetchall()]
    score_frames: list[pd.DataFrame] = []
    selections: list[pd.DataFrame] = []
    ic_rows: list[dict] = []

    factor_keys = [factor.key for factor in FACTORS]
    categories = sorted({factor.category for factor in FACTORS})
    log(f"横截面处理 {len(years)} 个年份: 去极值→标准化→中性化→等权")

    for year in years:
        columns = [
            "instrumentKey", "market", "symbol", "name", "industry", "tradeDate",
            "fwd5Return", "financialAsOf", *factor_keys,
        ]
        df = con.execute(
            f"SELECT {','.join(columns)} FROM {panel} WHERE year(tradeDate) = ? ORDER BY tradeDate,instrumentKey",
            [year],
        ).fetchdf()
        df["tradeDate"] = pd.to_datetime(df["tradeDate"])
        df["financialAsOf"] = pd.to_datetime(df["financialAsOf"])

        processed_dates: list[pd.DataFrame] = []
        for trade_date, cross in df.groupby("tradeDate", sort=True):
            cross = cross.copy()
            raw_z: dict[str, pd.Series] = {}
            neutral_z: dict[str, pd.Series] = {}
            cap_z = winsor_z(cross["logMarketCap"])
            for factor in FACTORS:
                base_z = winsor_z(cross[factor.key]) * factor.direction
                raw_z[factor.key] = base_z
                neutral_z[factor.key] = neutralize(
                    base_z, cross["industry"], cap_z, factor.cap_neutral
                )
                ic_rows.append(
                    {
                        "tradeDate": trade_date,
                        "factor": factor.key,
                        "label": factor.label,
                        "category": factor.category,
                        "ic": spearman(neutral_z[factor.key], cross["fwd5Return"]),
                        "coverage": int(cross[factor.key].notna().sum()),
                        "universe": len(cross),
                    }
                )

            neutral_frame = pd.DataFrame(neutral_z, index=cross.index)
            raw_frame = pd.DataFrame(raw_z, index=cross.index)
            cross["factorCount"] = neutral_frame.notna().sum(axis=1)
            neutral_filled = neutral_frame.fillna(0.0)
            raw_filled = raw_frame.fillna(0.0)
            cross["score"] = neutral_filled.mean(axis=1)
            cross["rawScore"] = raw_filled.mean(axis=1)
            cross["strictScore"] = neutral_frame.mean(axis=1, skipna=False)
            for category in categories:
                keys = [f.key for f in FACTORS if f.category == category]
                cross[f"category_{category}"] = neutral_filled[keys].mean(axis=1)
            for factor in FACTORS:
                cross[f"z_{factor.key}"] = neutral_frame[factor.key]

            usable = cross[cross["factorCount"] >= MIN_FACTOR_COUNT].copy()
            if len(usable) >= PORTFOLIO_SIZE * 2:
                strategy_scores = {
                    "13因子-中性化": ("score", False),
                    "13因子-未中性化": ("rawScore", False),
                    "13因子-严格完整": ("strictScore", False),
                    "13因子-反向Bottom100": ("score", True),
                }
                for category in categories:
                    strategy_scores[f"仅{category}"] = (f"category_{category}", False)

                for strategy, (column, ascending) in strategy_scores.items():
                    pool = usable.dropna(subset=[column])
                    if len(pool) < PORTFOLIO_SIZE:
                        continue
                    chosen = pool.nsmallest(PORTFOLIO_SIZE, column) if ascending else pool.nlargest(PORTFOLIO_SIZE, column)
                    out = chosen[
                        ["tradeDate", "instrumentKey", "symbol", "name", "industry", "fwd5Return", column]
                    ].copy()
                    out = out.rename(columns={column: "selectionScore"})
                    out["strategy"] = strategy
                    selections.append(out)

                rng = np.random.default_rng(RANDOM_SEED + int(trade_date.strftime("%Y%m%d")))
                random_idx = rng.choice(usable.index.to_numpy(), PORTFOLIO_SIZE, replace=False)
                random_pick = usable.loc[random_idx, [
                    "tradeDate", "instrumentKey", "symbol", "name", "industry", "fwd5Return", "score"
                ]].copy()
                random_pick = random_pick.rename(columns={"score": "selectionScore"})
                random_pick["strategy"] = "随机100"
                selections.append(random_pick)

            keep = [
                "instrumentKey", "symbol", "name", "industry", "tradeDate", "fwd5Return",
                "financialAsOf", "factorCount", "score", "rawScore", "strictScore",
                *[f"category_{category}" for category in categories],
                *[f"z_{factor.key}" for factor in FACTORS],
            ]
            processed_dates.append(cross[keep])

        score_frames.append(pd.concat(processed_dates, ignore_index=True))
        log(f"{year}: {len(df):,} 个股票-时点")

    scores = pd.concat(score_frames, ignore_index=True)
    selection_df = pd.concat(selections, ignore_index=True)
    factor_ic = pd.DataFrame(ic_rows)

    # DuckDB 1.4 does not yet recognize pandas 3's dedicated ``str`` dtype.
    for column in ["symbol", "name", "industry"]:
        scores[column] = scores[column].astype(object)
    con.register("scores_df", scores)
    con.execute(
        f"COPY scores_df TO '{qpath(SCORES_PATH)}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    selection_df.to_csv(SELECTIONS_PATH, index=False, encoding="utf-8-sig")
    factor_ic.to_csv(FACTOR_IC_PATH, index=False, encoding="utf-8-sig")
    log(f"得分与组合缓存完成: {len(scores):,} 行, {len(selection_df):,} 条持仓")
    return scores, selection_df, factor_ic


def portfolio_period_returns(selections: pd.DataFrame) -> pd.DataFrame:
    rows: list[dict] = []
    for strategy, data in selections.groupby("strategy"):
        previous: dict[int, float] = {}
        for trade_date, holdings in data.groupby("tradeDate", sort=True):
            holdings = holdings.dropna(subset=["fwd5Return"])
            if holdings.empty:
                continue
            weights = {int(key): 1.0 / len(holdings) for key in holdings["instrumentKey"]}
            keys = set(previous) | set(weights)
            gross_traded = sum(abs(weights.get(k, 0.0) - previous.get(k, 0.0)) for k in keys)
            cost = gross_traded * COST_PER_TRADED_NOTIONAL
            gross_return = float(holdings["fwd5Return"].mean())
            rows.append(
                {
                    "strategy": strategy,
                    "tradeDate": pd.Timestamp(trade_date),
                    "count": len(holdings),
                    "grossReturn": gross_return,
                    "grossTradedNotional": gross_traded,
                    "oneWayTurnover": gross_traded / 2.0 if previous else gross_traded,
                    "cost": cost,
                    "netReturn": gross_return - cost,
                }
            )
            previous = weights
    return pd.DataFrame(rows)


def add_benchmarks(periods: pd.DataFrame, scores: pd.DataFrame, con: duckdb.DuckDBPyConnection, snapshot_dir: Path) -> pd.DataFrame:
    benchmark_rows: list[dict] = []
    usable = scores[scores["factorCount"] >= MIN_FACTOR_COUNT]
    for trade_date, cross in usable.groupby("tradeDate"):
        benchmark_rows.append(
            {
                "strategy": "合格股票等权",
                "tradeDate": trade_date,
                "count": len(cross),
                "grossReturn": float(cross["fwd5Return"].mean()),
                "grossTradedNotional": 0.0,
                "oneWayTurnover": 0.0,
                "cost": 0.0,
                "netReturn": float(cross["fwd5Return"].mean()),
            }
        )

    index_path = qpath(snapshot_dir / "index_bars" / "data.parquet")
    signal_dates = sorted(pd.to_datetime(periods["tradeDate"].unique()))
    if signal_dates:
        start = signal_dates[0].strftime("%Y-%m-%d")
        end = signal_dates[-1].strftime("%Y-%m-%d")
        idx = con.execute(
            f"""
            SELECT indexCode,indexName,tradeDate,close,
              product(CASE WHEN close > 0 AND lagClose > 0 THEN close/lagClose ELSE 1 END)
                OVER (PARTITION BY indexCode ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND {REBALANCE_SESSIONS} FOLLOWING) - 1 AS fwd5
            FROM (
              SELECT *, lag(close) OVER (PARTITION BY indexCode ORDER BY tradeDate) AS lagClose
              FROM read_parquet('{index_path}')
              WHERE indexCode IN ('000300','000905')
            )
            WHERE tradeDate BETWEEN DATE '{start}' AND DATE '{end}'
            """
        ).fetchdf()
        idx["tradeDate"] = pd.to_datetime(idx["tradeDate"])
        signal_set = set(signal_dates)
        idx = idx[idx["tradeDate"].isin(signal_set)]
        for row in idx.itertuples():
            if pd.isna(row.fwd5):
                continue
            benchmark_rows.append(
                {
                    "strategy": row.indexName,
                    "tradeDate": row.tradeDate,
                    "count": 1,
                    "grossReturn": row.fwd5,
                    "grossTradedNotional": 0.0,
                    "oneWayTurnover": 0.0,
                    "cost": 0.0,
                    "netReturn": row.fwd5,
                }
            )
    return pd.concat([periods, pd.DataFrame(benchmark_rows)], ignore_index=True)


def metrics_for_returns(name: str, frame: pd.DataFrame, return_col: str = "netReturn") -> dict:
    data = frame.sort_values("tradeDate").dropna(subset=[return_col])
    returns = data[return_col].astype(float)
    n = len(returns)
    if n == 0:
        return {"strategy": name}
    years = n * REBALANCE_SESSIONS / 252.0
    equity = (1.0 + returns).cumprod()
    total = float(equity.iloc[-1] - 1.0)
    cagr = float(equity.iloc[-1] ** (1.0 / years) - 1.0) if years > 0 and equity.iloc[-1] > 0 else np.nan
    vol = float(returns.std(ddof=1) * math.sqrt(252.0 / REBALANCE_SESSIONS))
    sharpe = float(returns.mean() / returns.std(ddof=1) * math.sqrt(252.0 / REBALANCE_SESSIONS)) if returns.std(ddof=1) > 0 else np.nan
    drawdown = equity / equity.cummax() - 1.0
    max_dd = float(drawdown.min())
    calmar = cagr / abs(max_dd) if max_dd < 0 else np.nan
    return {
        "strategy": name,
        "periods": n,
        "start": data["tradeDate"].min().date().isoformat(),
        "end": data["tradeDate"].max().date().isoformat(),
        "totalReturn": total,
        "cagr": cagr,
        "annualVol": vol,
        "sharpe": sharpe,
        "maxDrawdown": max_dd,
        "calmar": calmar,
        "winRate": float((returns > 0).mean()),
        "avgPeriodReturn": float(returns.mean()),
        "avgOneWayTurnover": float(data["oneWayTurnover"].mean()),
        "totalCost": float(data["cost"].sum()),
    }


def compute_metrics(periods: pd.DataFrame) -> pd.DataFrame:
    metrics = [
        metrics_for_returns(strategy, frame)
        for strategy, frame in periods.groupby("strategy")
    ]
    result = pd.DataFrame(metrics).sort_values("sharpe", ascending=False)
    result.to_csv(METRICS_PATH, index=False, encoding="utf-8-sig")
    periods.to_csv(PERIOD_PATH, index=False, encoding="utf-8-sig")
    return result


def equity_figure(periods: pd.DataFrame, strategies: Iterable[str]) -> str:
    fig = go.Figure()
    for strategy in strategies:
        frame = periods[periods["strategy"] == strategy].sort_values("tradeDate")
        if frame.empty:
            continue
        equity = (1.0 + frame["netReturn"]).cumprod()
        fig.add_trace(go.Scatter(x=frame["tradeDate"], y=equity, mode="lines", name=strategy))
    fig.update_layout(
        title="净值曲线（5交易日调仓，组合已计成本）",
        xaxis_title="信号日期",
        yaxis_title="累计净值",
        template="plotly_white",
        height=520,
        legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0),
        margin=dict(l=55, r=25, t=95, b=50),
    )
    return pio.to_html(fig, include_plotlyjs="inline", full_html=False, config={"displaylogo": False})


def layer_figure(scores: pd.DataFrame) -> tuple[str, pd.DataFrame]:
    rows = []
    for trade_date, cross in scores[scores["factorCount"] >= MIN_FACTOR_COUNT].groupby("tradeDate"):
        usable = cross.dropna(subset=["score", "fwd5Return"]).copy()
        if len(usable) < 100:
            continue
        usable["layer"] = pd.qcut(usable["score"].rank(method="first"), 5, labels=False) + 1
        for layer, group in usable.groupby("layer"):
            rows.append({"tradeDate": trade_date, "layer": int(layer), "return": group["fwd5Return"].mean()})
    layers = pd.DataFrame(rows)
    summary = layers.groupby("layer")["return"].agg(["mean", "std", "count"]).reset_index()
    summary["annualized"] = (1 + summary["mean"]) ** (252 / REBALANCE_SESSIONS) - 1
    fig = go.Figure(go.Bar(
        x=[f"Q{layer}" for layer in summary["layer"]],
        y=summary["annualized"],
        marker_color=["#b94a48", "#d9825b", "#d5b25f", "#74a57f", "#2f7d5b"],
        text=[f"{v:.1%}" for v in summary["annualized"]],
        textposition="outside",
    ))
    fig.update_layout(
        title="13因子得分五分层：年化几何外推（Q5为高分）",
        yaxis_tickformat=".0%",
        template="plotly_white",
        height=410,
        margin=dict(l=55, r=25, t=75, b=45),
    )
    return pio.to_html(fig, include_plotlyjs=False, full_html=False, config={"displaylogo": False}), summary


def ic_figure(factor_ic: pd.DataFrame) -> tuple[str, pd.DataFrame]:
    summary = (
        factor_ic.groupby(["factor", "label", "category"])
        .agg(meanIC=("ic", "mean"), icStd=("ic", "std"), positiveRate=("ic", lambda x: (x > 0).mean()),
             observations=("ic", "count"), meanCoverage=("coverage", "mean"), meanUniverse=("universe", "mean"))
        .reset_index()
    )
    summary["icir"] = summary["meanIC"] / summary["icStd"]
    summary = summary.sort_values("meanIC")
    colors = ["#2f7d5b" if value >= 0 else "#b94a48" for value in summary["meanIC"]]
    fig = go.Figure(go.Bar(
        x=summary["meanIC"], y=summary["label"], orientation="h",
        marker_color=colors,
        text=[f"{v:.3f}" for v in summary["meanIC"]],
        textposition="outside",
    ))
    fig.update_layout(
        title="单因子平均 Rank IC（中性化后，预测未来5个交易日）",
        xaxis_title="平均 Rank IC",
        template="plotly_white",
        height=540,
        margin=dict(l=145, r=45, t=75, b=50),
    )
    return pio.to_html(fig, include_plotlyjs=False, full_html=False, config={"displaylogo": False}), summary


def cost_sensitivity(periods: pd.DataFrame) -> pd.DataFrame:
    base = periods[periods["strategy"] == "13因子-中性化"].copy()
    rows = []
    for bp in [0, 5, 15, 30]:
        base["sensitivityReturn"] = base["grossReturn"] - base["grossTradedNotional"] * bp / 10000
        metric = metrics_for_returns(f"{bp}bp", base, "sensitivityReturn")
        rows.append({"单边成交名义成本": f"{bp} bp", "CAGR": metric["cagr"], "Sharpe": metric["sharpe"], "最大回撤": metric["maxDrawdown"]})
    return pd.DataFrame(rows)


def pct(value: float) -> str:
    return "—" if pd.isna(value) else f"{value:.2%}"


def num(value: float, digits: int = 2) -> str:
    return "—" if pd.isna(value) else f"{value:.{digits}f}"


def df_html(df: pd.DataFrame, formatters: dict[str, callable] | None = None) -> str:
    shown = df.copy()
    for column, formatter in (formatters or {}).items():
        if column in shown:
            shown[column] = shown[column].map(formatter)
    return shown.to_html(index=False, border=0, classes="data-table", escape=False)


def build_report(
    snapshot_id: str,
    manifest: dict,
    scores: pd.DataFrame,
    periods: pd.DataFrame,
    metrics: pd.DataFrame,
    factor_ic: pd.DataFrame,
) -> dict:
    key_strategies = [
        "13因子-中性化", "13因子-未中性化", "13因子-严格完整",
        "13因子-反向Bottom100", "随机100", "合格股票等权", "沪深300", "中证500",
    ]
    equity_html = equity_figure(periods, key_strategies)
    layer_html, layer_summary = layer_figure(scores)
    ic_html, ic_summary = ic_figure(factor_ic)
    cost_df = cost_sensitivity(periods)

    metric_view = metrics[metrics["strategy"].isin(key_strategies)].copy()
    metric_view = metric_view[[
        "strategy", "periods", "cagr", "annualVol", "sharpe", "maxDrawdown",
        "calmar", "winRate", "avgOneWayTurnover", "totalCost",
    ]]
    metric_view.columns = ["策略", "期数", "CAGR", "年化波动", "Sharpe", "最大回撤", "Calmar", "胜率", "平均单边换手", "累计成本拖累"]

    main = metrics.set_index("strategy").loc["13因子-中性化"]
    universe = metrics.set_index("strategy").loc["合格股票等权"]
    bottom = metrics.set_index("strategy").loc["13因子-反向Bottom100"]
    q1 = float(layer_summary.loc[layer_summary["layer"] == 1, "mean"].iloc[0])
    q5 = float(layer_summary.loc[layer_summary["layer"] == 5, "mean"].iloc[0])
    spread_ann = (1 + (q5 - q1)) ** (252 / REBALANCE_SESSIONS) - 1
    mean_score_ic = scores.groupby("tradeDate").apply(
        lambda x: spearman(x["score"], x["fwd5Return"]), include_groups=False
    ).mean()

    supports = int((ic_summary["meanIC"] > 0).sum())
    material_supports = int((ic_summary["meanIC"] > 0.01).sum())
    total_factors = len(ic_summary)
    excess_cagr = main["cagr"] - universe["cagr"]
    if mean_score_ic > 0 and q5 > q1 and main["cagr"] > universe["cagr"] and main["sharpe"] > universe["sharpe"]:
        verdict = "整体支持"
    elif mean_score_ic > 0 and q5 > q1:
        verdict = "部分证实：排序有效，组合未胜基准"
    else:
        verdict = "证据不足 / 倾向证伪"

    category_metrics = metrics[metrics["strategy"].str.startswith("仅")].copy()
    category_metrics = category_metrics[[
        "strategy", "cagr", "sharpe", "maxDrawdown", "avgOneWayTurnover"
    ]].sort_values("sharpe", ascending=False)
    best_category = category_metrics.iloc[0]
    verdict_detail = (
        f"综合得分平均 Rank IC 为 {mean_score_ic:.3f}，Q5−Q1 的5日平均收益差为 {(q5-q1):.2%}；"
        f"计入15bp/成交名义本金成本后，Top100 CAGR 为 {main['cagr']:.2%}，"
        f"相对合格股票等权基准的 CAGR 差为 {excess_cagr:.2%}。"
        f"表现最好的单类别是“{best_category['strategy']}”（CAGR {best_category['cagr']:.2%}），"
        "说明有效性集中在少数子信号，不能据此宣称“13个等权更好”。"
    )

    aligned = (
        periods[periods["strategy"].isin(["13因子-中性化", "合格股票等权"])]
        .pivot(index="tradeDate", columns="strategy", values="netReturn")
        .dropna()
    )
    excess = aligned["13因子-中性化"] - aligned["合格股票等权"]
    excess_t = float(excess.mean() / excess.std(ddof=1) * math.sqrt(len(excess)))
    excess_ann = float((1 + excess.mean()) ** (252 / REBALANCE_SESSIONS) - 1)

    regimes = [
        ("2015–2018", "2015-01-01", "2018-12-31"),
        ("2019–2022", "2019-01-01", "2022-12-31"),
        ("2023–2026", "2023-01-01", "2026-12-31"),
    ]
    regime_rows = []
    for label, start, end in regimes:
        for strategy in ["13因子-中性化", "合格股票等权"]:
            frame = periods[
                (periods["strategy"] == strategy)
                & (periods["tradeDate"] >= pd.Timestamp(start))
                & (periods["tradeDate"] <= pd.Timestamp(end))
            ]
            metric = metrics_for_returns(strategy, frame)
            regime_rows.append({
                "阶段": label, "策略": strategy, "CAGR": metric["cagr"],
                "Sharpe": metric["sharpe"], "最大回撤": metric["maxDrawdown"],
            })
    regime_df = pd.DataFrame(regime_rows)

    coverage = pd.DataFrame({
        "因子": [f.label for f in FACTORS],
        "类别": [f.category for f in FACTORS],
        "方向": ["高值优先" if f.direction > 0 else "低值优先" for f in FACTORS],
        "中性化": ["行业+市值" if f.cap_neutral else "仅行业（避免自我消除）" for f in FACTORS],
        "平均覆盖率": [
            float(ic_summary.set_index("factor").loc[f.key, "meanCoverage"] / ic_summary.set_index("factor").loc[f.key, "meanUniverse"])
            for f in FACTORS
        ],
    })

    latest_holdings = pd.read_csv(SELECTIONS_PATH)
    latest_holdings = latest_holdings[latest_holdings["strategy"] == "13因子-中性化"]
    latest_date = latest_holdings["tradeDate"].max()
    latest_holdings = latest_holdings[latest_holdings["tradeDate"] == latest_date].nlargest(20, "selectionScore")
    latest_holdings = latest_holdings[["symbol", "name", "industry", "selectionScore"]]
    latest_holdings.columns = ["代码", "名称", "行业", "综合分"]

    factor_table = ic_summary[["label", "category", "meanIC", "icir", "positiveRate", "observations"]].copy()
    factor_table.columns = ["因子", "类别", "平均IC", "ICIR(非年化)", "IC为正比例", "时点数"]
    factor_table = factor_table.sort_values("平均IC", ascending=False)

    methodology_rows = [
        ("样本", f"A股沪深两市，{START_DATE}起；排除北交所、科创板、ST、价格≤1.2元、上市<365天。"),
        ("调仓", f"每{REBALANCE_SESSIONS}个交易日；信号在当日收盘后形成，收益从下一交易日开始累计；Top {PORTFOLIO_SIZE}等权。"),
        ("财务时点", "仅连接 announcementDate≤signalDate 的报告；各字段对已披露的最近非空值做向前填充。"),
        ("预处理", "每个交易日横截面1%/99%缩尾、Z标准化；非规模因子按行业去均值并对市值残差化；规模因子仅行业去均值。"),
        ("缺失值", f"至少有{MIN_FACTOR_COUNT}/13个因子才入池；剩余缺失因子按中性分0计；另报告13/13严格完整组合。"),
        ("企业价值代理", "总市值 + 短期借款 + 长期借款 + 应付债券 − 现金及等价物。"),
        ("收益", "使用 close/previousClose 的日收益连乘，减弱除权除息机械跳空；停牌日没有显式收益，退市末端损失可能低估。"),
        ("成本", "每单位买入或卖出成交名义本金15bp；组合成本=Σ|新权重−旧权重|×15bp。"),
        ("基准", "合格股票全体等权（主基准），并展示沪深300、中证500；指数数据不含中证800，未伪造替代。"),
    ]

    template = Template(REPORT_TEMPLATE)
    html = template.render(
        generated_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        snapshot_id=snapshot_id,
        manifest=manifest,
        verdict=verdict,
        verdict_detail=verdict_detail,
        main_cagr=pct(main["cagr"]),
        main_sharpe=num(main["sharpe"]),
        main_mdd=pct(main["maxDrawdown"]),
        score_ic=num(mean_score_ic, 3),
        spread=pct(q5 - q1),
        supports=supports,
        material_supports=material_supports,
        total_factors=total_factors,
        excess_t=num(excess_t),
        excess_ann=pct(excess_ann),
        metric_table=df_html(metric_view, {
            "CAGR": pct, "年化波动": pct, "Sharpe": num, "最大回撤": pct,
            "Calmar": num, "胜率": pct, "平均单边换手": pct, "累计成本拖累": pct,
        }),
        coverage_table=df_html(coverage, {"平均覆盖率": pct}),
        factor_table=df_html(factor_table, {
            "平均IC": lambda x: num(x, 3), "ICIR(非年化)": num, "IC为正比例": pct,
        }),
        category_table=df_html(
            category_metrics.rename(columns={
                "strategy": "类别策略", "cagr": "CAGR", "sharpe": "Sharpe",
                "maxDrawdown": "最大回撤", "avgOneWayTurnover": "平均单边换手",
            }),
            {"CAGR": pct, "Sharpe": num, "最大回撤": pct, "平均单边换手": pct},
        ),
        regime_table=df_html(regime_df, {"CAGR": pct, "Sharpe": num, "最大回撤": pct}),
        cost_table=df_html(cost_df, {"CAGR": pct, "Sharpe": num, "最大回撤": pct}),
        holdings_table=df_html(latest_holdings, {"综合分": lambda x: num(x, 3)}),
        latest_date=latest_date,
        methodology_rows=methodology_rows,
        equity_html=equity_html,
        layer_html=layer_html,
        ic_html=ic_html,
        limitations=[
            "历史ST状态由日线快照中的当日名称代理；若名称字段是后补的当前名称，可能存在状态错配。",
            "上市日以该证券在本地日线库的首个交易日代理；数据从2000年开始，2000年前上市公司会被视为最晚于2000年上市，但不影响365日过滤。",
            "退市股票在最后行情之后缺少可成交价格，回测未强制记为−100%；这通常会高估小盘/困境组合表现。",
            "换手率三个因子高度同源，等权并不等于独立信息等权；类别结果用于识别这种重复计票。",
            "自由现金流和周转率按最近披露非空值携带，不同公司在同一信号日可能对应不同报告期。",
            "使用全市场历史股票降低了显式幸存者偏差，但本地快照本身是否完整保存已退市证券仍取决于数据源。",
            "本结果是历史统计检验，不构成投资建议；参数、费用、涨跌停和可成交性变化都可能改变实盘结果。",
        ],
    )
    REPORT_PATH.write_text(html, encoding="utf-8")
    return {
        "verdict": verdict,
        "verdictDetail": verdict_detail,
        "meanScoreRankIC": mean_score_ic,
        "q5MinusQ1Mean5d": q5 - q1,
        "q5MinusQ1AnnualizedApprox": spread_ann,
        "positiveIndividualFactors": supports,
        "materialPositiveFactors": material_supports,
        "factorCount": total_factors,
        "excessReturnApproxAnnualized": excess_ann,
        "excessReturnTStat": excess_t,
        "top100Cagr": float(main["cagr"]),
        "top100Sharpe": float(main["sharpe"]),
        "top100MaxDrawdown": float(main["maxDrawdown"]),
        "universeCagr": float(universe["cagr"]),
        "bottom100Cagr": float(bottom["cagr"]),
    }


REPORT_TEMPLATE = r"""
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>“13因子”策略：证明或证伪实验</title>
<style>
:root{--ink:#17202a;--muted:#68717a;--paper:#f7f3e9;--card:#fffdf7;--green:#256d4b;--red:#a23b3b;--gold:#c08a2d;--line:#ddd6c5}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;line-height:1.65}
.hero{background:linear-gradient(135deg,#132b24,#285b46);color:#fff;padding:54px 24px 48px}.wrap{max-width:1180px;margin:auto}.eyebrow{letter-spacing:.15em;color:#b9d9ca;font-size:13px}
h1{font-size:40px;margin:8px 0 10px;line-height:1.2}.sub{color:#d8e7df;max-width:850px}
.verdict{margin-top:28px;display:inline-flex;gap:14px;align-items:center;background:#fff;color:var(--ink);border-radius:14px;padding:14px 18px;box-shadow:0 12px 35px #06171155}
.verdict strong{font-size:22px;color:var(--green)}main{padding:28px 24px 60px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:-18px}
.kpi,.card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 6px 20px #26342c12}.kpi{padding:18px}.kpi .v{font-size:26px;font-weight:700;color:var(--green)}.kpi .l{font-size:13px;color:var(--muted)}
.card{padding:24px;margin-top:22px}.card h2{margin:0 0 14px;font-size:23px}.card h3{margin:24px 0 10px}.note{color:var(--muted);font-size:14px}.callout{border-left:5px solid var(--gold);background:#fff8df;padding:14px 17px;border-radius:6px;margin:14px 0}
.data-table{border-collapse:collapse;width:100%;font-size:14px}.data-table th,.data-table td{border-bottom:1px solid var(--line);padding:9px 8px;text-align:right;white-space:nowrap}.data-table th{background:#f0eadc}.data-table th:first-child,.data-table td:first-child{text-align:left}
.scroll{overflow-x:auto}.method{display:grid;grid-template-columns:145px 1fr;border-top:1px solid var(--line)}.method div{padding:10px 8px;border-bottom:1px solid var(--line)}.method .key{font-weight:700;color:#334a40}
ul{padding-left:21px}.footer{color:var(--muted);font-size:13px;margin-top:24px}.tag{display:inline-block;background:#e2efe8;color:#225f43;padding:2px 9px;border-radius:999px;font-size:12px;margin-right:6px}
@media(max-width:850px){.grid{grid-template-columns:repeat(2,1fr)}h1{font-size:31px}.method{grid-template-columns:1fr}.method .key{padding-bottom:0}}
@media(max-width:520px){.grid{grid-template-columns:1fr}.hero,main{padding-left:15px;padding-right:15px}}
</style>
</head>
<body>
<header class="hero"><div class="wrap">
  <div class="eyebrow">POINT-IN-TIME · A股全市场 · 可复现实验</div>
  <h1>“13因子”策略：证明或证伪</h1>
  <div class="sub">把社交媒体图片中的口号转成可执行规则，并用公告日约束、横截面中性化、交易成本和多组反事实进行检验。</div>
  <div class="verdict"><span>实验结论</span><strong>{{ verdict }}</strong></div>
</div></header>
<main><div class="wrap">
  <div class="grid">
    <div class="kpi"><div class="v">{{ main_cagr }}</div><div class="l">Top100 成本后 CAGR</div></div>
    <div class="kpi"><div class="v">{{ main_sharpe }}</div><div class="l">成本后 Sharpe</div></div>
    <div class="kpi"><div class="v">{{ main_mdd }}</div><div class="l">最大回撤</div></div>
    <div class="kpi"><div class="v">{{ score_ic }}</div><div class="l">综合分平均 Rank IC</div></div>
  </div>

  <section class="card">
    <h2>一句话结论</h2>
    <p>{{ verdict_detail }}</p>
    <div class="callout">“因子越多 ≠ 胜率越高”是正确提醒。本实验中 {{ supports }}/{{ total_factors }} 个单因子方向得到正平均IC，但只有 {{ material_supports }}/{{ total_factors }} 个超过0.01；真正需要看的是组合相对基准、分层单调性、成本敏感度和反向组合，而不是只看一条净值曲线。</div>
    <span class="tag">快照 {{ snapshot_id }}</span><span class="tag">生成于 {{ generated_at }}</span>
  </section>

  <section class="card"><h2>核心净值对比</h2>{{ equity_html | safe }}</section>
  <section class="card"><h2>策略指标</h2><div class="scroll">{{ metric_table | safe }}</div>
    <p class="note">指数和“合格股票等权”未扣策略换仓成本；Top100、反向、类别与随机组合均按同一成本模型扣减。</p>
    <div class="callout">Top100相对合格股票等权的平均超额收益，按5日频率几何外推约为 <strong>{{ excess_ann }}</strong>，简单配对 t 值为 <strong>{{ excess_t }}</strong>。这不是显著的正Alpha证据。</div>
  </section>

  <section class="card"><h2>是否存在横截面排序能力？</h2>
    {{ layer_html | safe }}
    <p>高分层Q5与低分层Q1的平均5日收益差为 <strong>{{ spread }}</strong>。分层比单独的Top100曲线更能回答“分数是否真的有排序信息”。</p>
    {{ ic_html | safe }}
    <div class="scroll">{{ factor_table | safe }}</div>
    <h3>哪个类别真正贡献了结果？</h3>
    <div class="scroll">{{ category_table | safe }}</div>
    <p class="note">类别组合也取100只并扣同样成本。若一个类别显著强于13因子总分，说明等权加入其余信号是在稀释，而不是增强。</p>
    <h3>分阶段稳健性</h3>
    <div class="scroll">{{ regime_table | safe }}</div>
  </section>

  <section class="card"><h2>交易成本压力测试</h2><div class="scroll">{{ cost_table | safe }}</div>
    <p class="note">bp成本乘以每次 Σ|新权重−旧权重|。例如完全换仓时，买卖两边合计成交名义本金约为组合本金的2倍。</p>
  </section>

  <section class="card"><h2>13个因子的可执行定义</h2><div class="scroll">{{ coverage_table | safe }}</div>
    <div class="callout"><strong>图片中的矛盾：</strong>若把“对数总市值”因子本身再对市值做残差化，它会被机械消除。因此三个规模因子仅做行业中性化；其余十个因子做行业+市值中性化。该选择不是隐藏调参，而是避免数学上的自我抵消。</div>
  </section>

  <section class="card"><h2>实验设计</h2>
    <div class="method">{% for key,value in methodology_rows %}<div class="key">{{ key }}</div><div>{{ value }}</div>{% endfor %}</div>
    <h3>五层过滤如何落地</h3>
    <p>非ST（当日名称代理） → 收盘价&gt;1.2元 → 本地首个交易日起满365天 → 排除北交所 → 排除科创板（688/689开头）。筛选后再做因子覆盖门槛和Top100。</p>
  </section>

  <section class="card"><h2>最近一期高分样本（仅供复核，不是荐股）</h2>
    <p class="note">信号日期：{{ latest_date }}；这里只展示Top20，完整100只在 portfolio_selections_market_aligned.csv。</p>
    <div class="scroll">{{ holdings_table | safe }}</div>
  </section>

  <section class="card"><h2>数据与审计</h2>
    <p>研究快照覆盖 {{ manifest.minDate }} 至 {{ manifest.maxDate }}，共 {{ "{:,}".format(manifest.rowCount) }} 条日线、{{ manifest.instrumentCount }} 个证券标识。财务报告、行业与指数均来自同一已验证快照。</p>
    <h3>仍然不能忽略的限制</h3>
    <ul>{% for item in limitations %}<li>{{ item }}</li>{% endfor %}</ul>
    <p class="note">“有条件支持”只表示在当前定义与样本内，多项诊断方向一致；不等于因果证明，也不保证样本外或实盘延续。</p>
  </section>
  <div class="footer">所有脚本、依赖、缓存、明细CSV/Parquet、DuckDB临时库、日志和本HTML均保存在本目录，便于完整复现。</div>
</div></main>
</body></html>
"""


def main() -> None:
    LOG_PATH.write_text("", encoding="utf-8")
    started = time.time()
    snapshot_id, snapshot_dir, manifest = load_snapshot()
    log(f"使用研究快照: {snapshot_id}")
    con = duckdb.connect(str(DB_PATH))
    con.execute("SET threads=4")
    con.execute("SET memory_limit='6GB'")
    con.execute(f"SET temp_directory='{qpath(EXPERIMENT_DIR / 'duckdb_temp')}'")

    build_panel(con, snapshot_dir)
    scores, selections, factor_ic = process_scores(con)
    periods = portfolio_period_returns(selections)
    periods = add_benchmarks(periods, scores, con, snapshot_dir)
    metrics = compute_metrics(periods)
    conclusion = build_report(snapshot_id, manifest, scores, periods, metrics, factor_ic)

    metadata = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "elapsedSeconds": round(time.time() - started, 2),
        "snapshotId": snapshot_id,
        "snapshotCreatedAt": manifest["createdAt"],
        "parameters": {
            "startDate": START_DATE,
            "rebalanceSessions": REBALANCE_SESSIONS,
            "portfolioSize": PORTFOLIO_SIZE,
            "minFactorCount": MIN_FACTOR_COUNT,
            "costPerTradedNotional": COST_PER_TRADED_NOTIONAL,
            "randomSeed": RANDOM_SEED,
        },
        "environment": {
            "python": sys.version,
            "platform": platform.platform(),
            "duckdb": duckdb.__version__,
            "pandas": pd.__version__,
            "numpy": np.__version__,
        },
        "artifacts": [path.name for path in [
            PANEL_PATH, SCORES_PATH, SELECTIONS_PATH, PERIOD_PATH,
            FACTOR_IC_PATH, METRICS_PATH, REPORT_PATH, LOG_PATH, DB_PATH,
        ]],
        "conclusion": conclusion,
    }
    METADATA_PATH.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"实验完成: {REPORT_PATH}")
    log(f"总耗时: {time.time() - started:.1f} 秒")
    con.close()


if __name__ == "__main__":
    main()
