#!/usr/bin/env python3
"""Phase-2 diagnostics for the retail-height-fear event study.

Uses only point-in-time local snapshots and the phase-1 trade files.  The script
focuses on exit latency, right censoring, time attribution, matched controls,
market regimes, tradability sensitivity, and multiple-testing diagnostics.
"""

from __future__ import annotations

import bisect
import json
import math
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "tmp_output" / "retail_height_fear_research"
OUT = ROOT / "tmp_output" / "retail_height_fear_followup"
DB = OUT / "followup.duckdb"
VENDOR = ROOT / "tmp_output" / "thirteen_factor_experiment" / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from scipy.stats import chi2_contingency, kruskal  # noqa: E402
from sklearn.compose import ColumnTransformer  # noqa: E402
from sklearn.impute import SimpleImputer  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import OneHotEncoder, StandardScaler  # noqa: E402

END = pd.Timestamp("2026-08-10")
BUY_COST = 0.0008
SELL_COST = 0.0013


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def snapshot() -> tuple[str, Path, dict]:
    ptr = json.loads((ROOT / "server/data/research-snapshots/current.json").read_text(encoding="utf-8"))
    path = ROOT / "server/data/research-snapshots" / ptr["snapshotId"]
    return ptr["snapshotId"], path, json.loads((path / "manifest.json").read_text(encoding="utf-8"))


