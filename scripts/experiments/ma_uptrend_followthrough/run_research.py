#!/usr/bin/env python3
"""Event study: follow-through after an A-share moving-average uptrend signal.

Outputs are written to tmp_output/ma_uptrend_followthrough.  The study uses
point-in-time daily bars from the repository's published research snapshot.
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
VENDOR = ROOT / "tmp_output" / "thirteen_factor_experiment" / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


@dataclass(frozen=True)
class Config:
    start_date: str = "2010-01-04"
    end_date: str = "2026-08-11"
    sample_every_trading_days: int = 20
    min_listed_days: int = 365
    min_price: float = 1.2
    min_amount20: float = 20_000_000
    breakout_buffer: float = 0.01


OUT = ROOT / "tmp_output" / "ma_uptrend_followthrough"
DB = OUT / "ma_uptrend_followthrough.duckdb"
CONFIG = Config()


def q(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def snapshot() -> tuple[str, Path]:
    pointer = json.loads(
        (ROOT / "server/data/research-snapshots/current.json").read_text(encoding="utf-8")
    )
    path = ROOT / "server/data/research-snapshots" / pointer["snapshotId"]
    return pointer["snapshotId"], path


def parquet_glob(path: Path, dataset: str) -> str:
    return str(path / dataset / "**/*.parquet").replace("\\", "/")


def build_database(con: duckdb.DuckDBPyConnection, snapshot_id: str, snap: Path) -> None:
    con.execute("SET threads=6")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET memory_limit='6GB'")
    try:
        old = con.execute("SELECT value FROM metadata WHERE key='snapshot_id'").fetchone()
        if old and old[0] == snapshot_id:
            return
    except duckdb.Error:
        pass

    bars = parquet_glob(snap, "bars")
    warmup = "2009-01-01"
    for table in ["metadata", "events", "sampled", "panel", "features", "stage", "raw", "first_dates", "calendar"]:
        con.execute(f"DROP TABLE IF EXISTS {table}")

    con.execute(
        f"""
        CREATE TABLE metadata(key VARCHAR PRIMARY KEY, value VARCHAR);
        INSERT INTO metadata VALUES
          ('snapshot_id', {q(snapshot_id)}),
          ('config', {q(json.dumps(asdict(CONFIG), ensure_ascii=False, sort_keys=True))});

        CREATE TABLE first_dates AS
        SELECT instrumentKey, MIN(tradeDate) AS firstTradeDate
        FROM read_parquet({q(bars)}, hive_partitioning=true)
        WHERE market IN ('SH', 'SZ')
        GROUP BY instrumentKey;

        CREATE TABLE raw AS
        SELECT b.instrumentKey, b.market, b.symbol, b.name, b.industry, b.tradeDate,
               b.open AS rawOpen, b.high AS rawHigh, b.low AS rawLow,
               b.close AS rawClose, b.previousClose, b.volume, b.amount,
               f.firstTradeDate
        FROM read_parquet({q(bars)}, hive_partitioning=true) b
        JOIN first_dates f USING (instrumentKey)
        WHERE b.tradeDate BETWEEN DATE {q(warmup)} AND DATE {q(CONFIG.end_date)}
          AND b.market IN ('SH', 'SZ')
          AND (
            (b.market='SH' AND regexp_matches(b.symbol, '^(600|601|603|605)[0-9]{{3}}$')) OR
            (b.market='SZ' AND regexp_matches(b.symbol, '^(000|001|002|003|300|301)[0-9]{{3}}$'))
          )
          AND NOT regexp_matches(upper(COALESCE(b.name, '')), '(^|\\*)ST')
          AND b.close > 0 AND b.previousClose > 0;

        CREATE TABLE stage AS
        WITH chained AS (
          SELECT *,
            EXP(SUM(LN(rawClose / previousClose)) OVER (
              PARTITION BY instrumentKey ORDER BY tradeDate
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            )) AS pxClose
          FROM raw
        ), chained_returns AS (
          SELECT *, LAG(pxClose, 1) OVER (
            PARTITION BY instrumentKey ORDER BY tradeDate
          ) AS priorPxClose
          FROM chained
        )
        SELECT *,
          pxClose * rawOpen / rawClose AS pxOpen,
          pxClose * rawHigh / rawClose AS pxHigh,
          pxClose * rawLow / rawClose AS pxLow,
          LAG(pxClose, 1) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS closeLag1,
          LAG(pxClose, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS closeLag20,
          LAG(pxClose, 60) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS closeLag60,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS ma20,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) AS ma60,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS ma120,
          AVG(amount) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS amount20,
          AVG(volume) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS volume20,
          STDDEV_SAMP(LN(pxClose / NULLIF(priorPxClose, 0))) OVER (
            PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW
          ) AS volatility20,
          MAX(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS highClose120,
          COUNT(*) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS obs120
        FROM chained_returns;

        CREATE TABLE features AS
        SELECT *,
          LAG(ma20, 5) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma20Lag5,
          LAG(ma60, 10) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma60Lag10,
          LAG(ma120, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS ma120Lag20,
          LAG(volume20, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS volume20Lag20,
          LEAD(pxOpen, 1) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS entryOpen,
          LEAD(tradeDate, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS date20,
          LEAD(tradeDate, 60) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS date60,
          LEAD(tradeDate, 120) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS date120,
          MAX(pxHigh) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING) AS maxHigh20,
          MAX(pxHigh) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 60 FOLLOWING) AS maxHigh60,
          MAX(pxHigh) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 120 FOLLOWING) AS maxHigh120,
          MAX(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 20 FOLLOWING) AS maxClose20,
          MAX(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 60 FOLLOWING) AS maxClose60,
          MAX(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 120 FOLLOWING) AS maxClose120,
          MIN(pxLow) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND 60 FOLLOWING) AS minLow60,
          LEAD(pxClose, 20) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS close20,
          LEAD(pxClose, 60) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS close60,
          LEAD(pxClose, 120) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS close120
        FROM stage;

        CREATE TABLE calendar AS
        WITH dates AS (
          SELECT tradeDate, ROW_NUMBER() OVER (ORDER BY tradeDate) AS rn
          FROM (SELECT DISTINCT tradeDate FROM features WHERE tradeDate >= DATE {q(CONFIG.start_date)})
        )
        SELECT tradeDate FROM dates WHERE (rn - 1) % {CONFIG.sample_every_trading_days} = 0;

        CREATE TABLE sampled AS
        SELECT f.*,
          f.maxHigh20 / f.entryOpen - 1 AS maxGain20,
          f.maxHigh60 / f.entryOpen - 1 AS maxGain60,
          f.maxHigh120 / f.entryOpen - 1 AS maxGain120,
          f.maxClose20 / f.entryOpen - 1 AS maxCloseGain20,
          f.maxClose60 / f.entryOpen - 1 AS maxCloseGain60,
          f.maxClose120 / f.entryOpen - 1 AS maxCloseGain120,
          f.close20 / f.entryOpen - 1 AS endReturn20,
          f.close60 / f.entryOpen - 1 AS endReturn60,
          f.close120 / f.entryOpen - 1 AS endReturn120,
          f.minLow60 / f.entryOpen - 1 AS maxDrawdown60,
          f.pxClose / NULLIF(f.closeLag20, 0) - 1 AS momentum20,
          f.pxClose / NULLIF(f.closeLag60, 0) - 1 AS momentum60,
          f.pxClose / NULLIF(f.ma20, 0) - 1 AS distanceMa20,
          f.ma20 / NULLIF(f.ma60, 0) - 1 AS maSpread20_60,
          f.ma60 / NULLIF(f.ma120, 0) - 1 AS maSpread60_120,
          f.ma20 / NULLIF(f.ma20Lag5, 0) - 1 AS ma20Slope5,
          f.ma60 / NULLIF(f.ma60Lag10, 0) - 1 AS ma60Slope10,
          f.ma120 / NULLIF(f.ma120Lag20, 0) - 1 AS ma120Slope20,
          f.volume20 / NULLIF(f.volume20Lag20, 0) AS volumeExpansion,
          f.pxClose / NULLIF(f.highClose120, 0) - 1 AS distanceHigh120,
          DATE_DIFF('day', f.firstTradeDate, f.tradeDate) AS listedDays,
          CASE WHEN f.pxClose > f.ma20 AND f.ma20 > f.ma60 AND f.ma60 > f.ma120
                    AND f.ma20 > f.ma20Lag5 AND f.ma60 > f.ma60Lag10 AND f.ma120 > f.ma120Lag20
               THEN 1 ELSE 0 END AS isTrend
        FROM features f JOIN calendar c USING (tradeDate)
        WHERE f.obs120 = 120
          AND DATE_DIFF('day', f.firstTradeDate, f.tradeDate) >= {CONFIG.min_listed_days}
          AND f.rawClose >= {CONFIG.min_price}
          AND f.amount20 >= {CONFIG.min_amount20}
          AND f.entryOpen IS NOT NULL;

        CREATE TABLE events AS SELECT * FROM sampled WHERE isTrend=1;
        """
    )


def date_cluster_ci(df: pd.DataFrame, col: str, seed: int = 20260812) -> tuple[float, float]:
    by_date = df.groupby("tradeDate")[col].agg(["sum", "count"]).dropna().to_numpy(float)
    if len(by_date) == 0:
        return math.nan, math.nan
    rng = np.random.default_rng(seed)
    idx = rng.integers(0, len(by_date), size=(2000, len(by_date)))
    sampled = by_date[idx]
    sims = sampled[:, :, 0].sum(axis=1) / sampled[:, :, 1].sum(axis=1)
    return float(np.quantile(sims, 0.025)), float(np.quantile(sims, 0.975))


def probability_table(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    cols = []
    for h in (20, 60, 120):
        cols += [f"maxGain{h}", f"maxCloseGain{h}", f"endReturn{h}"]
    frames = []
    for universe, where in [("全体合格股票", "TRUE"), ("均线向上", "isTrend=1")]:
        df = con.execute(
            f"SELECT tradeDate, date20, date60, date120, highClose120, pxClose, maxClose20, maxClose60, maxClose120, {', '.join(cols)} FROM sampled WHERE {where}"
        ).df()
        for h in (20, 60, 120):
            valid = df[df[f"date{h}"].notna() & df[f"maxGain{h}"].notna()].copy()
            metrics = {
                "触及+20%": valid[f"maxGain{h}"] >= 0.20,
                "收盘触及+20%": valid[f"maxCloseGain{h}"] >= 0.20,
                "期末仍+20%": valid[f"endReturn{h}"] >= 0.20,
                "突破前120日高点": valid[f"maxClose{h}"] >= valid["highClose120"] * (1 + CONFIG.breakout_buffer),
            }
            for metric, values in metrics.items():
                tmp = pd.DataFrame({"tradeDate": valid["tradeDate"], "value": values.astype(float)})
                lo, hi = date_cluster_ci(tmp, "value")
                frames.append({
                    "样本": universe, "窗口_交易日": h, "指标": metric,
                    "概率": float(values.mean()), "95CI下限": lo, "95CI上限": hi,
                    "事件数": int(len(valid)), "信号日期数": int(valid["tradeDate"].nunique()),
                })
    return pd.DataFrame(frames)


FEATURES = {
    "momentum20": "过去20日动量",
    "momentum60": "过去60日动量",
    "distanceMa20": "距MA20",
    "maSpread20_60": "MA20/MA60乖离",
    "maSpread60_120": "MA60/MA120乖离",
    "ma20Slope5": "MA20斜率",
    "ma60Slope10": "MA60斜率",
    "ma120Slope20": "MA120斜率",
    "volumeExpansion": "20日量能扩张",
    "volatility20": "20日波动率",
    "distanceHigh120": "距120日高点",
    "amount20": "20日成交额",
}


def feature_analysis(con: duckdb.DuckDBPyConnection) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    cols = ", ".join(FEATURES)
    df = con.execute(
        f"SELECT tradeDate, industry, maxGain60, endReturn60, {cols} FROM events WHERE date60 IS NOT NULL"
    ).df()
    rows = []
    deciles = []
    outcomes = {
        "60日盘中触及+20%": df["maxGain60"] >= 0.20,
        "60日期末仍+20%": df["endReturn60"] >= 0.20,
    }
    for outcome_label, outcome in outcomes.items():
        for col, label in FEATURES.items():
            x = df[col].replace([np.inf, -np.inf], np.nan)
            ok = x.notna()
            win = outcome[ok]
            xv = x[ok]
            med_w = float(xv[win].median())
            med_l = float(xv[~win].median())
            scale = float(xv.quantile(0.75) - xv.quantile(0.25))
            effect = (med_w - med_l) / scale if scale else math.nan
            rows.append({"结果口径": outcome_label, "特征": label, "字段": col, "赢家中位数": med_w, "其他中位数": med_l, "中位数差/IQR": effect, "样本数": int(ok.sum())})
            ranked = pd.qcut(xv.rank(method="first"), 10, labels=False) + 1
            part = pd.DataFrame({"decile": ranked, "winner": win.to_numpy(), "value": xv.to_numpy()})
            g = part.groupby("decile").agg(成功率=("winner", "mean"), 样本数=("winner", "size"), 特征中位数=("value", "median")).reset_index()
            g.insert(0, "特征", label)
            g.insert(0, "结果口径", outcome_label)
            deciles.append(g)
    summary = pd.DataFrame(rows).sort_values(["结果口径", "中位数差/IQR"], key=lambda s: s.abs() if s.name == "中位数差/IQR" else s, ascending=[True, False])
    decile_df = pd.concat(deciles, ignore_index=True)

    industry = (df.assign(行业=df["industry"].fillna("未知"), 盘中触及=df["maxGain60"] >= .2, 期末仍达标=df["endReturn60"] >= .2)
        .groupby("行业").agg(盘中触及20概率=("盘中触及", "mean"), 期末仍20概率=("期末仍达标", "mean"), 事件数=("盘中触及", "size"))
        .query("事件数 >= 100").sort_values("期末仍20概率", ascending=False).reset_index())
    return summary, decile_df, industry


def robustness(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    return con.execute(
        """
        SELECT
          CASE WHEN tradeDate < DATE '2020-01-01' THEN '2010-2019' ELSE '2020-2026' END AS 时段,
          CASE
            WHEN symbol LIKE '300%' OR symbol LIKE '301%' THEN '创业板'
            WHEN symbol LIKE '002%' OR symbol LIKE '003%' THEN '中小/深主板'
            ELSE '沪深主板'
          END AS 板块,
          COUNT(*) AS 事件数,
          AVG(CASE WHEN maxGain60 >= .2 THEN 1.0 ELSE 0.0 END) AS 六十日触及20概率,
          AVG(maxGain60) AS 六十日最大涨幅均值,
          MEDIAN(endReturn60) AS 六十日期末收益中位数,
          AVG(CASE WHEN maxDrawdown60 <= -.1 THEN 1.0 ELSE 0.0 END) AS 六十日回撤超10概率
        FROM events WHERE date60 IS NOT NULL
        GROUP BY 1,2 ORDER BY 1,2
        """
    ).df()


def risk_summary(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    return con.execute(
        """
        SELECT COUNT(*) AS 完整60日事件数,
          MEDIAN(endReturn60) AS 期末收益中位数,
          AVG(endReturn60) AS 期末收益均值,
          AVG(CASE WHEN maxDrawdown60 <= -.1 THEN 1.0 ELSE 0.0 END) AS 期间回撤超10概率,
          AVG(CASE WHEN maxGain60 >= .2 AND endReturn60 < .2 THEN 1.0 ELSE 0.0 END)
            / NULLIF(AVG(CASE WHEN maxGain60 >= .2 THEN 1.0 ELSE 0.0 END), 0) AS 触及后未守住20占比
        FROM events WHERE date60 IS NOT NULL
        """
    ).df()


def pct(x: float) -> str:
    return "—" if pd.isna(x) else f"{x:.1%}"


def html_table(df: pd.DataFrame, percent_cols: set[str] | None = None, max_rows: int | None = None) -> str:
    view = df.head(max_rows).copy() if max_rows else df.copy()
    for col in percent_cols or set():
        if col in view:
            view[col] = view[col].map(pct)
    return view.to_html(index=False, border=0, classes="data", escape=True)


def render_report(snapshot_id: str, probs: pd.DataFrame, feats: pd.DataFrame, deciles: pd.DataFrame, industry: pd.DataFrame, robust: pd.DataFrame, risks: pd.DataFrame) -> str:
    trend = probs[(probs["样本"] == "均线向上") & (probs["指标"] == "触及+20%")]
    base = probs[(probs["样本"] == "全体合格股票") & (probs["指标"] == "触及+20%")]
    cards = []
    for h in (20, 60, 120):
        t = trend[trend["窗口_交易日"] == h].iloc[0]
        b = base[base["窗口_交易日"] == h].iloc[0]
        lift = t["概率"] / b["概率"] if b["概率"] else math.nan
        cards.append(f'<div class="card"><div class="h">未来 {h} 日触及 +20%</div><div class="v">{pct(t["概率"])}</div><div class="s">95% CI {pct(t["95CI下限"])}–{pct(t["95CI上限"])} · 相对全体 {lift:.2f}×</div></div>')
    p60 = trend[trend["窗口_交易日"] == 60].iloc[0]
    durable = feats[feats["结果口径"] == "60日期末仍+20%"].sort_values("中位数差/IQR", key=lambda s: s.abs(), ascending=False)
    touch = feats[feats["结果口径"] == "60日盘中触及+20%"].sort_values("中位数差/IQR", key=lambda s: s.abs(), ascending=False)
    best = durable.iloc[0]
    weakest = durable.iloc[-1]
    decile_pivot = deciles.pivot(index=["结果口径", "特征"], columns="decile", values="成功率").reset_index()
    key_deciles = decile_pivot[(decile_pivot["结果口径"] == "60日期末仍+20%") & decile_pivot["特征"].isin(durable.head(6)["特征"])]
    risk = risks.iloc[0]
    generated = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z")
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>均线向上股票后续上涨与突破概率研究</title><style>
body{{font-family:Inter,"Microsoft YaHei",sans-serif;background:#f4f6f8;color:#17212b;margin:0}}main{{max-width:1180px;margin:auto;padding:36px 24px 80px}}h1{{font-size:32px;margin:0 0 8px}}h2{{margin-top:42px;border-left:4px solid #1769aa;padding-left:12px}}.meta{{color:#657381}}.cards{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:28px 0}}.card{{background:white;border-radius:12px;padding:20px;box-shadow:0 2px 12px #12263a14}}.h{{color:#657381}}.v{{font-size:38px;font-weight:750;color:#0b6e4f;margin:8px 0}}.s{{font-size:13px;color:#657381}}.callout{{background:#eaf3fb;border-radius:10px;padding:18px 20px;line-height:1.75}}table.data{{border-collapse:collapse;width:100%;background:white;font-size:13px}}table.data th,table.data td{{border-bottom:1px solid #e4e9ee;padding:9px 10px;text-align:right}}table.data th:first-child,table.data td:first-child{{text-align:left}}table.data th{{background:#edf2f6;position:sticky;top:0}}.scroll{{overflow:auto;max-height:560px}}code{{background:#e9eef2;padding:2px 5px;border-radius:4px}}li{{margin:7px 0}}@media(max-width:800px){{.cards{{grid-template-columns:1fr}}}}
</style></head><body><main>
<h1>均线向上股票：后续涨 20% 与突破的概率</h1><div class="meta">A股历史事件研究 · 2010-01-04 至 2026-08-11 · 报告生成 {generated}</div>
<div class="cards">{''.join(cards)}</div>
<div class="callout"><strong>一句话结论：</strong>严格“均线向上”不是上涨保证。以次日开盘为起点，未来 60 个交易日盘中触及 +20% 的概率为 <strong>{pct(p60['概率'])}</strong>（按信号日期聚类 bootstrap 的 95% CI：{pct(p60['95CI下限'])}–{pct(p60['95CI上限'])}），但期末仍守住 +20% 的概率只有 <strong>{pct(probs[(probs['样本']=='均线向上') & (probs['窗口_交易日']==60) & (probs['指标']=='期末仍+20%')].iloc[0]['概率'])}</strong>。触及目标的股票中有 {pct(risk['触及后未守住20占比'])} 到期末已回落到 +20% 以下。真正“持续上涨”组区分度最大的特征是<strong>{best['特征']}</strong>，最弱的是<strong>{weakest['特征']}</strong>。</div>
<h2>口径</h2><ul>
<li><strong>均线向上：</strong>收盘价 &gt; MA20 &gt; MA60 &gt; MA120，且 MA20 比5日前高、MA60 比10日前高、MA120 比20日前高。</li>
<li><strong>样本：</strong>沪深A股（含创业板），排除名称含ST、上市不足365天、股价低于1.2元、20日平均成交额低于2000万元；每20个市场交易日取一次截面，降低重叠。</li>
<li><strong>上涨 &gt;20%：</strong>主口径为次日开盘起算，窗口内最高价触及 +20%；同时给出“最高收盘触及”和“期末仍高于 +20%”。未扣交易成本。</li>
<li><strong>突破：</strong>窗口内收盘价超过信号日120日最高收盘价 1%；该定义表示刷新中期高点，不是形态主观判定。</li>
<li><strong>复权：</strong>以每日 <code>close / previousClose</code> 链式构造连续价格，避免分红送转造成虚假跳变；所有信号只用当日及以前信息。</li></ul>
<h2>核心概率</h2><div class="scroll">{html_table(probs, {'概率','95CI下限','95CI上限'})}</div>
<h2>会继续涨的股票有什么特征</h2><p>主表把“赢家”严格定义为未来60日期末仍比次日开盘高至少20%。<code>中位数差/IQR</code> 绝对值越大，区分度越强；正值表示赢家更高，负值表示赢家更低。它是描述性关系，不自动代表因果。</p>
<div class="scroll">{html_table(durable)}</div>
<h3>关键特征十分位成功率（D1低 → D10高）</h3><div class="scroll">{html_table(key_deciles, set(key_deciles.columns[2:]))}</div>
<h3>宽松口径：60日内盘中曾触及 +20%</h3><div class="scroll">{html_table(touch)}</div>
<h2>收益兑现与回撤风险</h2><div class="scroll">{html_table(risks, {'期末收益中位数','期末收益均值','期间回撤超10概率','触及后未守住20占比'})}</div>
<h2>时段与板块稳健性</h2><div class="scroll">{html_table(robust, {'六十日触及20概率','六十日最大涨幅均值','六十日期末收益中位数','六十日回撤超10概率'})}</div>
<h2>行业差异（至少100个事件）</h2><p>行业字段来自当日行情快照。行业结果容易受行情阶段和样本结构影响，只适合作为背景，不宜直接当筛选规则。</p><div class="scroll">{html_table(industry, {'盘中触及20概率','期末仍20概率'}, 40)}</div>
<h2>限制与使用建议</h2><ul><li>同一股票可在不同月度截面重复出现，因此置信区间按“信号日期”聚类重采样；股票间联动和制度变化仍可能使不确定性被低估。</li><li>“盘中触及”不等于收盘持有收益，涨停板也可能无法按目标价成交；实盘决策应优先参考“收盘触及”和“期末仍+20%”。</li><li>本研究控制了流动性与上市时长，但未完整控制市值、停牌、涨跌停可成交性和退市幸存偏差。快照含历史退市证券的程度决定幸存偏差大小。</li><li>建议把显著特征作为候选过滤器，再做严格的时间外验证、交易成本和组合级回测，而不是按全样本最优分组直接下单。</li></ul>
<div class="meta">数据快照：{snapshot_id}。完整事件、概率、特征十分位、行业与稳健性 CSV 均与本报告同目录。</div>
</main></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    snapshot_id, snap = snapshot()
    con = duckdb.connect(str(DB))
    build_database(con, snapshot_id, snap)
    probs = probability_table(con)
    feats, deciles, industry = feature_analysis(con)
    robust = robustness(con)
    risks = risk_summary(con)
    events = con.execute(
        """SELECT tradeDate, instrumentKey, market, symbol, name, industry, isTrend,
                  maxGain20, maxGain60, maxGain120, maxCloseGain20, maxCloseGain60,
                  maxCloseGain120, endReturn20, endReturn60, endReturn120,
                  maxDrawdown60, momentum20, momentum60, distanceMa20,
                  maSpread20_60, maSpread60_120, ma20Slope5, ma60Slope10,
                  ma120Slope20, volumeExpansion, volatility20, distanceHigh120, amount20
           FROM events"""
    ).df()
    probs.to_csv(OUT / "probabilities.csv", index=False, encoding="utf-8-sig")
    feats.to_csv(OUT / "winner_feature_comparison.csv", index=False, encoding="utf-8-sig")
    deciles.to_csv(OUT / "feature_deciles.csv", index=False, encoding="utf-8-sig")
    industry.to_csv(OUT / "industry_summary.csv", index=False, encoding="utf-8-sig")
    robust.to_csv(OUT / "robustness.csv", index=False, encoding="utf-8-sig")
    risks.to_csv(OUT / "risk_summary.csv", index=False, encoding="utf-8-sig")
    event_path = str(OUT / "trend_events.parquet").replace("'", "''")
    con.execute(f"COPY (SELECT * FROM events) TO '{event_path}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    report = render_report(snapshot_id, probs, feats, deciles, industry, robust, risks)
    (OUT / "report.html").write_text(report, encoding="utf-8")
    con.close()
    # The analytical cache is several GB and is fully reproducible from the snapshot.
    # Keep the compact event parquet and CSV results, not the transient DuckDB file.
    DB.unlink(missing_ok=True)
    metadata = {
        "snapshot_id": snapshot_id,
        "generated_at": datetime.now().astimezone().isoformat(),
        "config": asdict(CONFIG),
        "trend_event_count": int(len(events)),
        "signal_date_count": int(events["tradeDate"].nunique()),
        "artifacts": [p.name for p in OUT.iterdir() if p.is_file()],
    }
    (OUT / "run_metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    print(probs.to_string(index=False))


if __name__ == "__main__":
    main()
