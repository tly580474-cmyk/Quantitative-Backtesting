#!/usr/bin/env python3
"""Study buying 'retail height fear' in MA uptrends and exiting on retail influx."""

from __future__ import annotations

import json
import math
import os
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "tmp_output" / "retail_height_fear_research"
DB_PATH = OUT / "retail_height_fear.duckdb"
VENDOR = ROOT / "tmp_output" / "thirteen_factor_experiment" / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

WARMUP = "2015-01-05"
START = "2016-08-12"
END = "2026-08-10"  # last completed high-coverage Tinyshare fund-flow date
PRIMARY_SCORE = 75
BUY_COST = 0.0008
SELL_COST = 0.0013


def log(message: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {message}", flush=True)


def load_env(path: Path) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def snapshot() -> tuple[str, Path, dict]:
    pointer = json.loads((ROOT / "server/data/research-snapshots/current.json").read_text(encoding="utf-8"))
    path = ROOT / "server/data/research-snapshots" / pointer["snapshotId"]
    manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    return pointer["snapshotId"], path, manifest


def qp(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


def build_flow_table(con: duckdb.DuckDBPyConnection) -> dict:
    import pymysql
    load_env(ROOT / "server/.env")
    conn = pymysql.connect(
        host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "3306")),
        user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
        database=os.getenv("DB_NAME", "quant_backtest"), charset="utf8mb4", autocommit=True,
    )
    con.execute("DROP TABLE IF EXISTS flow")
    con.execute("""CREATE TABLE flow(
      instrumentKey INTEGER, tradeDate DATE, mainNetIn DOUBLE, smallNetIn DOUBLE,
      sourceKey VARCHAR, PRIMARY KEY(instrumentKey,tradeDate))""")
    total = 0
    sql = """
      SELECT f.instrument_key instrumentKey, f.trade_date tradeDate,
             f.main_net_in mainNetIn, f.small_net_in smallNetIn, f.source_key sourceKey
      FROM stock_fund_flows f
      JOIN fund_flow_sync_dates s ON s.trade_date=f.trade_date
       AND s.source_key='tinyshare_moneyflow' AND s.status='completed' AND s.coverage_pct>=90
      WHERE f.trade_date BETWEEN %s AND %s AND f.source_key='tinyshare_moneyflow' AND f.is_final=1
    """
    log("读取高覆盖率历史大小单资金流...")
    for year in range(2015, 2027):
        year_start = max(WARMUP, f"{year}-01-01")
        year_end = min(END, f"{year}-12-31")
        if year_start > year_end:
            continue
        year_rows = 0
        for chunk in pd.read_sql_query(sql, conn, params=(year_start, year_end), chunksize=250_000):
            chunk["tradeDate"] = pd.to_datetime(chunk["tradeDate"])
            con.register("flow_chunk", chunk)
            con.execute("INSERT INTO flow SELECT instrumentKey,tradeDate,mainNetIn,smallNetIn,sourceKey FROM flow_chunk")
            con.unregister("flow_chunk")
            total += len(chunk); year_rows += len(chunk)
        log(f"{year} 年：{year_rows:,} 条，累计 {total:,}")
    with conn.cursor() as cur:
        cur.execute("""SELECT MIN(trade_date),MAX(trade_date),COUNT(*),AVG(coverage_pct),MIN(coverage_pct)
          FROM fund_flow_sync_dates WHERE source_key='tinyshare_moneyflow' AND status='completed'
            AND coverage_pct>=90 AND trade_date BETWEEN %s AND %s""", (WARMUP, END))
        row = cur.fetchone()
    conn.close()
    return {"minDate": str(row[0]), "maxDate": str(row[1]), "dateCount": int(row[2]),
            "avgCoveragePct": float(row[3]), "minCoveragePct": float(row[4]), "rows": total}


