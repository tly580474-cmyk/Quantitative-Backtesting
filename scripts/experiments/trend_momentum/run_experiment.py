#!/usr/bin/env python3
"""Validate an A-share trend/momentum stock-selection rule without look-ahead.

All generated artifacts stay under tmp_output/trend_momentum_experiment.  The
single self-contained conclusion report is also copied to output/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import shutil
import sys
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / "tmp_output" / "thirteen_factor_experiment" / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import plotly.graph_objects as go  # noqa: E402
from plotly.subplots import make_subplots  # noqa: E402


@dataclass(frozen=True)
class Config:
    start_date: str = "2010-01-04"
    end_date: str = "2026-07-30"
    rebalance_days: int = 20
    holdings: int = 20
    min_price: float = 1.2
    min_average_amount20: float = 20_000_000
    min_listed_calendar_days: int = 365
    volume_ratio_threshold: float = 1.10
    buy_cost: float = 0.0008
    sell_cost: float = 0.0013


VARIANTS = {
    "trend": "仅均线趋势",
    "trend_momentum": "趋势 + 相对动量",
    "trend_momentum_volume": "趋势 + 相对动量 + 量价确认",
    "full_stop": "完整规则（含 MA60 止损）",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=Config.start_date)
    parser.add_argument("--end", default=Config.end_date)
    parser.add_argument("--force", action="store_true", help="rebuild DuckDB cache")
    return parser.parse_args()


def paths() -> dict[str, Path]:
    tmp = ROOT / "tmp_output" / "trend_momentum_experiment"
    return {
        "tmp": tmp,
        "db": tmp / "trend_momentum.duckdb",
        "report": tmp / "trend_momentum_validation_report.html",
        "conclusion": ROOT / "output" / "trend_momentum_validation_report.html",
        "metrics": tmp / "metrics.csv",
        "periods": tmp / "period_returns.csv",
        "trades": tmp / "trade_details.csv",
        "selections": tmp / "selection_details.csv",
        "metadata": tmp / "run_metadata.json",
    }


def current_snapshot() -> tuple[str, Path]:
    current = json.loads(
        (ROOT / "server" / "data" / "research-snapshots" / "current.json").read_text(
            encoding="utf-8"
        )
    )
    snapshot_id = current["snapshotId"]
    snapshot = ROOT / "server" / "data" / "research-snapshots" / snapshot_id
    if not snapshot.exists():
        raise FileNotFoundError(f"snapshot missing: {snapshot}")
    return snapshot_id, snapshot


def parquet_glob(snapshot: Path, dataset: str) -> str:
    return str(snapshot / dataset / "**" / "*.parquet").replace("\\", "/")


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def build_database(
    con: duckdb.DuckDBPyConnection,
    snapshot: Path,
    snapshot_id: str,
    config: Config,
    force: bool,
) -> None:
    con.execute("SET threads=6")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET memory_limit='6GB'")
    cached = False
    try:
        cached_id = con.execute(
            "SELECT value FROM experiment_meta WHERE key='snapshot_id'"
        ).fetchone()
        cached = bool(cached_id and cached_id[0] == snapshot_id)
    except duckdb.Error:
        pass
    if cached and not force:
        return

    for table in [
        "experiment_meta",
        "trades",
        "selections",
        "features",
        "feature_stage",
        "raw_return_stage",
        "adjusted_daily",
        "first_dates",
        "calendar",
        "index_features",
    ]:
        con.execute(f"DROP TABLE IF EXISTS {table}")

    bars = parquet_glob(snapshot, "bars")
    factors = parquet_glob(snapshot, "adjustment_factors")
    index_bars = parquet_glob(snapshot, "index_bars")
    warmup = (
        pd.Timestamp(config.start_date) - pd.Timedelta(days=550)
    ).strftime("%Y-%m-%d")

    con.execute(
        f"""
        CREATE TABLE experiment_meta(key VARCHAR PRIMARY KEY, value VARCHAR);
        INSERT INTO experiment_meta VALUES
          ('snapshot_id', {quote(snapshot_id)}),
          ('config', {quote(json.dumps(asdict(config), ensure_ascii=False, sort_keys=True))});

        CREATE TABLE first_dates AS
        SELECT instrumentKey, MIN(tradeDate) AS firstTradeDate
        FROM read_parquet({quote(bars)}, hive_partitioning=true)
        WHERE market IN ('SH', 'SZ')
        GROUP BY instrumentKey;

        CREATE TABLE raw_return_stage AS
        SELECT b.instrumentKey, b.market, b.symbol, b.name, b.industry,
               b.tradeDate,
               b.open AS rawOpen, b.high AS rawHigh, b.low AS rawLow,
               b.close AS rawClose, b.previousClose, b.volume, b.amount,
               f.firstTradeDate, a.factorVersion
        FROM read_parquet({quote(bars)}, hive_partitioning=true) b
        JOIN first_dates f USING (instrumentKey)
        ASOF LEFT JOIN read_parquet({quote(factors)}, hive_partitioning=true) a
          ON b.instrumentKey = a.instrumentKey AND b.tradeDate >= a.effectiveDate
        WHERE b.tradeDate BETWEEN DATE {quote(warmup)} AND DATE {quote(config.end_date)}
          AND (
            (b.market='SH' AND regexp_matches(b.symbol, '^(600|601|603|605)[0-9]{{3}}$'))
            OR
            (b.market='SZ' AND regexp_matches(b.symbol, '^(000|001|002|003|300|301)[0-9]{{3}}$'))
          )
          AND NOT regexp_matches(upper(COALESCE(b.name, '')), '(^|\\\\*)ST');

        CREATE TABLE adjusted_daily AS
        WITH chained AS (
          SELECT *,
            EXP(SUM(LN(rawClose / previousClose)) OVER (
              PARTITION BY instrumentKey ORDER BY tradeDate
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )) AS pxClose
          FROM raw_return_stage
          WHERE rawClose > 0 AND previousClose > 0
        )
        SELECT *,
          pxClose * rawOpen / rawClose AS pxOpen,
          pxClose * rawHigh / rawClose AS pxHigh,
          pxClose * rawLow / rawClose AS pxLow
        FROM chained;

        CREATE TABLE feature_stage AS
        SELECT *,
          LAG(pxClose, 1) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS previousAdjustedClose,
          LAG(pxClose, 60) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS closeLag60,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS ma120,
          AVG(amount) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS averageAmount20,
          COUNT(*) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS observations120
        FROM adjusted_daily;

        CREATE TABLE features AS
        SELECT *,
          LAG(ma20, 5) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma20Lag5,
          LAG(ma60, 10) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma60Lag10,
          LAG(ma120, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma120Lag20,
          AVG(CASE WHEN pxClose > previousAdjustedClose THEN volume END)
            OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
            / NULLIF(AVG(CASE WHEN pxClose <= previousAdjustedClose THEN volume END)
            OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW), 0)
            AS upDownVolumeRatio20,
          SUM(
            CASE WHEN pxHigh > pxLow
              THEN ((2 * pxClose - pxHigh - pxLow) / (pxHigh - pxLow)) * volume
              ELSE 0 END
          ) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW)
          / NULLIF(SUM(volume) OVER (
              PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
            ), 0) AS cmf20
        FROM feature_stage;

        CREATE TABLE calendar AS
        WITH d AS (
          SELECT tradeDate, ROW_NUMBER() OVER (ORDER BY tradeDate) AS rn
          FROM (
            SELECT DISTINCT tradeDate FROM features
            WHERE tradeDate BETWEEN DATE {quote(config.start_date)} AND DATE {quote(config.end_date)}
          )
        ), signals AS (
          SELECT tradeDate AS signalDate,
                 LEAD(tradeDate, 1) OVER (ORDER BY tradeDate) AS entryDate,
                 rn
          FROM d
        ), rebalances AS (
          SELECT *, ROW_NUMBER() OVER (ORDER BY signalDate) AS periodNo
          FROM signals
          WHERE (rn - 1) % {config.rebalance_days} = 0
        )
        SELECT periodNo, signalDate, entryDate,
               LEAD(signalDate) OVER (ORDER BY signalDate) AS nextSignalDate,
               LEAD(entryDate) OVER (ORDER BY signalDate) AS plannedExitDate
        FROM rebalances
        QUALIFY plannedExitDate IS NOT NULL;

        CREATE TABLE index_features AS
        SELECT tradeDate, open, close,
               close / NULLIF(LAG(close, 60) OVER (ORDER BY tradeDate), 0) - 1 AS momentum60
        FROM read_parquet({quote(index_bars)}, hive_partitioning=true)
        WHERE indexCode='000300'
          AND tradeDate BETWEEN DATE {quote(warmup)} AND DATE {quote(config.end_date)};
        """
    )

    eligible = f"""
      f.observations120 >= 120
      AND date_diff('day', f.firstTradeDate, f.tradeDate) >= {config.min_listed_calendar_days}
      AND f.rawClose > {config.min_price}
      AND f.averageAmount20 >= {config.min_average_amount20}
      AND f.pxClose > f.ma20 AND f.ma20 > f.ma60 AND f.ma60 > f.ma120
      AND f.ma20 > f.ma20Lag5 AND f.ma60 > f.ma60Lag10 AND f.ma120 > f.ma120Lag20
    """
    con.execute(
        f"""
        CREATE TABLE selections AS
        WITH candidates AS (
          SELECT c.periodNo, c.signalDate, c.entryDate, c.nextSignalDate,
                 c.plannedExitDate, f.instrumentKey, f.market, f.symbol, f.name,
                 f.industry, f.factorVersion, f.pxClose, f.ma20, f.ma60, f.ma120,
                 f.averageAmount20, f.upDownVolumeRatio20, f.cmf20,
                 f.pxClose / NULLIF(f.closeLag60, 0) - 1 AS momentum60,
                 (f.pxClose / NULLIF(f.closeLag60, 0) - 1) - i.momentum60 AS relativeMomentum60,
                 f.pxClose / NULLIF(f.ma120, 0) - 1 AS trendStrength
          FROM calendar c
          JOIN features f ON f.tradeDate=c.signalDate
          JOIN index_features i ON i.tradeDate=c.signalDate
          WHERE {eligible}
        ), expanded AS (
          SELECT *, 'trend' AS variant, trendStrength AS score FROM candidates
          UNION ALL
          SELECT *, 'trend_momentum', relativeMomentum60 + 0.25 * trendStrength FROM candidates
            WHERE relativeMomentum60 > 0
          UNION ALL
          SELECT *, 'trend_momentum_volume', relativeMomentum60 + 0.25 * trendStrength FROM candidates
            WHERE relativeMomentum60 > 0
              AND upDownVolumeRatio20 > {config.volume_ratio_threshold} AND cmf20 > 0
          UNION ALL
          SELECT *, 'full_stop', relativeMomentum60 + 0.25 * trendStrength FROM candidates
            WHERE relativeMomentum60 > 0
              AND upDownVolumeRatio20 > {config.volume_ratio_threshold} AND cmf20 > 0
        )
        SELECT * EXCLUDE(selectionRank)
        FROM (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY variant, periodNo ORDER BY score DESC, instrumentKey
          ) AS selectionRank
          FROM expanded
        )
        WHERE selectionRank <= {config.holdings};

        CREATE TABLE trades AS
        WITH breaches AS (
          SELECT s.variant, s.periodNo, s.instrumentKey,
                 MIN(f.tradeDate) FILTER (
                   WHERE s.variant='full_stop' AND f.pxClose < f.ma60
                 ) AS breachDate
          FROM selections s
          LEFT JOIN features f
            ON f.instrumentKey=s.instrumentKey
           AND f.tradeDate > s.signalDate
           AND f.tradeDate <= s.nextSignalDate
          GROUP BY s.variant, s.periodNo, s.instrumentKey
        ), requested_exits AS (
          SELECT s.*,
            CASE WHEN b.breachDate IS NULL THEN s.plannedExitDate
                 ELSE (SELECT MIN(x.tradeDate) FROM index_features x WHERE x.tradeDate > b.breachDate)
            END AS requestedExitDate,
            b.breachDate,
            b.breachDate IS NOT NULL AS stopped
          FROM selections s
          JOIN breaches b USING (variant, periodNo, instrumentKey)
        ), exit_dates AS (
          SELECT r.*,
            (
              SELECT MIN(f.tradeDate) FROM features f
              WHERE f.instrumentKey=r.instrumentKey
                AND f.tradeDate >= r.requestedExitDate
            ) AS actualExitDate
          FROM requested_exits r
        )
        SELECT e.*, entry.pxOpen AS entryOpen, exit.pxOpen AS exitOpen,
               entry.pxOpen IS NOT NULL AND entry.pxOpen > 0 AS executed,
               CASE
                 WHEN entry.pxOpen IS NULL OR entry.pxOpen <= 0 THEN 0
                 WHEN exit.pxOpen IS NULL OR exit.pxOpen <= 0 THEN -1
                 ELSE exit.pxOpen / entry.pxOpen - 1
               END AS grossReturn
        FROM exit_dates e
        LEFT JOIN features entry
          ON entry.instrumentKey=e.instrumentKey AND entry.tradeDate=e.entryDate
        LEFT JOIN features exit
          ON exit.instrumentKey=e.instrumentKey AND exit.tradeDate=e.actualExitDate;
        """
    )


def period_results(
    trades: pd.DataFrame, index_prices: pd.DataFrame, config: Config
) -> pd.DataFrame:
    index_prices = index_prices.set_index("tradeDate")
    rows: list[dict] = []
    for variant, variant_df in trades.groupby("variant", sort=False):
        previous_survivors: set[int] = set()
        nav, nav_2x = 1.0, 1.0
        for period_no, group in variant_df.groupby("periodNo", sort=True):
            group = group.drop_duplicates("instrumentKey")
            executed = group["executed"].fillna(False).astype(bool)
            current = set(group.loc[executed, "instrumentKey"].astype(int))
            stopped = set(
                group.loc[executed & group["stopped"], "instrumentKey"].astype(int)
            )
            continuing = current & previous_survivors
            buy_turnover = (len(current - continuing) / len(current)) if current else 0.0
            sell_turnover = (
                len(previous_survivors - current) / len(previous_survivors)
                if previous_survivors
                else 0.0
            )
            stop_turnover = len(stopped) / len(current) if current else 0.0
            # Failed T+1 entries remain cash and therefore contribute zero return.
            gross = float(group["grossReturn"].mean())
            cost = (
                buy_turnover * config.buy_cost
                + sell_turnover * config.sell_cost
                + stop_turnover * config.sell_cost
            )
            net = gross - cost
            net_2x = gross - 2 * cost
            nav *= 1 + net
            nav_2x *= 1 + net_2x
            first = group.iloc[0]
            entry_date = pd.Timestamp(first["entryDate"])
            exit_date = pd.Timestamp(first["plannedExitDate"])
            try:
                bench = (
                    float(index_prices.loc[exit_date, "open"])
                    / float(index_prices.loc[entry_date, "open"])
                    - 1
                )
            except KeyError:
                bench = np.nan
            rows.append(
                {
                    "variant": variant,
                    "periodNo": int(period_no),
                    "signalDate": first["signalDate"],
                    "entryDate": entry_date,
                    "exitDate": exit_date,
                    "holdings": len(current),
                    "stops": len(stopped),
                    "grossReturn": gross,
                    "cost": cost,
                    "netReturn": net,
                    "netReturn2xCost": net_2x,
                    "benchmarkReturn": bench,
                    "buyTurnover": buy_turnover,
                    "sellTurnover": sell_turnover + stop_turnover,
                    "nav": nav,
                    "nav2xCost": nav_2x,
                }
            )
            previous_survivors = current - stopped
    result = pd.DataFrame(rows).sort_values(["variant", "entryDate"])
    result["benchmarkNav"] = result.groupby("variant")["benchmarkReturn"].transform(
        lambda x: (1 + x.fillna(0)).cumprod()
    )
    return result


def max_drawdown(returns: pd.Series) -> float:
    nav = (1 + returns.fillna(0)).cumprod()
    return float((nav / nav.cummax() - 1).min())


def metrics(periods: pd.DataFrame, config: Config) -> pd.DataFrame:
    annual_periods = 252 / config.rebalance_days
    rows = []
    for variant, group in periods.groupby("variant", sort=False):
        r = group["netReturn"].dropna()
        b = group["benchmarkReturn"].dropna()
        excess = r.loc[b.index] - b
        years = len(r) / annual_periods
        ann = (float(np.prod(1 + r)) ** (1 / years) - 1) if years else np.nan
        ann_b = (float(np.prod(1 + b)) ** (1 / years) - 1) if years else np.nan
        vol = float(r.std(ddof=1) * math.sqrt(annual_periods))
        tracking = float(excess.std(ddof=1) * math.sqrt(annual_periods))
        ann_2x = (
            float(np.prod(1 + group["netReturn2xCost"])) ** (1 / years) - 1
            if years
            else np.nan
        )
        rows.append(
            {
                "variant": variant,
                "name": VARIANTS[variant],
                "periods": len(group),
                "annualReturn": ann,
                "benchmarkAnnualReturn": ann_b,
                "annualExcess": ann - ann_b,
                "annualVolatility": vol,
                "sharpe": ann / vol if vol else np.nan,
                "informationRatio": (ann - ann_b) / tracking if tracking else np.nan,
                "maxDrawdown": max_drawdown(r),
                "winRate": float((r > 0).mean()),
                "annualReturn2xCost": ann_2x,
                "averageHoldings": float(group["holdings"].mean()),
                "annualOneWayTurnover": float(
                    (group["buyTurnover"] + group["sellTurnover"]).mean()
                    * annual_periods
                    / 2
                ),
                "stopCount": int(group["stops"].sum()),
            }
        )
    return pd.DataFrame(rows)


def stage_metrics(periods: pd.DataFrame, variant: str) -> pd.DataFrame:
    stages = [
        ("2010–2014", "2010-01-01", "2014-12-31"),
        ("2015–2019", "2015-01-01", "2019-12-31"),
        ("2020–2023", "2020-01-01", "2023-12-31"),
        ("2024–当前", "2024-01-01", "2099-12-31"),
    ]
    rows = []
    source = periods[periods["variant"] == variant]
    for label, start, end in stages:
        group = source[
            source["entryDate"].between(pd.Timestamp(start), pd.Timestamp(end))
        ]
        if group.empty:
            continue
        r, b = group["netReturn"], group["benchmarkReturn"]
        annual_periods = 252 / 20
        years = len(group) / annual_periods
        ann = float(np.prod(1 + r)) ** (1 / years) - 1
        ann_b = float(np.prod(1 + b)) ** (1 / years) - 1
        rows.append(
            {
                "阶段": label,
                "策略年化": ann,
                "沪深300年化": ann_b,
                "年化超额": ann - ann_b,
                "最大回撤": max_drawdown(r),
                "正收益期占比": float((r > 0).mean()),
            }
        )
    return pd.DataFrame(rows)


def pct(x: float) -> str:
    return "—" if pd.isna(x) else f"{x:.2%}"


def number(x: float) -> str:
    return "—" if pd.isna(x) else f"{x:.2f}"


def dataframe_html(df: pd.DataFrame, percent_columns: list[str]) -> str:
    formatted = df.copy()
    for column in percent_columns:
        if column in formatted:
            formatted[column] = formatted[column].map(pct)
    return formatted.to_html(index=False, border=0, classes="data-table", escape=True)


def chart_html(periods: pd.DataFrame) -> str:
    fig = make_subplots(
        rows=2,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.12,
        row_heights=[0.72, 0.28],
        subplot_titles=("成本后净值（对数轴）", "完整规则相对沪深300累计超额"),
    )
    for variant, label in VARIANTS.items():
        group = periods[periods["variant"] == variant]
        fig.add_trace(
            go.Scatter(
                x=group["exitDate"],
                y=group["nav"],
                name=label,
                line={"width": 2.8 if variant == "full_stop" else 1.4},
            ),
            row=1,
            col=1,
        )
    primary = periods[periods["variant"] == "full_stop"]
    fig.add_trace(
        go.Scatter(
            x=primary["exitDate"],
            y=primary["benchmarkNav"],
            name="沪深300",
            line={"color": "#64748b", "dash": "dot"},
        ),
        row=1,
        col=1,
    )
    excess_nav = primary["nav"] / primary["benchmarkNav"]
    fig.add_trace(
        go.Scatter(
            x=primary["exitDate"],
            y=excess_nav - 1,
            name="累计超额",
            fill="tozeroy",
            line={"color": "#2563eb"},
        ),
        row=2,
        col=1,
    )
    fig.update_yaxes(type="log", row=1, col=1)
    fig.update_yaxes(tickformat=".0%", row=2, col=1)
    fig.update_layout(
        height=700,
        template="plotly_white",
        hovermode="x unified",
        margin={"l": 55, "r": 25, "t": 60, "b": 45},
        legend={"orientation": "h", "y": 1.08},
    )
    return fig.to_html(full_html=False, include_plotlyjs=True)


def render_report(
    report_path: Path,
    snapshot_id: str,
    config: Config,
    metric_df: pd.DataFrame,
    periods: pd.DataFrame,
    selections: pd.DataFrame,
    trades: pd.DataFrame,
    metadata: dict,
) -> None:
    primary = metric_df.set_index("variant").loc["full_stop"]
    volume = metric_df.set_index("variant").loc["trend_momentum_volume"]
    momentum = metric_df.set_index("variant").loc["trend_momentum"]
    stop_delta = primary["annualReturn"] - volume["annualReturn"]
    volume_delta = volume["annualReturn"] - momentum["annualReturn"]
    gates = {
        "成本后年化超额 > 0": primary["annualExcess"] > 0,
        "信息比率 ≥ 0.5": primary["informationRatio"] >= 0.5,
        "最大回撤 ≤ 35%": primary["maxDrawdown"] >= -0.35,
        "双倍成本后年化收益 > 0": primary["annualReturn2xCost"] > 0,
    }
    passed = sum(gates.values())
    if passed == len(gates):
        verdict = "通过"
        verdict_class = "pass"
        summary = "完整规则在预设验收门槛下全部通过，可进入模拟盘观察；不等同于可直接实盘。"
    elif primary["annualExcess"] > 0:
        verdict = "部分成立"
        verdict_class = "warn"
        summary = "规则存在历史超额，但未通过全部风险/稳健性门槛，应保留为研究候选而非直接实盘。"
    else:
        verdict = "未证实"
        verdict_class = "fail"
        summary = "完整规则未能在成本后稳定跑赢沪深300，本次数据不支持直接采用。"

    metric_view = metric_df[
        [
            "name",
            "annualReturn",
            "benchmarkAnnualReturn",
            "annualExcess",
            "sharpe",
            "informationRatio",
            "maxDrawdown",
            "annualReturn2xCost",
            "averageHoldings",
            "annualOneWayTurnover",
            "stopCount",
        ]
    ].rename(
        columns={
            "name": "实验组",
            "annualReturn": "策略年化",
            "benchmarkAnnualReturn": "沪深300年化",
            "annualExcess": "年化超额",
            "sharpe": "Sharpe",
            "informationRatio": "信息比率",
            "maxDrawdown": "最大回撤",
            "annualReturn2xCost": "双倍成本年化",
            "averageHoldings": "平均持仓数",
            "annualOneWayTurnover": "年化单边换手",
            "stopCount": "止损次数",
        }
    )
    stage = stage_metrics(periods, "full_stop")
    latest_signal = pd.Timestamp(selections["signalDate"].max()).strftime("%Y-%m-%d")
    latest = selections[
        (selections["variant"] == "full_stop")
        & (pd.to_datetime(selections["signalDate"]) == pd.Timestamp(latest_signal))
    ][
        ["market", "symbol", "name", "industry", "relativeMomentum60", "upDownVolumeRatio20", "cmf20"]
    ].copy()
    latest.columns = ["市场", "代码", "名称", "行业", "60日相对动量", "涨跌量比20", "CMF20"]

    gate_html = "".join(
        f'<li><span class="{"ok" if value else "bad"}">{"✓" if value else "✕"}</span>{name}</li>'
        for name, value in gates.items()
    )
    html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>趋势动量策略验证报告</title>
<style>
body{{margin:0;background:#f4f7fb;color:#172033;font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1280px;margin:auto;padding:30px}} .hero,.card{{background:white;border:1px solid #dbe4f0;border-radius:16px;padding:24px;margin-bottom:18px;box-shadow:0 8px 24px #15345b0d}}
h1{{margin:0 0 8px;font-size:30px}} h2{{margin:0 0 14px;font-size:20px}} .muted{{color:#64748b}}
.verdict{{display:inline-block;padding:5px 13px;border-radius:999px;font-weight:700}} .pass{{background:#dcfce7;color:#166534}} .warn{{background:#fef3c7;color:#92400e}} .fail{{background:#fee2e2;color:#991b1b}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}} .kpi{{background:#f8fafc;border-radius:12px;padding:15px}} .kpi b{{display:block;font-size:23px;color:#0f3d89}}
.data-table{{width:100%;border-collapse:collapse;font-size:13px}} .data-table th,.data-table td{{padding:10px;border-bottom:1px solid #e5eaf1;text-align:right}} .data-table th:first-child,.data-table td:first-child{{text-align:left}}
ul.gates{{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:10px}} .ok{{color:#16a34a;font-weight:800;margin-right:8px}} .bad{{color:#dc2626;font-weight:800;margin-right:8px}}
code{{background:#edf2f7;padding:2px 6px;border-radius:5px}} .note{{border-left:4px solid #f59e0b;padding:10px 14px;background:#fffbeb}}
@media(max-width:800px){{.grid{{grid-template-columns:1fr 1fr}} ul.gates{{grid-template-columns:1fr}} .wrap{{padding:12px}}}}
</style></head><body><main class="wrap">
<section class="hero"><div class="muted">固定快照、无未来函数、T+1 开盘成交</div>
<h1>趋势动量选股逻辑验证</h1>
<p><span class="verdict {verdict_class}">{verdict}</span>　{summary}</p>
<div class="grid">
<div class="kpi"><span>完整规则年化</span><b>{pct(primary["annualReturn"])}</b></div>
<div class="kpi"><span>相对沪深300年化</span><b>{pct(primary["annualExcess"])}</b></div>
<div class="kpi"><span>最大回撤</span><b>{pct(primary["maxDrawdown"])}</b></div>
<div class="kpi"><span>双倍成本年化</span><b>{pct(primary["annualReturn2xCost"])}</b></div>
</div></section>
<section class="card"><h2>一句话结论</h2>
<p>成交量确认对年化收益的边际影响为 <b>{pct(volume_delta)}</b>，MA60 日线止损的边际影响为 <b>{pct(stop_delta)}</b>。
这两个差值来自同一股票池、同一调仓节奏的消融对照，不把“规则更多”误当成“胜率更高”。</p>
<ul class="gates">{gate_html}</ul></section>
<section class="card"><h2>净值与累计超额</h2>{chart_html(periods)}</section>
<section class="card"><h2>四组消融实验</h2>
{dataframe_html(metric_view, ["策略年化","沪深300年化","年化超额","最大回撤","双倍成本年化","年化单边换手"])}</section>
<section class="card"><h2>完整规则分阶段稳定性</h2>
{dataframe_html(stage, ["策略年化","沪深300年化","年化超额","最大回撤","正收益期占比"])}</section>
<section class="card"><h2>规则如何被量化</h2>
<ol>
<li><b>趋势：</b>复权收盘价 &gt; MA20 &gt; MA60 &gt; MA120；MA20/60/120 分别高于 5/10/20 个交易日前。</li>
<li><b>相对动量：</b>个股 60 交易日涨幅减沪深300同期涨幅 &gt; 0。</li>
<li><b>量价确认：</b>20日上涨日平均成交量 / 下跌日平均成交量 &gt; {config.volume_ratio_threshold:.2f}，且 CMF20 &gt; 0。</li>
<li><b>执行：</b>每 {config.rebalance_days} 个交易日选综合得分最高的 {config.holdings} 只，信号日收盘后计算、下一交易日开盘成交；收盘跌破 MA60 后下一交易日开盘止损。</li>
<li><b>股票池：</b>沪深A股、非ST、排除科创板/北交所、上市满365日、价格&gt;1.2元、20日平均成交额≥2000万元。</li>
</ol></section>
<section class="card"><h2>最近一期可复核候选（信号日 {latest_signal}）</h2>
{dataframe_html(latest, ["60日相对动量"])}</section>
<section class="card"><h2>审计与限制</h2>
<p>数据快照：<code>{snapshot_id}</code>；区间：{config.start_date} 至 {config.end_date}；收益价格采用
<code>close / previousClose</code> 逐日链式合成（previousClose 已按除权除息重置），开高低价按同日比例映射。
买入成本 8bp、卖出成本 13bp，并报告 2 倍成本压力。</p>
<p class="note">数据审计曾发现线性前复权 <code>raw_price × factor + priceOffset</code> 在早期高送转股票上接近零，
不适合直接计算跨期百分比收益；本实验因此改用逐日可交易收益链，避免把正常跌幅放大为接近 -100%。</p>
<p class="note">本报告是历史日线验证，不是收益承诺。最大回撤按20日组合估值节点计算，可能低估期内回撤；未模拟涨跌停无法成交、冲击成本、红利税与实时信号延迟。最近一期候选是历史快照输出，不构成买入建议。</p>
<p class="muted">脚本 SHA256：{metadata["scriptSha256"]}　生成时间：{metadata["generatedAt"]}</p>
</section></main></body></html>"""
    report_path.write_text(html, encoding="utf-8")