def qp(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


def net_return(exit_rel: pd.Series | np.ndarray, extra_bps_per_side: float = 0) -> pd.Series:
    extra = extra_bps_per_side / 10000
    return pd.Series(exit_rel) * (1 - SELL_COST - extra) / (1 + BUY_COST + extra) - 1


def build_paths(con: duckdb.DuckDBPyConnection, snap: Path, primary: pd.DataFrame) -> pd.DataFrame:
    existing = {row[0] for row in con.execute("SHOW TABLES").fetchall()}
    if "paths" in existing:
        log("复用上次已构建的逐笔持仓路径...")
        paths = con.execute("SELECT * FROM paths ORDER BY tradeId,tradeDate").fetchdf()
        for col in ["tradeDate", "entryDate", "signalDate", "exitSignalDate"]:
            paths[col] = pd.to_datetime(paths[col])
        return paths
    bars = qp(snap / "bars/**/*.parquet")
    instruments = primary[["instrumentKey"]].drop_duplicates().astype({"instrumentKey": "int64"})
    trade_cols = ["tradeId", "instrumentKey", "symbol", "name", "industry", "signalDate", "entryDate", "exitSignalDate"]
    entries = primary[trade_cols].copy()
    for col in ["signalDate", "entryDate", "exitSignalDate"]:
        entries[col] = pd.to_datetime(entries[col])
    con.register("wanted_instruments", instruments)
    con.register("entries", entries)
    log("构建主策略股票的无前视复权日线与逐笔持仓路径...")
    con.execute(f"""
      CREATE OR REPLACE TABLE prices AS
      WITH all_bars AS (
        SELECT * EXCLUDE(year) FROM read_parquet('{bars}', hive_partitioning=true)
      ), raw AS (
        SELECT b.instrumentKey,b.tradeDate,b.open,b.high,b.low,b.close,b.previousClose,b.volume
        FROM all_bars b SEMI JOIN wanted_instruments w USING(instrumentKey)
        WHERE b.tradeDate BETWEEN DATE '2015-01-05' AND DATE '2026-08-10'
          AND b.close>0 AND b.previousClose>0
      ), chained AS (
        SELECT *,EXP(SUM(LN(close/previousClose)) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate)) gClose
        FROM raw
      ), px AS (
        SELECT *,gClose*open/close gOpen,gClose*high/close gHigh,gClose*low/close gLow,
          AVG(volume) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) volume20,
          MAX(gClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) closeHigh20,
          LAG(gClose,5) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) closeLag5
        FROM chained
      )
      SELECT *,LEAD(gOpen) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) nextGOpen,
        volume/NULLIF(volume20,0) volumeRatio,gClose/NULLIF(closeLag5,0)-1 ret5
      FROM px
    """)
    con.execute("""
      CREATE OR REPLACE TABLE paths AS
      WITH entry_px AS (
        SELECT e.*,p.gOpen entryGOpen
        FROM entries e JOIN prices p ON p.instrumentKey=e.instrumentKey AND p.tradeDate=e.entryDate
      ), joined AS (
        SELECT e.*,p.tradeDate,
          p.gOpen/e.entryGOpen openRel,p.gHigh/e.entryGOpen highRel,
          p.gLow/e.entryGOpen lowRel,p.gClose/e.entryGOpen closeRel,
          p.nextGOpen/e.entryGOpen nextOpenRel,p.volumeRatio,p.ret5,
          CASE WHEN p.gClose>=p.closeHigh20*0.999999 THEN 1 ELSE 0 END newHigh20
        FROM entry_px e JOIN prices p ON p.instrumentKey=e.instrumentKey
          AND p.tradeDate BETWEEN e.entryDate AND DATE '2026-08-10'
      )
      SELECT *,ROW_NUMBER() OVER (PARTITION BY tradeId ORDER BY tradeDate) pathSession,
        MAX(closeRel) OVER (PARTITION BY tradeId ORDER BY tradeDate ROWS UNBOUNDED PRECEDING) runClose,
        MAX(highRel) OVER (PARTITION BY tradeId ORDER BY tradeDate ROWS UNBOUNDED PRECEDING) runHigh,
        MIN(lowRel) OVER (PARTITION BY tradeId ORDER BY tradeDate ROWS UNBOUNDED PRECEDING) runLow,
        LAG(volumeRatio) OVER (PARTITION BY tradeId ORDER BY tradeDate) prevVolumeRatio
      FROM joined
    """)
    paths = con.execute("SELECT * FROM paths ORDER BY tradeId,tradeDate").fetchdf()
    for col in ["tradeDate", "entryDate", "signalDate", "exitSignalDate"]:
        paths[col] = pd.to_datetime(paths[col])
    return paths


def first_trigger(paths: pd.DataFrame, mask: pd.Series, label: str) -> pd.DataFrame:
    x = paths.loc[mask & paths.nextOpenRel.notna(), ["tradeId", "tradeDate", "pathSession", "nextOpenRel"]]
    x = x.sort_values(["tradeId", "pathSession"]).drop_duplicates("tradeId")
    return x.rename(columns={"tradeDate": "exitSignalDate2", "pathSession": "exitSession", "nextOpenRel": "exitRel"}).assign(exitType=label)


def choose_earliest(frames: list[pd.DataFrame]) -> pd.DataFrame:
    x = pd.concat(frames, ignore_index=True)
    order = {"trail": 0, "volume_divergence": 1, "original": 2, "time": 3, "terminal": 4}
    x["tie"] = x.exitType.map(lambda s: order.get(str(s).split(":")[0], 9))
    return x.sort_values(["tradeId", "exitSession", "tie"]).drop_duplicates("tradeId").drop(columns="tie")


def terminal_exits(paths: pd.DataFrame) -> pd.DataFrame:
    x = paths.sort_values(["tradeId", "pathSession"]).groupby("tradeId", as_index=False).tail(1)
    return x[["tradeId", "tradeDate", "pathSession", "closeRel"]].rename(
        columns={"tradeDate": "exitSignalDate2", "pathSession": "exitSession", "closeRel": "exitRel"}
    ).assign(exitType="terminal")


def original_exits(paths: pd.DataFrame) -> pd.DataFrame:
    x = paths[paths.tradeDate.eq(paths.exitSignalDate) & paths.nextOpenRel.notna()]
    return x[["tradeId", "tradeDate", "pathSession", "nextOpenRel"]].rename(
        columns={"tradeDate": "exitSignalDate2", "pathSession": "exitSession", "nextOpenRel": "exitRel"}
    ).assign(exitType="original")


def trail_exits(paths: pd.DataFrame, activation: float, width: float) -> pd.DataFrame:
    mask = ((paths.runClose - 1) >= activation) & ((paths.closeRel / paths.runClose - 1) <= -width)
    return first_trigger(paths, mask, f"trail:{activation:.0%}/{width:.0%}")


def time_exits(paths: pd.DataFrame, sessions: int) -> pd.DataFrame:
    return first_trigger(paths, paths.pathSession >= sessions, f"time:{sessions}")


def divergence_exits(paths: pd.DataFrame) -> pd.DataFrame:
    shrink_high = (paths.newHigh20 == 1) & (paths.volumeRatio <= .90) & (paths.runHigh >= 1.10)
    rollover = (paths.prevVolumeRatio >= 1.50) & (paths.volumeRatio <= paths.prevVolumeRatio * .75) & (paths.closeRel > 1.08)
    return first_trigger(paths, shrink_high | rollover, "volume_divergence")


def materialize_variant(paths: pd.DataFrame, exits: pd.DataFrame, name: str) -> pd.DataFrame:
    p = paths.merge(exits[["tradeId", "exitSignalDate2", "exitSession", "exitRel", "exitType"]], on="tradeId", how="inner")
    obs = p[p.pathSession <= p.exitSession]
    agg = obs.groupby("tradeId", as_index=False).agg(
        mfe=("highRel", lambda s: s.max()-1),
        mae=("lowRel", lambda s: s.min()-1),
        holdingSessions=("exitSession", "first"),
    )
    out = exits.merge(agg, on="tradeId", how="left")
    out["netReturn"] = net_return(out.exitRel).values
    out["capture"] = np.where(out.mfe > 0, out.netReturn / out.mfe, np.nan)
    out["variant"] = name
    return out


def exit_experiments(paths: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    terminal = terminal_exits(paths)
    original = original_exits(paths)
    base_all = choose_earliest([original, terminal])
    variants: dict[str, pd.DataFrame] = {"原评分75（删失按期末计价）": base_all}
    trails = {}
    for activation in [.15, .20]:
        for width in [.08, .10, .12, .15]:
            key = f"移动止盈 启动{activation:.0%}/回撤{width:.0%}"
            trails[(activation, width)] = trail_exits(paths, activation, width)
            variants[key] = choose_earliest([trails[(activation, width)], terminal])
            variants[f"原评分或移动止盈 {activation:.0%}/{width:.0%}"] = choose_earliest(
                [original, trails[(activation, width)], terminal]
            )
    divergence = divergence_exits(paths)
    variants["原评分或量价领先信号"] = choose_earliest([original, divergence, terminal])
    for n in [40, 60, 90, 120, 180, 250]:
        variants[f"原评分或时间兜底{n}日"] = choose_earliest([original, time_exits(paths, n), terminal])
    variants["三重兜底：原评分/20%-10%移动止盈/120日"] = choose_earliest(
        [original, trails[(.20, .10)], time_exits(paths, 120), terminal]
    )
    detail = pd.concat([materialize_variant(paths, ex, name) for name, ex in variants.items()], ignore_index=True)
    rows=[]
    for name,g in detail.groupby("variant", sort=False):
        rows.append({"退出规则":name,"交易数":len(g),"期末计价比例":g.exitType.eq("terminal").mean(),
          "胜率":(g.netReturn>0).mean(),"收益中位数":g.netReturn.median(),"收益均值":g.netReturn.mean(),
          "收益10分位":g.netReturn.quantile(.1),"实现收益>=20%":(g.netReturn>=.2).mean(),
          "退出前MFE中位数":g.mfe.median(),"MAE中位数":g.mae.median(),
          "回吐中位数":(g.mfe-g.netReturn).median(),"利润捕获率中位数":g.capture.replace([np.inf,-np.inf],np.nan).median(),
          "持有交易日中位数":g.holdingSessions.median(),"持有交易日90分位":g.holdingSessions.quantile(.9)})
    return detail, pd.DataFrame(rows)


def staged_exits(detail: pd.DataFrame) -> pd.DataFrame:
    pivot = detail.pivot(index="tradeId", columns="variant", values=["netReturn", "holdingSessions"])
    original = "原评分75（删失按期末计价）"
    schemes = {
      "50%移动15/10 + 50%原评分": [("原评分或移动止盈 15%/10%", .5),(original,.5)],
      "三段式：15/8、20/10、原评分": [("原评分或移动止盈 15%/8%",1/3),("原评分或移动止盈 20%/10%",1/3),(original,1/3)],
    }
    rows=[]
    for name,legs in schemes.items():
        ret=sum(pivot[("netReturn",leg)]*w for leg,w in legs)
        hold=sum(pivot[("holdingSessions",leg)]*w for leg,w in legs)
        rows.append({"分批规则":name,"交易数":ret.notna().sum(),"胜率":(ret>0).mean(),"收益中位数":ret.median(),
          "收益均值":ret.mean(),"收益10分位":ret.quantile(.1),"实现收益>=20%":(ret>=.2).mean(),
          "加权持有期中位数":hold.median()})
    return pd.DataFrame(rows)


def time_attribution(paths: pd.DataFrame) -> pd.DataFrame:
    boundary = choose_earliest([original_exits(paths), terminal_exits(paths)])[["tradeId","exitSession"]]
    bounded = paths.merge(boundary,on="tradeId",how="inner")
    bounded = bounded[bounded.pathSession <= bounded.exitSession]
    eventual = bounded.groupby("tradeId", as_index=False).agg(
      eventualMFE=("highRel",lambda s:s.max()-1),finalSession=("pathSession","max"))
    rows=[]
    for n in [5,10,20,30,40,60,90,120,180,250]:
        q=bounded[bounded.pathSession<=n].groupby("tradeId",as_index=False).agg(
          closeRel=("closeRel","last"),mfeN=("highRel",lambda s:s.max()-1),observed=("pathSession","max"))
        q=q.merge(eventual,on="tradeId")
        ratio=(q.mfeN.clip(lower=0)/q.eventualMFE.where(q.eventualMFE>0)).clip(upper=1)
        rows.append({"持仓交易日":n,"可观察交易数":len(q),"收盘收益中位数":net_return(q.closeRel).median(),
          "截至该日MFE中位数":q.mfeN.median(),"占最终MFE比例中位数":ratio.median(),
          "已触及20%比例":(q.mfeN>=.2).mean()})
    return pd.DataFrame(rows)


def censor_and_duration(primary: pd.DataFrame, paths: pd.DataFrame) -> tuple[pd.DataFrame,pd.DataFrame]:
    end_rows=paths.sort_values(["tradeId","pathSession"]).groupby("tradeId",as_index=False).tail(1)
    end_rows=end_rows[["tradeId","closeRel","pathSession","runHigh","runLow"]]
    d=primary.merge(end_rows,on="tradeId",how="left")
    d["terminalReturn"]=net_return(d.closeRel).values
    d["analysisReturn"]=np.where(d.censored.eq(1),d.terminalReturn,d.netExitReturn)
    d["analysisMFE"]=np.where(d.censored.eq(1),d.runHigh-1,d.maxGainBeforeRetail)
    d["analysisMAE"]=np.where(d.censored.eq(1),d.runLow-1,d.maxDrawdownBeforeRetail)
    d["analysisSessions"]=np.where(d.censored.eq(1),d.pathSession,d.holdingSessions)
    d["终态"] = np.where(d.censored.eq(1),"原报告删失","已出现评分卖点")
    fate=d.groupby("终态").agg(交易数=("tradeId","size"),分析收益中位数=("analysisReturn","median"),
      分析胜率=("analysisReturn",lambda s:(s>0).mean()),观察期MFE中位数=("analysisMFE","median"),
      观察期MAE中位数=("analysisMAE","median"),观察期中位数=("analysisSessions","median")).reset_index()
    closed=d[d.censored.eq(0)].copy()
    closed["持有期分组"]=pd.cut(closed.holdingSessions,[0,60,120,250,500,np.inf],labels=["≤60","61–120","121–250","251–500",">500"])
    duration=closed.groupby("持有期分组",observed=True).agg(**{
      "交易数":("tradeId","size"),"原退出收益中位数":("netExitReturn","median"),
      "MFE中位数":("maxGainBeforeRetail","median"),"市值中位数":("totalMarketCap","median"),
      "20日动量中位数":("ret20","median"),"换手率中位数":("turnoverRatePct","median")}).reset_index()
    return fate,duration


def psm_analysis(all_trades: pd.DataFrame) -> tuple[pd.DataFrame,pd.DataFrame,dict]:
    x=all_trades[all_trades.sellScoreThreshold.eq(75)].copy()
    main=x[x["sample"].eq("恐高型主策略")].copy(); control=x[x["sample"].eq("仅趋势近新高对照")].copy()
    keys=set(zip(main.instrumentKey.astype(str),main.signalDate.astype(str)))
    control=control[[ (str(i),str(d)) not in keys for i,d in zip(control.instrumentKey,control.signalDate) ]].copy()
    # The relaxed sample can contain a height-fear-qualified day that was skipped
    # by the main sample's sequential de-duplication.  Remove all such rows so the
    # matched controls are genuinely untreated, not merely absent from main trades.
    fear_like=(control.small3<=0) & (control.main3>=control.small3) & (control.volumeRatio<=1.5)
    control=control[~fear_like].copy()
    main["treated"]=1; control["treated"]=0
    pool=pd.concat([main,control],ignore_index=True)
    pool["year"]=pd.to_datetime(pool.signalDate).dt.year.astype(str)
    num=["totalMarketCap","ret20","distanceMa20","turnoverRatePct","volumeRatio"]
    pool["logMcap"]=np.log(pool.totalMarketCap.clip(lower=1)); num[0]="logMcap"
    cat=["industry","year"]
    pre=ColumnTransformer([("num",make_pipeline(SimpleImputer(strategy="median"),StandardScaler()),num),
      ("cat",make_pipeline(SimpleImputer(strategy="most_frequent"),OneHotEncoder(handle_unknown="ignore")),cat)])
    model=make_pipeline(pre,LogisticRegression(max_iter=1000,C=.5))
    model.fit(pool[num+cat],pool.treated)
    pool["propensity"]=model.predict_proba(pool[num+cat])[:,1]
    treated=pool[pool.treated.eq(1)].copy(); controls=pool[pool.treated.eq(0)].copy()
    pairs=[]
    for (year,industry),tg in treated.groupby(["year","industry"],dropna=False):
        cg=controls[(controls.year.eq(year)) & (controls.industry.fillna("NA").eq("NA" if pd.isna(industry) else industry))].sort_values("propensity")
        available=list(zip(cg.propensity.tolist(),cg.index.tolist()))
        for ti,tr in tg.sample(frac=1,random_state=20260816).iterrows():
            if not available: break
            vals=[a[0] for a in available]; pos=bisect.bisect_left(vals,tr.propensity)
            cand=[j for j in [pos-1,pos] if 0<=j<len(available)]
            best=min(cand,key=lambda j:abs(available[j][0]-tr.propensity))
            cp,ci=available[best]
            if abs(cp-tr.propensity)<=.05:
                pairs.append((ti,ci,abs(cp-tr.propensity))); available.pop(best)
    pairs_df=pd.DataFrame(pairs,columns=["treatedIndex","controlIndex","propensityDistance"])
    t=pool.loc[pairs_df.treatedIndex].reset_index(drop=True); c=pool.loc[pairs_df.controlIndex].reset_index(drop=True)
    outcome=pd.DataFrame({"指标":["触及20%","MFE中位数","退出收益中位数","退出胜率"],
      "恐高组":[(t.maxGainBeforeRetail>=.2).mean(),t.maxGainBeforeRetail.median(),t.netExitReturn.median(),(t.netExitReturn.dropna()>0).mean()],
      "匹配对照组":[(c.maxGainBeforeRetail>=.2).mean(),c.maxGainBeforeRetail.median(),c.netExitReturn.median(),(c.netExitReturn.dropna()>0).mean()]})
    outcome["差值"]=outcome["恐高组"]-outcome["匹配对照组"]
    bal=[]
    for col in num:
        pre_smd=(treated[col].mean()-controls[col].mean())/pool[col].std()
        post_smd=(t[col].mean()-c[col].mean())/pd.concat([t[col],c[col]]).std()
        bal.append({"协变量":col,"匹配前SMD":pre_smd,"匹配后SMD":post_smd})
    rng=np.random.default_rng(20260816); diffs=[]
    pair_month=pd.to_datetime(t.signalDate).dt.to_period("M").astype(str)
    months=np.array(sorted(pair_month.unique()))
    y1=(t.maxGainBeforeRetail>=.2).astype(float).to_numpy(); y0=(c.maxGainBeforeRetail>=.2).astype(float).to_numpy()
    for _ in range(2000):
        picked=rng.choice(months,size=len(months),replace=True)
        idx=np.concatenate([np.where(pair_month.to_numpy()==m)[0] for m in picked])
        diffs.append((y1[idx]-y0[idx]).mean())
    meta={"pairs":len(pairs_df),"caliper":.05,"p20Lift":float((y1-y0).mean()),
      "blockBootstrap95":[float(np.quantile(diffs,.025)),float(np.quantile(diffs,.975))],
      "meanPropensityDistance":float(pairs_df.propensityDistance.mean())}
    return outcome,pd.DataFrame(bal),meta


def market_regimes(con: duckdb.DuckDBPyConnection, snap: Path, primary: pd.DataFrame) -> pd.DataFrame:
    idx=qp(snap/"index_bars/data.parquet")
    con.register("primary_regime",primary[["tradeId","signalDate","maxGainBeforeRetail","netExitReturn"]].assign(signalDate=lambda d:pd.to_datetime(d.signalDate)))
    return con.execute(f"""
      WITH i0 AS (
        SELECT tradeDate,close,LAG(close) OVER (ORDER BY tradeDate) closeLag1
        FROM read_parquet('{idx}') WHERE indexCode='000985'
      ), x AS (
        SELECT tradeDate,close,
          AVG(close) OVER (ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) ma20,
          AVG(close) OVER (ORDER BY tradeDate ROWS BETWEEN 59 PRECEDING AND CURRENT ROW) ma60,
          close/NULLIF(closeLag1,0)-1 ret1
        FROM i0
      ), y AS (
        SELECT *,STDDEV_SAMP(ret1) OVER (ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) vol20,
          LAG(ma20,5) OVER (ORDER BY tradeDate) ma20lag5
        FROM x
      ), z0 AS (
        SELECT *,
          QUANTILE_CONT(vol20,.75) OVER (ORDER BY tradeDate ROWS BETWEEN 251 PRECEDING AND CURRENT ROW) volQ75
        FROM y
      ), z AS (
        SELECT *,CASE WHEN close>ma60 AND ma20>ma20lag5 THEN '上行' WHEN close<ma60 AND ma20<ma20lag5 THEN '下行' ELSE '震荡' END marketTrend,
          CASE WHEN vol20>=volQ75 THEN '高波动' ELSE '常态波动' END volRegime FROM z0
      )
      SELECT marketTrend,volRegime,COUNT(*) 交易数,MEDIAN(p.maxGainBeforeRetail) MFE中位数,
        AVG(CASE WHEN p.maxGainBeforeRetail>=.2 THEN 1 ELSE 0 END) 触及20概率,
        MEDIAN(p.netExitReturn) 退出收益中位数,
        AVG(CASE WHEN p.netExitReturn IS NULL THEN NULL WHEN p.netExitReturn>0 THEN 1 ELSE 0 END) 退出胜率
      FROM primary_regime p JOIN z ON z.tradeDate=p.signalDate GROUP BY ALL ORDER BY marketTrend,volRegime
    """).fetchdf()


def fdr_tests(primary: pd.DataFrame) -> pd.DataFrame:
    specs={"市值":"totalMarketCap","量比":"volumeRatio","换手率":"turnoverRatePct","20日动量":"ret20",
      "MA20乖离":"distanceMa20","主力资金":"main3","小单资金":"small3"}
    rows=[]
    for name,col in specs.items():
        q=pd.qcut(primary[col].rank(method="first"),4,labels=False)
        tab=pd.crosstab(q,primary.maxGainBeforeRetail>=.2)
        p=chi2_contingency(tab)[1]
        groups=[primary.loc[q.eq(i),"maxGainBeforeRetail"].dropna() for i in range(4)]
        rows += [{"检验":f"{name}：触及20%","原始p":p},{"检验":f"{name}：MFE分布","原始p":kruskal(*groups).pvalue}]
    industry=primary.industry.fillna("未知")
    keep=industry.value_counts(); keep=keep[keep>=100].index; z=primary[industry.isin(keep)]
    rows.append({"检验":"行业：触及20%","原始p":chi2_contingency(pd.crosstab(z.industry,z.maxGainBeforeRetail>=.2))[1]})
    out=pd.DataFrame(rows).sort_values("原始p").reset_index(drop=True)
    m=len(out); out["BH-FDR q值"]=(out["原始p"]*m/(np.arange(m)+1)).iloc[::-1].cummin().iloc[::-1].clip(upper=1)
    out["Bonferroni p"]=(out["原始p"]*m).clip(upper=1)
    return out


def sell_weight_diagnostic(primary: pd.DataFrame, paths: pd.DataFrame) -> tuple[pd.DataFrame,dict]:
    closed=primary[primary.censored.eq(0)].copy()
    features=["exitSmallFlowRank","exitVolumeRatio","exitTurnoverPct","exitRet5","exitDistanceMa20"]
    locate=paths[["tradeId","tradeDate","pathSession","closeRel"]].merge(
      closed[["tradeId","exitSignalDate"]],on="tradeId",how="inner")
    sess=locate[locate.tradeDate.eq(locate.exitSignalDate)][["tradeId","pathSession","closeRel"]].rename(columns={"pathSession":"s0","closeRel":"c0"})
    fut=locate.merge(sess,on="tradeId"); fut=fut[fut.pathSession>=fut.s0+20].sort_values(["tradeId","pathSession"]).drop_duplicates("tradeId")
    fut["future20"]=fut.closeRel/fut.c0-1
    d=closed.merge(fut[["tradeId","future20"]],on="tradeId").dropna(subset=features+["future20"])
    d["down20"]=(d.future20<0).astype(int); d["year"]=pd.to_datetime(d.exitSignalDate).dt.year
    train=d[d.year<=2022]; test=d[d.year>=2023]
    pipe=make_pipeline(SimpleImputer(strategy="median"),StandardScaler(),LogisticRegression(max_iter=1000))
    pipe.fit(train[features],train.down20); prob=pipe.predict_proba(test[features])[:,1]
    coef=pipe[-1].coef_[0]
    out=pd.DataFrame({"卖点子项":features,"标准化Logit系数":coef}).sort_values("标准化Logit系数",ascending=False)
    meta={"trainN":len(train),"testN":len(test),"testAUC":float(roc_auc_score(test.down20,prob)),
      "testDownRate":float(test.down20.mean()),"target":"卖点后20个交易日收盘收益<0"}
    return out,meta


def slippage(detail: pd.DataFrame) -> pd.DataFrame:
    names=["原评分75（删失按期末计价）","原评分或移动止盈 20%/8%"]
    rows=[]
    for name in names:
        g=detail[detail.variant.eq(name)]
        for bps in [0,5,10,20]:
            r=net_return(g.exitRel,bps)
            rows.append({"规则":name,"单边额外滑点bps":bps,"胜率":(r>0).mean(),"收益中位数":r.median(),"收益均值":r.mean()})
    return pd.DataFrame(rows)


def pct(x) -> str:
    return "—" if pd.isna(x) else f"{x:.1%}"


def table(df: pd.DataFrame, pct_cols=(), rows=None) -> str:
    x=df.head(rows).copy() if rows else df.copy()
    for c in pct_cols:
        if c in x: x[c]=x[c].map(pct)
    return x.to_html(index=False,border=0,classes="data",escape=True)


def report(meta: dict, exit_summary: pd.DataFrame, staged: pd.DataFrame, time_df: pd.DataFrame,
           fate: pd.DataFrame, duration: pd.DataFrame, psm: pd.DataFrame, balance: pd.DataFrame,
           psm_meta: dict, regimes: pd.DataFrame, tests: pd.DataFrame, weights: pd.DataFrame,
           weight_meta: dict, slip: pd.DataFrame) -> str:
    base=exit_summary[exit_summary["退出规则"].eq("原评分75（删失按期末计价）")].iloc[0]
    rec=exit_summary[exit_summary["退出规则"].eq("原评分或移动止盈 20%/8%")].iloc[0]
    lift=psm.loc[psm["指标"].eq("触及20%"),"差值"].iloc[0]
    ci=psm_meta["blockBootstrap95"]
    generated=datetime.now().astimezone().isoformat(timespec="seconds")
    pct_exit=["期末计价比例","胜率","收益中位数","收益均值","收益10分位","实现收益>=20%","退出前MFE中位数","MAE中位数","回吐中位数","利润捕获率中位数"]
    return f"""<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>恐高型策略第二阶段：卖点与稳健性</title><style>
body{{font-family:Inter,'Microsoft YaHei',sans-serif;background:#f3f6f8;color:#17232d;margin:0}}main{{max-width:1220px;margin:auto;padding:38px 24px 80px}}h1{{font-size:31px;margin:0}}h2{{margin-top:40px;border-left:4px solid #b45f06;padding-left:12px}}.meta{{color:#697984;margin:8px 0 24px}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}.card{{background:#fff;padding:18px;border-radius:11px;box-shadow:0 2px 12px #10203012}}.v{{font-size:29px;font-weight:760;color:#9c4f00;margin:5px 0}}.s{{font-size:12px;color:#70808c}}.callout{{background:#fff0db;border-radius:10px;padding:18px 20px;line-height:1.75;margin:24px 0}}.note{{background:#e8f3f6;border-radius:10px;padding:15px 19px;line-height:1.7}}table.data{{border-collapse:collapse;width:100%;background:white;font-size:12.5px}}th,td{{padding:8px 9px;border-bottom:1px solid #e2e8ec;text-align:right;white-space:nowrap}}th:first-child,td:first-child{{text-align:left}}th{{background:#e8eef2;position:sticky;top:0}}.scroll{{overflow:auto;max-height:620px}}li{{margin:7px 0}}@media(max-width:850px){{.cards{{grid-template-columns:1fr 1fr}}}}</style></head><body><main>
<h1>恐高型策略第二阶段：先解决卖点滞后</h1><div class='meta'>样本沿用第一阶段 · 2016-08-12—2026-08-10 · {generated}</div>
<div class='cards'><div class='card'><div>原规则全样本收益中位数</div><div class='v'>{pct(base['收益中位数'])}</div><div class='s'>删失仓位按期末收盘计价</div></div><div class='card'><div>平衡候选收益中位数</div><div class='v'>{pct(rec['收益中位数'])}</div><div class='s'>原评分或20%启动/8%回撤先到先出</div></div><div class='card'><div>平衡候选持有期中位数</div><div class='v'>{rec['持有交易日中位数']:.0f}日</div><div class='s'>原规则为 {base['持有交易日中位数']:.0f} 日</div></div><div class='card'><div>PSM后恐高命中率增量</div><div class='v'>{pct(lift)}</div><div class='s'>月份块bootstrap 95%区间 {pct(ci[0])}—{pct(ci[1])}</div></div></div>
<div class='callout'><strong>核心判断：</strong>第一阶段的62.7%退出胜率剔除了11.2%未退出仓位；本报告统一把删失仓位按期末价格计价。动态止盈与时间兜底的目标不是追求更高的事后最高涨幅，而是缩短资本占用、减少峰值回吐，并检验结论是否仍能兑现。</div>
<h2>1. 卖点优化网格</h2><div class='scroll'>{table(exit_summary,pct_exit)}</div>
<p>移动止盈按每日收盘确认：达到启动收益后，收盘相对持仓以来最高收盘回撤指定宽度，下一交易日开盘退出。该定义不假设能按盘中最高价成交。</p>
<h2>2. 分批退出</h2><div class='scroll'>{table(staged,['胜率','收益中位数','收益均值','收益10分位','实现收益>=20%'])}</div>
<h2>3. 收益时间归因</h2><div class='scroll'>{table(time_df,['收盘收益中位数','截至该日MFE中位数','占最终MFE比例中位数','已触及20%比例'])}</div>
<h2>4. 删失与超长持有</h2><h3>删失仓位的期末命运</h3><div class='scroll'>{table(fate,['分析收益中位数','分析胜率','观察期MFE中位数','观察期MAE中位数'])}</div><p>删失组按样本末日收盘计价；已出现卖点组按实际次日开盘退出计价，两组都不再从统计分母中选择性剔除。</p><h3>原评分卖点的持有期分层</h3><div class='scroll'>{table(duration,['原退出收益中位数','MFE中位数','20日动量中位数'])}</div>
<h2>5. “恐高”条件的匹配样本增量</h2><div class='note'>同年份、同行业内一对一无放回匹配，共 {psm_meta['pairs']:,} 对；倾向分数卡钳 {psm_meta['caliper']:.2f}，按信号月份做2,000次块bootstrap。匹配只能处理可观察混杂，不能证明因果；退出收益与退出胜率仍只针对已出现评分卖点的配对样本。</div><div class='scroll'>{table(psm,['恐高组','匹配对照组','差值'])}</div><h3>协变量平衡</h3>{table(balance)}
<h2>6. 市场状态适配</h2><div class='scroll'>{table(regimes,['MFE中位数','触及20概率','退出收益中位数','退出胜率'])}</div><p>市场状态使用中证全指：指数相对MA60及MA20斜率定义上行/震荡/下行；波动状态采用仅含过去252日的滚动75%分位，不使用未来样本阈值。</p>
<h2>7. 卖点评分权重诊断</h2><div class='note'>仅在“已经触发75分卖点”的样本内，用2016–2022训练、2023以后测试，预测卖点后20日是否下跌。测试AUC={weight_meta['testAUC']:.3f}（测试样本 {weight_meta['testN']:,}）。若AUC接近0.5，说明经验权重不具备稳定排序力；该诊断不能直接替代全日面板上的重新回测。</div>{table(weights)}
<h2>8. 滑点敏感性</h2><div class='scroll'>{table(slip,['胜率','收益中位数','收益均值'])}</div>
<h2>9. 多重检验与相关性</h2><div class='scroll'>{table(tests)}</div><ul><li>同一股票持仓期间不重复开仓，但不同股票在同一天的信号仍受共同市场冲击；因此普通二项标准误偏小，本报告对匹配增量使用信号月份块bootstrap。</li><li>行业与分组探索同时报告BH-FDR和Bonferroni校正，统计显著不等于经济显著。</li></ul>
<h2>10. 数据边界</h2><ul><li>龙虎榜榜单本地历史仅83个交易日，机构席位明细主要集中于2026年；融资及北向没有完整point-in-time本地快照，因此不纳入十年检验。</li><li>量价背离规则属于本样本内探索，需在冻结参数后的留出期复验。</li><li>期权覆盖股票很少且本地无历史隐含波动率曲面，本阶段不做选择性小样本结论。</li><li>涨跌停排队、封单强度和真实冲击成本仍需分钟级盘口；这里只提供额外0/5/10/20bps单边滑点压力测试。</li><li>研究快照：{meta['snapshotId']}；脚本只使用信号时点已知数据，所有退出信号延迟至次日开盘执行。</li></ul>
</main></body></html>"""


def main() -> None:
    OUT.mkdir(parents=True,exist_ok=True)
    snapshot_id,snap,manifest=snapshot()
    primary=pd.read_csv(SOURCE/"primary_trade_details.csv")
    all_trades=pd.read_csv(SOURCE/"trade_details_all_variants.csv")
    for d in [primary,all_trades]:
        for c in ["signalDate","entryDate","exitSignalDate","exitDate","maxGainDate"]:
            if c in d: d[c]=pd.to_datetime(d[c],errors="coerce")
    con=duckdb.connect(str(DB)); con.execute("SET threads=6; SET memory_limit='6GB'; SET preserve_insertion_order=false")
    paths=build_paths(con,snap,primary)
    log(f"逐日路径 {len(paths):,} 行，开始退出规则网格...")
    detail,exit_summary=exit_experiments(paths)
    staged=staged_exits(detail); time_df=time_attribution(paths)
    fate,duration=censor_and_duration(primary,paths)
    log("执行匹配样本、市场状态与稳健性检验...")
    psm,balance,psm_meta=psm_analysis(all_trades)
    regimes=market_regimes(con,snap,primary)
    tests=fdr_tests(primary)
    weights,weight_meta=sell_weight_diagnostic(primary,paths)
    slip=slippage(detail)
    outputs={"exit_rule_summary.csv":exit_summary,"exit_rule_trade_details.csv":detail,
      "staged_exit_summary.csv":staged,"time_attribution.csv":time_df,"censor_fate.csv":fate,
      "duration_buckets.csv":duration,"psm_outcomes.csv":psm,"psm_balance.csv":balance,
      "market_regimes.csv":regimes,"multiple_testing.csv":tests,"sell_weight_diagnostic.csv":weights,
      "slippage_sensitivity.csv":slip}
    for name,df in outputs.items(): df.to_csv(OUT/name,index=False,encoding="utf-8-sig")
    meta={"snapshotId":snapshot_id,"sourceReport":str(SOURCE/"report.html"),"generatedAt":datetime.now().astimezone().isoformat(),
      "pathRows":len(paths),"primaryTrades":len(primary),"psm":psm_meta,"sellWeight":weight_meta,
      "dragonTigerCoverage":{"billboardTradeDates":83,"institutionalSeatHistory":"mainly 2026; excluded"}}
    (OUT/"run_metadata.json").write_text(json.dumps(meta,ensure_ascii=False,indent=2),encoding="utf-8")
    (OUT/"report.html").write_text(report(meta,exit_summary,staged,time_df,fate,duration,psm,balance,psm_meta,regimes,tests,weights,weight_meta,slip),encoding="utf-8")
    con.close()
    if DB.exists(): DB.unlink()
    log("完成："+str(OUT/"report.html"))
    print(exit_summary.to_json(force_ascii=True,orient="records"))


if __name__ == "__main__":
    main()