def build_panel(con: duckdb.DuckDBPyConnection, snap: Path) -> None:
    bars = qp(snap / "bars/**/*.parquet")
    log("构建复权价格、均线、资金流与散户参与评分面板...")
    con.execute(f"""
      DROP TABLE IF EXISTS panel;
      CREATE TABLE panel AS
      WITH all_bars AS (
        SELECT * EXCLUDE(year) FROM read_parquet('{bars}', hive_partitioning=true)
      ), first_dates AS (
        SELECT instrumentKey,MIN(tradeDate) firstTradeDate FROM all_bars GROUP BY instrumentKey
      ), raw AS (
        SELECT b.instrumentKey,b.market,b.symbol,b.name,b.industry,b.tradeDate,
          b.open rawOpen,b.high rawHigh,b.low rawLow,b.close rawClose,b.previousClose,
          b.volume,b.amount,b.turnoverRatePct,b.totalMarketCap,f.firstTradeDate,
          fl.mainNetIn,fl.smallNetIn
        FROM all_bars b JOIN first_dates f USING(instrumentKey)
        JOIN flow fl USING(instrumentKey,tradeDate)
        WHERE b.tradeDate BETWEEN DATE '{WARMUP}' AND DATE '{END}'
          AND b.market IN ('SH','SZ')
          AND ((b.market='SH' AND regexp_matches(b.symbol,'^(600|601|603|605)[0-9]{{3}}$'))
            OR (b.market='SZ' AND regexp_matches(b.symbol,'^(000|001|002|003|300|301)[0-9]{{3}}$')))
          AND b.close>0 AND b.previousClose>0
      ), chained AS (
        SELECT *,EXP(SUM(LN(rawClose/previousClose)) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate)) pxClose
        FROM raw
      ), priced AS (
        SELECT *,pxClose*rawOpen/rawClose pxOpen,pxClose*rawHigh/rawClose pxHigh,
          pxClose*rawLow/rawClose pxLow,
          LAG(pxClose,1) OVER w pxLag1,LAG(pxClose,5) OVER w pxLag5,LAG(pxClose,20) OVER w pxLag20
        FROM chained WINDOW w AS (PARTITION BY instrumentKey ORDER BY tradeDate)
      ), base AS (
        SELECT *,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) ma5,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 9 PRECEDING AND CURRENT ROW) ma10,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) ma20,
          AVG(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 29 PRECEDING AND CURRENT ROW) ma30,
          MAX(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) high60,
          AVG(volume) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) volume20,
          AVG(amount) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) amount20,
          QUANTILE_CONT(turnoverRatePct,.9) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 249 PRECEDING AND CURRENT ROW) turnoverQ90,
          mainNetIn/NULLIF(amount,0) mainIntensity,smallNetIn/NULLIF(amount,0) smallIntensity,
          ROW_NUMBER() OVER (PARTITION BY instrumentKey ORDER BY tradeDate) stockSession
        FROM priced
      ), slopes AS (
        SELECT *,LAG(ma5,5) OVER w ma5Lag5,LAG(ma10,5) OVER w ma10Lag5,
          LAG(ma20,5) OVER w ma20Lag5,LAG(ma30,5) OVER w ma30Lag5,
          AVG(mainIntensity) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) main3,
          AVG(smallIntensity) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) small3,
          SUM(CASE WHEN smallIntensity>0 THEN 1 ELSE 0 END) OVER (
            PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) smallPositiveDays3
        FROM base WINDOW w AS (PARTITION BY instrumentKey ORDER BY tradeDate)
      ), ranked AS (
        SELECT *,PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY small3) smallFlowRank,
          pxClose/NULLIF(pxLag1,0)-1 ret1,pxClose/NULLIF(pxLag5,0)-1 ret5,
          pxClose/NULLIF(pxLag20,0)-1 ret20,pxClose/NULLIF(ma20,0)-1 distanceMa20,
          pxClose/NULLIF(high60,0)-1 distanceHigh60,volume/NULLIF(volume20,0) volumeRatio,
          CASE WHEN ma5>ma10 AND ma10>ma20 AND ma20>ma30
                 AND ma5>ma5Lag5 AND ma10>ma10Lag5 AND ma20>ma20Lag5 AND ma30>ma30Lag5
               THEN 1 ELSE 0 END trendUp
        FROM slopes
      ), scored AS (
        SELECT *,
          35*smallFlowRank
          +20*LEAST(GREATEST(turnoverRatePct/NULLIF(turnoverQ90,0),0),1)
          +15*LEAST(GREATEST(volumeRatio/2,0),1)
          +15*LEAST(GREATEST(ret5,0)/.20,1)
          +15*(.5*CASE WHEN distanceHigh60>=-.02 THEN 1 ELSE 0 END
              +.5*LEAST(GREATEST(distanceMa20,0)/.20,1)) AS retailScore
        FROM ranked
      ), signaled AS (
        SELECT *,
          CASE WHEN trendUp=1 AND distanceHigh60>=-.02 AND distanceMa20 BETWEEN .08 AND .20
            AND ret20 BETWEEN .10 AND .40 AND volumeRatio<=1.5 AND small3<=0 AND main3>=small3
            AND ret1<.095 THEN 1 ELSE 0 END heightFearBuy,
          CASE WHEN trendUp=1 AND distanceHigh60>=-.02 AND distanceMa20 BETWEEN .08 AND .20
            AND ret20 BETWEEN .10 AND .40 AND ret1<.095 THEN 1 ELSE 0 END relaxedHighBuy,
          CASE WHEN retailScore>=70 AND small3>0 AND smallPositiveDays3>=2 AND volumeRatio>=1.2 THEN 1 ELSE 0 END retailSell70,
          CASE WHEN retailScore>=75 AND small3>0 AND smallPositiveDays3>=2 AND volumeRatio>=1.2 THEN 1 ELSE 0 END retailSell75,
          CASE WHEN retailScore>=80 AND small3>0 AND smallPositiveDays3>=2 AND volumeRatio>=1.2 THEN 1 ELSE 0 END retailSell80
        FROM scored
      )
      SELECT *,ROW_NUMBER() OVER (PARTITION BY instrumentKey ORDER BY tradeDate) sessionNo,
        LEAD(tradeDate,1) OVER w nextDate,LEAD(pxOpen,1) OVER w nextOpen,
        MIN(CASE WHEN retailSell70=1 THEN tradeDate END) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) nextSell70,
        MIN(CASE WHEN retailSell75=1 THEN tradeDate END) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) nextSell75,
        MIN(CASE WHEN retailSell80=1 THEN tradeDate END) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING) nextSell80
      FROM signaled WINDOW w AS (PARTITION BY instrumentKey ORDER BY tradeDate);
    """)