def main() -> None:
    args = parse_args()
    config = Config(start_date=args.start, end_date=args.end)
    out = paths()
    out["tmp"].mkdir(parents=True, exist_ok=True)
    out["conclusion"].parent.mkdir(parents=True, exist_ok=True)
    snapshot_id, snapshot = current_snapshot()
    con = duckdb.connect(str(out["db"]))
    build_database(con, snapshot, snapshot_id, config, args.force)
    selections = con.execute("SELECT * FROM selections ORDER BY variant, periodNo, score DESC").fetchdf()
    trades = con.execute("SELECT * FROM trades ORDER BY variant, periodNo, score DESC").fetchdf()
    index_prices = con.execute(
        "SELECT tradeDate, open, close FROM index_features ORDER BY tradeDate"
    ).fetchdf()
    con.close()
    if trades.empty:
        raise RuntimeError("no trades generated")
    periods = period_results(trades, index_prices, config)
    metric_df = metrics(periods, config)
    selections.to_csv(out["selections"], index=False, encoding="utf-8-sig")
    trades.to_csv(out["trades"], index=False, encoding="utf-8-sig")
    periods.to_csv(out["periods"], index=False, encoding="utf-8-sig")
    metric_df.to_csv(out["metrics"], index=False, encoding="utf-8-sig")
    script_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    metadata = {
        "snapshotId": snapshot_id,
        "generatedAt": pd.Timestamp.now(tz="Asia/Shanghai").isoformat(),
        "config": asdict(config),
        "scriptSha256": script_hash,
        "python": sys.version,
        "duckdb": duckdb.__version__,
        "artifacts": {k: str(v) for k, v in out.items()},
    }
    out["metadata"].write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    render_report(
        out["report"], snapshot_id, config, metric_df, periods, selections, trades, metadata
    )
    shutil.copy2(out["report"], out["conclusion"])
    print(metric_df.to_string(index=False))
    print(f"\nreport: {out['report']}")
    print(f"conclusion: {out['conclusion']}")


if __name__ == "__main__":
    main()