def get_candidates(con: duckdb.DuckDBPyConnection, buy_col: str, score: int) -> pd.DataFrame:
    sell_col = f"nextSell{score}"
    return con.execute(f"""
      SELECT instrumentKey,market,symbol,name,industry,tradeDate signalDate,nextDate entryDate,nextOpen entryOpen,
        sessionNo entrySignalSession,{sell_col} exitSignalDate,
        retailScore,small3,main3,smallFlowRank,turnoverRatePct,turnoverQ90,volumeRatio,
        ret5,ret20,distanceMa20,distanceHigh60,totalMarketCap
      FROM panel
      WHERE tradeDate BETWEEN DATE '{START}' AND DATE '{END}' AND {buy_col}=1
        AND DATE_DIFF('day',firstTradeDate,tradeDate)>=365 AND rawClose>=1.2 AND amount20>=20000000
        AND NOT regexp_matches(upper(COALESCE(name,'')),'(^|\\*)ST')
        AND nextOpen IS NOT NULL AND nextOpen/pxClose-1<.095
      ORDER BY instrumentKey,tradeDate
    """).df()


def select_nonoverlap(candidates: pd.DataFrame) -> pd.DataFrame:
    picked = []
    for _, group in candidates.groupby("instrumentKey", sort=False):
        available_after = pd.Timestamp.min
        blocked = False
        for row in group.sort_values("signalDate").itertuples(index=False):
            if blocked or pd.Timestamp(row.signalDate) <= available_after:
                continue
            picked.append(row._asdict())
            if pd.isna(row.exitSignalDate):
                blocked = True
            else:
                available_after = pd.Timestamp(row.exitSignalDate)
    return pd.DataFrame(picked)


def materialize_trades(con: duckdb.DuckDBPyConnection, chosen: pd.DataFrame, label: str, score: int) -> pd.DataFrame:
    if chosen.empty:
        return chosen
    chosen = chosen.copy().reset_index(drop=True)
    chosen.insert(0, "tradeId", [f"{label}-{score}-{i+1}" for i in range(len(chosen))])
    con.register("chosen_df", chosen)
    trades = con.execute(f"""
      WITH exit_map AS (
        SELECT c.tradeId,p.nextDate exitDate,p.nextOpen exitOpen,p.sessionNo exitSignalSession,
          p.retailScore exitRetailScore,p.small3 exitSmall3,p.main3 exitMain3,
          p.smallFlowRank exitSmallFlowRank,p.volumeRatio exitVolumeRatio,
          p.turnoverRatePct exitTurnoverPct,p.ret5 exitRet5,p.distanceMa20 exitDistanceMa20,
          p.main3<0 AND p.small3>0 fundFlowDivergence
        FROM chosen_df c LEFT JOIN panel p
          ON p.instrumentKey=c.instrumentKey AND p.tradeDate=c.exitSignalDate
      ), path_stats AS (
        SELECT c.tradeId,MAX(p.pxHigh) maxPxHigh,ARG_MAX(p.tradeDate,p.pxHigh) maxGainDate,
          MIN(p.pxLow) minPxLow,COUNT(*) observedSessions
        FROM chosen_df c JOIN panel p ON p.instrumentKey=c.instrumentKey
          AND p.tradeDate>=c.entryDate AND p.tradeDate<=COALESCE(c.exitSignalDate,DATE '{END}')
        GROUP BY c.tradeId
      )
      SELECT c.*,e.* EXCLUDE(tradeId),s.* EXCLUDE(tradeId),
        s.maxPxHigh/c.entryOpen-1 maxGainBeforeRetail,
        s.minPxLow/c.entryOpen-1 maxDrawdownBeforeRetail,
        CASE WHEN e.exitOpen IS NOT NULL THEN e.exitOpen/c.entryOpen-1 ELSE NULL END grossExitReturn,
        CASE WHEN e.exitOpen IS NOT NULL THEN e.exitOpen/c.entryOpen*(1-{SELL_COST})/(1+{BUY_COST})-1 ELSE NULL END netExitReturn,
        CASE WHEN e.exitOpen IS NULL THEN 1 ELSE 0 END censored,
        CASE WHEN e.exitOpen IS NOT NULL THEN e.exitSignalSession-c.entrySignalSession ELSE NULL END holdingSessions,
        DATE_DIFF('day',c.entryDate,s.maxGainDate) calendarDaysToMax
      FROM chosen_df c LEFT JOIN exit_map e USING(tradeId) JOIN path_stats s USING(tradeId)
      ORDER BY c.signalDate,c.instrumentKey
    """).df()
    con.unregister("chosen_df")
    trades.insert(1, "sample", label)
    trades.insert(2, "sellScoreThreshold", score)
    return trades


def run_variants(con: duckdb.DuckDBPyConnection) -> pd.DataFrame:
    frames = []
    for label, col in [("恐高型主策略", "heightFearBuy"), ("仅趋势近新高对照", "relaxedHighBuy")]:
        for score in (70,75,80):
            candidates = get_candidates(con, col, score)
            chosen = select_nonoverlap(candidates)
            log(f"{label} / 卖点{score}分：候选{len(candidates):,}，非重叠交易{len(chosen):,}")
            frames.append(materialize_trades(con, chosen, label, score))
    return pd.concat(frames, ignore_index=True)


def summarize(trades: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (sample, score), g in trades.groupby(["sample","sellScoreThreshold"]):
        closed = g[g.censored==0]
        rows.append({
          "样本":sample,"卖点分数":score,"交易数":len(g),"已出现卖点":len(closed),
          "删失率":g.censored.mean(),"最高涨幅中位数":g.maxGainBeforeRetail.median(),
          "最高涨幅均值":g.maxGainBeforeRetail.mean(),"最高涨幅>=10%":(g.maxGainBeforeRetail>=.10).mean(),
          "最高涨幅>=20%":(g.maxGainBeforeRetail>=.20).mean(),"最高涨幅>=50%":(g.maxGainBeforeRetail>=.50).mean(),
          "最高涨幅>=100%":(g.maxGainBeforeRetail>=1).mean(),"到最高点日历天中位数":g.calendarDaysToMax.median(),
          "持有交易日中位数":closed.holdingSessions.median(),"退出胜率":(closed.netExitReturn>0).mean(),
          "退出收益中位数":closed.netExitReturn.median(),"退出收益均值":closed.netExitReturn.mean(),
          "最大回撤中位数":g.maxDrawdownBeforeRetail.median(),
          "从最高点回吐中位数":(g.maxGainBeforeRetail-closed.netExitReturn).median(),
          "卖点资金背离率":closed.fundFlowDivergence.fillna(False).mean(),
        })
    return pd.DataFrame(rows)


def annual_stats(primary: pd.DataFrame) -> pd.DataFrame:
    d = primary.copy(); d["年份"] = pd.to_datetime(d.signalDate).dt.year
    return d.groupby("年份").agg(
      交易数=("tradeId","size"),最高涨幅中位数=("maxGainBeforeRetail","median"),
      触及20概率=("maxGainBeforeRetail",lambda s:(s>=.2).mean()),
      触及50概率=("maxGainBeforeRetail",lambda s:(s>=.5).mean()),
      已退出数=("censored",lambda s:(s==0).sum()),删失率=("censored","mean"),
      退出收益中位数=("netExitReturn","median"),持有交易日中位数=("holdingSessions","median")
    ).reset_index()


def subgroup_stats(primary: pd.DataFrame) -> pd.DataFrame:
    d = primary.copy()
    specs = {
      "起涨市值分组": ("totalMarketCap", ["Q1小","Q2","Q3","Q4大"]),
      "买点量比分组": ("volumeRatio", ["Q1最缩量","Q2","Q3","Q4较放量"]),
      "买点换手率分组": ("turnoverRatePct", ["Q1低换手","Q2","Q3","Q4高换手"]),
      "20日动量分组": ("ret20", ["Q1动量较弱","Q2","Q3","Q4动量较强"]),
      "MA20乖离分组": ("distanceMa20", ["Q1乖离较低","Q2","Q3","Q4乖离较高"]),
      "主力资金强度": ("main3", ["Q1偏弱","Q2","Q3","Q4偏强"]),
      "恐高强度": ("small3", ["Q1小单流出最强","Q2","Q3","Q4接近零"]),
    }
    for dim,(col,labels) in specs.items():
      d[dim] = pd.qcut(d[col].rank(method="first"),4,labels=labels)
    rows=[]
    for dim in specs:
      for key,g in d.groupby(dim,observed=True):
        rows.append({"维度":dim,"分组":str(key),"交易数":len(g),"最高涨幅中位数":g.maxGainBeforeRetail.median(),
          "触及20概率":(g.maxGainBeforeRetail>=.2).mean(),"触及50概率":(g.maxGainBeforeRetail>=.5).mean(),
          "退出收益中位数":g.netExitReturn.median(),"最大回撤中位数":g.maxDrawdownBeforeRetail.median()})
    industries=[]
    for key,g in d.groupby("industry",dropna=False):
      if len(g) >= 100:
        industries.append({"维度":"行业（样本≥100）","分组":str(key),"交易数":len(g),
          "最高涨幅中位数":g.maxGainBeforeRetail.median(),"触及20概率":(g.maxGainBeforeRetail>=.2).mean(),
          "触及50概率":(g.maxGainBeforeRetail>=.5).mean(),"退出收益中位数":g.netExitReturn.median(),
          "最大回撤中位数":g.maxDrawdownBeforeRetail.median()})
    rows.extend(sorted(industries,key=lambda x:x["触及20概率"],reverse=True))
    return pd.DataFrame(rows)


def pct(x: float) -> str:
    return "—" if pd.isna(x) else f"{x:.1%}"


def html_table(df: pd.DataFrame, pct_cols=(), max_rows=None) -> str:
    x=df.head(max_rows).copy() if max_rows else df.copy()
    for col in pct_cols:
        if col in x: x[col]=x[col].map(pct)
    return x.to_html(index=False,border=0,classes="data",escape=True)


def bar_svg(labels,values,title,color="#176B87") -> str:
    width,height=760,300; left,bottom,top=70,55,35; plot_h=height-bottom-top
    vmax=max(values) if len(values) and max(values)>0 else 1
    bw=(width-left-25)/max(len(values),1)
    parts=[f"<svg viewBox='0 0 {width} {height}' role='img'><text x='{left}' y='20' font-weight='700'>{title}</text>"]
    parts.append(f"<line x1='{left}' y1='{top}' x2='{left}' y2='{height-bottom}' stroke='#9aa7b2'/><line x1='{left}' y1='{height-bottom}' x2='{width-15}' y2='{height-bottom}' stroke='#9aa7b2'/>")
    for i,(lab,val) in enumerate(zip(labels,values)):
        x=left+i*bw+bw*.12; h=plot_h*val/vmax; y=height-bottom-h
        parts.append(f"<rect x='{x:.1f}' y='{y:.1f}' width='{bw*.76:.1f}' height='{h:.1f}' rx='3' fill='{color}'/><text x='{x+bw*.38:.1f}' y='{y-5:.1f}' text-anchor='middle' font-size='11'>{val:.1%}</text><text x='{x+bw*.38:.1f}' y='{height-bottom+18}' text-anchor='middle' font-size='11'>{lab}</text>")
    return "".join(parts)+"</svg>"


def report(snapshot_id: str, manifest: dict, flow_meta: dict, trades: pd.DataFrame,
           summary: pd.DataFrame, annual: pd.DataFrame, subgroups: pd.DataFrame) -> str:
    p=trades[(trades["sample"]=="恐高型主策略")&(trades.sellScoreThreshold==PRIMARY_SCORE)].copy()
    closed=p[p.censored==0]; s=summary[(summary["样本"]=="恐高型主策略")&(summary["卖点分数"]==PRIMARY_SCORE)].iloc[0]
    bins=[-1e9,0,.1,.2,.3,.5,1,2,1e9]; labs=["<0","0–10%","10–20%","20–30%","30–50%","50–100%","1–2倍",">2倍"]
    cats=pd.cut(p.maxGainBeforeRetail,bins=bins,labels=labs,right=False)
    dist=cats.value_counts(normalize=True).reindex(labs,fill_value=0)
    chart=bar_svg(labs,dist.values,"买入至散户入场前的最高涨幅分布")
    top=p.sort_values("maxGainBeforeRetail",ascending=False)[["symbol","name","signalDate","entryDate","exitSignalDate","exitDate","maxGainDate","maxGainBeforeRetail","netExitReturn","holdingSessions","censored"]].head(40)
    generated=datetime.now().astimezone().isoformat(timespec="seconds")
    return f"""<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>恐高型买点与散户入场卖点研究</title><style>
body{{font-family:Inter,'Microsoft YaHei',sans-serif;background:#f3f6f8;color:#17232d;margin:0}}main{{max-width:1200px;margin:auto;padding:38px 24px 80px}}h1{{font-size:32px;margin:0}}h2{{margin-top:40px;border-left:4px solid #176B87;padding-left:12px}}h3{{margin-top:28px}}.meta{{color:#697984;margin:8px 0 24px}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}.card{{background:#fff;padding:18px;border-radius:11px;box-shadow:0 2px 12px #10203012}}.v{{font-size:32px;font-weight:760;color:#0E6655;margin:5px 0}}.s{{font-size:12px;color:#70808c}}.callout{{background:#e8f3f6;border-radius:10px;padding:18px 20px;line-height:1.75;margin:24px 0}}.warning{{background:#fff3dc;border-radius:10px;padding:16px 20px;line-height:1.7}}table.data{{border-collapse:collapse;width:100%;background:white;font-size:12.5px}}th,td{{padding:8px 9px;border-bottom:1px solid #e2e8ec;text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}th{{background:#e8eef2;position:sticky;top:0}}.scroll{{overflow:auto;max-height:600px}}.chart{{background:#fff;border-radius:10px;padding:12px;margin-top:15px}}li{{margin:7px 0}}code{{background:#e9eef1;padding:2px 5px;border-radius:4px}}@media(max-width:850px){{.cards{{grid-template-columns:1fr 1fr}}}}</style></head><body><main>
<h1>“散户恐高”买点，等到散户大举入场再卖</h1><div class='meta'>A股历史事件研究 · {START}—{END} · 报告生成 {generated}</div>
<div class='cards'><div class='card'><div>非重叠交易</div><div class='v'>{len(p):,}</div><div class='s'>同一股票持仓中不重复开仓</div></div><div class='card'><div>散户入场前最高涨幅中位数</div><div class='v'>{pct(s['最高涨幅中位数'])}</div><div class='s'>盘中最高价；不是可自动兑现收益</div></div><div class='card'><div>触及 +20% 概率</div><div class='v'>{pct(s['最高涨幅>=20%'])}</div><div class='s'>买入后至卖点信号日</div></div><div class='card'><div>次日开盘退出胜率</div><div class='v'>{pct(s['退出胜率'])}</div><div class='s'>已出现卖点样本，扣双边成本</div></div></div>
<div class='callout'><strong>结论：</strong>“恐高型”必须同时包含价格处于强趋势高位和散户资金尚未追入。主策略从信号后次日开盘买入，等待散户参与评分达到75分后次日开盘卖出。历史上买入至卖点前的最高涨幅中位数为 <strong>{pct(s['最高涨幅中位数'])}</strong>，触及20%的概率为 <strong>{pct(s['最高涨幅>=20%'])}</strong>；但真正按卖点退出的净收益中位数为 <strong>{pct(s['退出收益中位数'])}</strong>，最高点到退出的回吐中位数为 <strong>{pct(s['从最高点回吐中位数'])}</strong>。这一区别决定了“最高能涨多少”不能等同于策略收益。</div>
<h2>无前视定义</h2><h3>买点：恐高但趋势未衰竭</h3><ul><li>MA5 &gt; MA10 &gt; MA20 &gt; MA30，且四条均线均高于5个交易日前。</li><li>收盘价距离60日最高收盘价不超过2%，高于MA20约8%–20%，过去20日涨幅10%–40%。</li><li>近3日小单资金强度均值≤0，主力资金强度不弱于小单；当日成交量≤20日均量1.5倍。</li><li>排除ST、上市不足365天、低价及低流动性股票，并排除信号日大涨和次日接近涨停而不可买的情况。</li></ul>
<h3>卖点：散户大举入场</h3><p>参与评分 = 小单资金横截面排名35% + 换手热度20% + 放量15% + 5日价格加速15% + 新高/MA20乖离15%。评分≥75，同时近3日至少2日小单净流入、3日小单合计为正、量比≥1.2，才确认卖点；T日收盘确认，T+1开盘卖出。</p>
<div class='warning'><strong>持有期不固定：</strong>没有人为设置20/60日退出。若到样本末日仍未出现卖点，标记为右删失；其最高涨幅只统计到数据末日，退出收益不进入胜率。主规格删失率为 {pct(s['删失率'])}。</div>
<h2>核心结果与对照</h2><div class='scroll'>{html_table(summary,['删失率','最高涨幅中位数','最高涨幅均值','最高涨幅>=10%','最高涨幅>=20%','最高涨幅>=50%','最高涨幅>=100%','退出胜率','退出收益中位数','退出收益均值','最大回撤中位数','从最高点回吐中位数','卖点资金背离率'])}</div>
<p>“仅趋势近新高对照”保留相同趋势、位置与动量条件，但不要求小单流出、主力强于小单或量能克制。两者差异用于判断“散户不敢追高”本身有没有增量信息。</p>
<div class='chart'>{chart}</div>
<h2>按年份稳定性</h2><div class='scroll'>{html_table(annual,['最高涨幅中位数','触及20概率','触及50概率','删失率','退出收益中位数'])}</div>
<h2>什么样的恐高买点更有效</h2><div class='scroll'>{html_table(subgroups,['最高涨幅中位数','触及20概率','触及50概率','退出收益中位数','最大回撤中位数'])}</div>
<h2>最高涨幅最大的40笔交易</h2><div class='scroll'>{html_table(top,['maxGainBeforeRetail','netExitReturn'])}</div>
<h2>风险与解释边界</h2><ul><li><strong>最高涨幅存在事后信息：</strong>它用于回答上涨空间，不是可成交的卖出规则；应重点同时看次日开盘退出收益。</li><li><strong>小单不等于真实散户账户：</strong>资金流由行情商按成交单大小分类，拆单会造成误判，本研究只能称“散户参与代理”。</li><li><strong>卖点可能迟到：</strong>评分需要小单流入、放量和价格加速共同确认，必然牺牲部分顶部收益；回吐是规则代价而非计算错误。</li><li><strong>价格限制：</strong>日线无法完整模拟涨停排队和盘中冲击，虽排除了次日接近涨停的买点，仍可能高估可成交性。</li><li><strong>删失与制度变化：</strong>未出现卖点的持仓不参与退出胜率；创业板涨跌停制度、市场风格和资金流供应商口径会随时间变化。</li></ul>
<h2>数据审计</h2><ul><li>研究快照：{snapshot_id}，行情截至 {manifest.get('maxDate')}。</li><li>资金流：{flow_meta['minDate']}—{flow_meta['maxDate']}，{flow_meta['dateCount']:,}个完整交易日，平均覆盖率{flow_meta['avgCoveragePct']:.2f}%，最低{flow_meta['minCoveragePct']:.2f}%。</li><li>复权价格由每日 <code>close / previousClose</code> 链式构造；信号只使用当日及之前信息，交易统一延迟到次日开盘。</li><li>交易成本：买入{BUY_COST:.2%}、卖出{SELL_COST:.2%}。</li></ul>
</main></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True,exist_ok=True)
    snapshot_id,snap,manifest=snapshot()
    con=duckdb.connect(str(DB_PATH)); con.execute("SET threads=6; SET memory_limit='6GB'; SET preserve_insertion_order=false")
    flow_meta=build_flow_table(con)
    build_panel(con,snap)
    trades=run_variants(con)
    summary=summarize(trades)
    primary=trades[(trades["sample"]=="恐高型主策略")&(trades.sellScoreThreshold==PRIMARY_SCORE)].copy()
    annual=annual_stats(primary); subgroups=subgroup_stats(primary)
    trades.to_csv(OUT/"trade_details_all_variants.csv",index=False,encoding="utf-8-sig")
    primary.to_csv(OUT/"primary_trade_details.csv",index=False,encoding="utf-8-sig")
    summary.to_csv(OUT/"summary.csv",index=False,encoding="utf-8-sig")
    annual.to_csv(OUT/"annual_stats.csv",index=False,encoding="utf-8-sig")
    subgroups.to_csv(OUT/"subgroup_stats.csv",index=False,encoding="utf-8-sig")
    (OUT/"report.html").write_text(report(snapshot_id,manifest,flow_meta,trades,summary,annual,subgroups),encoding="utf-8")
    meta={"snapshotId":snapshot_id,"period":[START,END],"flow":flow_meta,"primaryScore":PRIMARY_SCORE,
      "primaryTrades":len(primary),"primaryClosed":int((primary.censored==0).sum()),"generatedAt":datetime.now().astimezone().isoformat()}
    (OUT/"run_metadata.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")
    con.close(); DB_PATH.unlink(missing_ok=True)
    print(json.dumps(meta,ensure_ascii=False,indent=2));print(summary.to_string(index=False))


if __name__=="__main__":
    main()
