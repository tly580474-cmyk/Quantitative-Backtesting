#!/usr/bin/env python3
"""Identify and profile A-share 'monster stock' episodes over the last ~10 years."""

from __future__ import annotations

import json
import os
import sys
import html as html_lib
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "tmp_output" / "monster_stock_research"
VENDOR = ROOT / "tmp_output" / "thirteen_factor_experiment" / "vendor"
if VENDOR.exists():
    sys.path.insert(0, str(VENDOR))

import duckdb  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

START = "2016-08-12"
END = "2026-08-11"
WARMUP = "2015-08-01"
CORE_GAIN = 3.0  # 4x from trough to peak within 120 sessions
MIN_GAIN = 2.0   # retain a broader 3x candidate pool


def load_snapshot() -> tuple[str, Path]:
    pointer = json.loads((ROOT / "server/data/research-snapshots/current.json").read_text(encoding="utf-8"))
    return pointer["snapshotId"], ROOT / "server/data/research-snapshots" / pointer["snapshotId"]


def qp(path: Path) -> str:
    return str(path).replace("\\", "/").replace("'", "''")


def build_local(snapshot: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    bars = qp(snapshot / "bars/**/*.parquet")
    fin = qp(snapshot / "financial_reports/data.parquet")
    con = duckdb.connect()
    con.execute("SET threads=6; SET memory_limit='6GB'; SET preserve_insertion_order=false")
    con.execute(f"""
      CREATE TEMP TABLE daily AS
      WITH raw AS (
        SELECT instrumentKey, market, symbol, name, industry, tradeDate,
          open, high, low, close, previousClose, volume, amount,
          turnoverRatePct, totalMarketCap, floatMarketCap,
          ROW_NUMBER() OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS stockSession
        FROM read_parquet('{bars}', hive_partitioning=true)
        WHERE tradeDate BETWEEN DATE '{WARMUP}' AND DATE '{END}'
          AND market IN ('SH','SZ')
          AND ((market='SH' AND regexp_matches(symbol,'^(600|601|603|605)[0-9]{{3}}$'))
            OR (market='SZ' AND regexp_matches(symbol,'^(000|001|002|003|300|301)[0-9]{{3}}$')))
          AND close > 0 AND previousClose > 0
      ), chained AS (
        SELECT *, EXP(SUM(LN(close/previousClose)) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate
        )) AS pxClose
        FROM raw
      ), base AS (
        SELECT *,
          LAG(pxClose) OVER w AS pxLag1,
          MIN(pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS low120,
          ARG_MIN(tradeDate, pxClose) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW) AS lowDate120,
          AVG(volume) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS volume20,
          AVG(amount) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS amount20,
          AVG(turnoverRatePct) OVER (PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS turnover20
        FROM chained WINDOW w AS (PARTITION BY instrumentKey ORDER BY tradeDate)
      )
      SELECT *, pxClose/low120-1 AS gainFromLow120,
        SUM(CASE WHEN pxClose/NULLIF(pxLag1,0)-1 >= .095 THEN 1 ELSE 0 END) OVER (
          PARTITION BY instrumentKey ORDER BY tradeDate ROWS BETWEEN 119 PRECEDING AND CURRENT ROW
        ) AS largeUpDays120,
        PERCENT_RANK() OVER (PARTITION BY tradeDate ORDER BY totalMarketCap) AS marketCapPct
      FROM base;

      CREATE TEMP TABLE qualifying AS
      SELECT *, LAG(tradeDate) OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS priorQualDate
      FROM daily
      WHERE tradeDate BETWEEN DATE '{START}' AND DATE '{END}'
        AND stockSession > 120 AND gainFromLow120 >= {MIN_GAIN} AND largeUpDays120 >= 3;

      CREATE TEMP TABLE grouped AS
      SELECT *, SUM(CASE WHEN priorQualDate IS NULL OR DATE_DIFF('day', priorQualDate, tradeDate) > 90 THEN 1 ELSE 0 END)
        OVER (PARTITION BY instrumentKey ORDER BY tradeDate) AS episodeGroup
      FROM qualifying;

      CREATE TEMP TABLE peaks AS
      SELECT * EXCLUDE(rnk) FROM (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY instrumentKey, episodeGroup ORDER BY gainFromLow120 DESC, tradeDate) AS rnk
        FROM grouped
      ) WHERE rnk=1;

      CREATE TEMP TABLE episodes0 AS
      SELECT ROW_NUMBER() OVER (ORDER BY p.tradeDate, p.instrumentKey) AS episodeId,
        p.instrumentKey, p.market, p.symbol, p.name, p.industry,
        p.lowDate120 AS startDate, p.tradeDate AS peakDate,
        p.gainFromLow120 AS intervalGain, p.stockSession AS peakSession,
        p.totalMarketCap AS peakTotalMarketCap, p.floatMarketCap AS peakFloatMarketCap,
        p.marketCapPct AS peakMarketCapPercentile, p.largeUpDays120, s.stockSession AS startStockSession,
        CASE WHEN p.gainFromLow120 >= {CORE_GAIN} THEN '核心妖股' ELSE '扩展候选' END AS tier
      FROM peaks p JOIN daily s ON s.instrumentKey=p.instrumentKey AND s.tradeDate=p.lowDate120
      WHERE s.stockSession > 120;

      CREATE TEMP TABLE episode_stats AS
      SELECT e.episodeId,
        COUNT(*) AS tradingDays,
        SUM(d.turnoverRatePct) AS cumulativeTurnoverPct,
        AVG(d.turnoverRatePct) AS avgTurnoverPct,
        MAX(d.turnoverRatePct) AS maxTurnoverPct,
        AVG(d.volume) AS avgVolume,
        AVG(d.amount) AS avgAmount,
        MAX(d.amount) AS maxAmount,
        SUM(CASE WHEN d.pxClose/NULLIF(d.pxLag1,0)-1 >= .095 THEN 1 ELSE 0 END) AS largeUpDays,
        SUM(CASE WHEN d.pxClose/NULLIF(d.pxLag1,0)-1 <= -.095 THEN 1 ELSE 0 END) AS largeDownDays
      FROM episodes0 e JOIN daily d ON d.instrumentKey=e.instrumentKey AND d.tradeDate BETWEEN e.startDate AND e.peakDate
      GROUP BY e.episodeId;

      CREATE TEMP TABLE start_stats AS
      SELECT e.episodeId, d.close AS startClose, d.totalMarketCap AS startTotalMarketCap,
        d.floatMarketCap AS startFloatMarketCap, d.marketCapPct AS startMarketCapPercentile,
        d.volume20 AS preVolume20, d.amount20 AS preAmount20, d.turnover20 AS preTurnover20
      FROM episodes0 e JOIN daily d ON d.instrumentKey=e.instrumentKey AND d.tradeDate=e.startDate;

      CREATE TEMP TABLE post_stats AS
      SELECT e.episodeId,
        MIN(d.pxClose/p.pxClose-1) AS post60MaxDrawdown,
        ARG_MIN(d.tradeDate, d.pxClose) AS post60TroughDate,
        ARG_MIN(d.close, d.pxClose) AS post60TroughClose
      FROM episodes0 e JOIN daily p ON p.instrumentKey=e.instrumentKey AND p.tradeDate=e.peakDate
      JOIN daily d ON d.instrumentKey=e.instrumentKey AND d.stockSession BETWEEN e.peakSession+1 AND e.peakSession+60
      GROUP BY e.episodeId;

      CREATE TEMP TABLE fin_clean AS
      SELECT * EXCLUDE(rn) FROM (
        SELECT instrumentKey, announcementDate, reportPeriod,
          COALESCE(roeWeightedPct, roePct, roeCalculatedPct) AS roePct,
          grossMarginPct, netMarginPct, debtToAssetsPct,
          operatingCashFlowToRevenuePct, revenueYoyPct, netProfitYoyPct,
          netProfitParent, totalRevenue,
          ROW_NUMBER() OVER (PARTITION BY instrumentKey, announcementDate ORDER BY reportPeriod DESC, updateFlag DESC, fetchedAt DESC) rn
        FROM read_parquet('{fin}') WHERE announcementDate IS NOT NULL
      ) WHERE rn=1;

      CREATE TEMP TABLE financial_asof AS
      SELECT e.episodeId, f.announcementDate AS financialAsOf, f.reportPeriod,
        f.roePct, f.grossMarginPct, f.netMarginPct, f.debtToAssetsPct,
        f.operatingCashFlowToRevenuePct, f.revenueYoyPct, f.netProfitYoyPct,
        f.netProfitParent, f.totalRevenue
      FROM episodes0 e ASOF LEFT JOIN fin_clean f
        ON e.instrumentKey=f.instrumentKey AND e.startDate>=f.announcementDate;

      CREATE TEMP TABLE episodes AS
      SELECT e.*, s.* EXCLUDE(episodeId), st.* EXCLUDE(episodeId), p.* EXCLUDE(episodeId), f.* EXCLUDE(episodeId),
        s.avgVolume/NULLIF(st.preVolume20,0) AS volumeExpansion,
        s.avgAmount/NULLIF(st.preAmount20,0) AS amountExpansion,
        DATE_DIFF('day', e.startDate, e.peakDate) AS calendarDays
      FROM episodes0 e JOIN episode_stats s USING(episodeId)
      JOIN start_stats st USING(episodeId)
      LEFT JOIN post_stats p USING(episodeId)
      LEFT JOIN financial_asof f USING(episodeId);
    """)
    episodes = con.execute("SELECT * FROM episodes ORDER BY intervalGain DESC").df()
    core = episodes[episodes["tier"] == "核心妖股"].copy()
    # A readable representative list: top 10 core episodes per peak year.
    core["peakYear"] = pd.to_datetime(core["peakDate"]).dt.year
    core["annualRank"] = core.groupby("peakYear")["intervalGain"].rank(method="first", ascending=False).astype(int)
    shortlist = core[core["annualRank"] <= 10].sort_values(["peakYear", "annualRank"])
    daily = con.execute(f"""
      SELECT e.episodeId, d.instrumentKey, d.symbol, d.name, d.tradeDate, d.open, d.high, d.low, d.close,
        d.previousClose, d.volume, d.amount, d.turnoverRatePct, d.totalMarketCap, d.floatMarketCap,
        d.pxClose, d.pxClose/NULLIF(d.pxLag1,0)-1 AS dailyReturn
      FROM episodes0 e JOIN daily d ON d.instrumentKey=e.instrumentKey
       AND d.tradeDate BETWEEN e.startDate AND e.peakDate
      WHERE e.intervalGain >= {CORE_GAIN}
      ORDER BY e.episodeId,d.tradeDate
    """).df()
    # Aggregate characteristics versus broad market context.
    comparison = con.execute(f"""
      WITH event AS (SELECT * FROM episodes WHERE tier='核心妖股'),
      market AS (
        SELECT d.* FROM daily d
        WHERE d.tradeDate BETWEEN DATE '{START}' AND DATE '{END}' AND d.stockSession>120
          AND d.totalMarketCap>0 AND d.amount20>=20000000
          AND (EXTRACT(year FROM d.tradeDate), EXTRACT(month FROM d.tradeDate)) IN (
            SELECT DISTINCT EXTRACT(year FROM startDate), EXTRACT(month FROM startDate) FROM event
          )
      )
      SELECT '核心妖股起涨时' AS sample, COUNT(*) n,
        MEDIAN(startTotalMarketCap)/1e8 medianCapYi,
        MEDIAN(startMarketCapPercentile) medianCapPercentile,
        MEDIAN(preTurnover20) medianTurnoverPct,
        MEDIAN(volumeExpansion) medianVolumeExpansion,
        MEDIAN(roePct) medianRoePct, MEDIAN(revenueYoyPct) medianRevenueYoyPct,
        MEDIAN(netProfitYoyPct) medianProfitYoyPct, MEDIAN(debtToAssetsPct) medianDebtPct
      FROM event
      UNION ALL
      SELECT '同期可交易股票日' AS sample, COUNT(*) n,
        MEDIAN(totalMarketCap)/1e8, MEDIAN(marketCapPct), MEDIAN(turnover20), NULL,
        NULL,NULL,NULL,NULL FROM market
    """).df()
    con.close()
    return episodes, shortlist, daily, comparison


def load_env(path: Path) -> None:
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def enrich_mysql(episodes: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    import pymysql
    from pymysql.cursors import DictCursor
    load_env(ROOT / "server/.env")
    conn = pymysql.connect(host=os.getenv("DB_HOST", "127.0.0.1"), port=int(os.getenv("DB_PORT", "3306")),
      user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASSWORD", ""),
      database=os.getenv("DB_NAME", "quant_backtest"), charset="utf8mb4", autocommit=True, cursorclass=DictCursor)
    intervals = episodes[["episodeId", "instrumentKey", "symbol", "startDate", "peakDate"]].copy()
    intervals["endDate"] = pd.to_datetime(intervals["peakDate"]) + pd.Timedelta(days=30)
    with conn.cursor() as cur:
        cur.execute("DROP TEMPORARY TABLE IF EXISTS tmp_monster_intervals")
        cur.execute("CREATE TEMPORARY TABLE tmp_monster_intervals(episode_id INT, instrument_key INT, symbol VARCHAR(10), start_date DATE, peak_date DATE, end_date DATE, INDEX(instrument_key,start_date), INDEX(symbol,start_date))")
        cur.executemany("INSERT INTO tmp_monster_intervals VALUES(%s,%s,%s,%s,%s,%s)", [tuple(x) for x in intervals.itertuples(index=False, name=None)])
        cur.execute("""SELECT t.episode_id episodeId, COUNT(b.id) billboardCount,
          SUM(b.net_buy_amt) dragonNetBuy, SUM(b.buy_amt) dragonBuy, SUM(b.sell_amt) dragonSell,
          AVG(b.turnover_rate) dragonAvgTurnover, GROUP_CONCAT(DISTINCT b.explanation SEPARATOR '；') dragonReasons
          FROM tmp_monster_intervals t LEFT JOIN dragon_tiger_billboards b
           ON b.security_code COLLATE utf8mb4_unicode_ci=t.symbol AND b.trade_date BETWEEN t.start_date AND t.end_date
          GROUP BY t.episode_id""")
        dragon_summary = pd.DataFrame(cur.fetchall())
        cur.execute("""SELECT t.episode_id episodeId,b.trade_date tradeDate,b.security_code symbol,b.security_name name,
          b.explanation,b.change_type changeType,b.net_buy_amt netBuyAmt,b.buy_amt buyAmt,b.sell_amt sellAmt,
          b.billboard_deal_amt billboardDealAmt,b.turnover_rate turnoverRate,b.change_pct changePct
          FROM tmp_monster_intervals t JOIN dragon_tiger_billboards b
           ON b.security_code COLLATE utf8mb4_unicode_ci=t.symbol AND b.trade_date BETWEEN t.start_date AND t.end_date
          ORDER BY t.episode_id,b.trade_date""")
        dragon_detail = pd.DataFrame(cur.fetchall())
        cur.execute("""SELECT t.episode_id episodeId,COUNT(f.instrument_key) flowDays,SUM(f.main_net_in) mainNetIn,
          AVG(f.main_net_ratio) avgMainNetRatio,
          AVG(CASE WHEN f.main_net_in>0 THEN 1.0 ELSE 0.0 END) positiveFlowDayPct,
          SUM(f.super_large_net_in) superLargeNetIn,SUM(f.large_net_in) largeNetIn,
          SUM(f.medium_net_in) mediumNetIn,SUM(f.small_net_in) smallNetIn
          FROM tmp_monster_intervals t LEFT JOIN stock_fund_flows f
           ON f.instrument_key=t.instrument_key AND f.trade_date BETWEEN t.start_date AND t.peak_date AND f.is_final=1
          GROUP BY t.episode_id""")
        flow_summary = pd.DataFrame(cur.fetchall())
    conn.close()
    return dragon_summary, dragon_detail, flow_summary


def write_report(snapshot_id: str, episodes: pd.DataFrame, shortlist: pd.DataFrame, comparison: pd.DataFrame) -> None:
    core = episodes[episodes.tier == "核心妖股"]
    core = core.copy()
    for col in ["intervalGain","startTotalMarketCap","startMarketCapPercentile","avgTurnoverPct",
                "cumulativeTurnoverPct","volumeExpansion","amountExpansion","roePct","revenueYoyPct",
                "netProfitYoyPct","post60MaxDrawdown","billboardCount","mainNetInPctOfTurnover","positiveFlowDayPct"]:
        if col in core:
            core[col] = pd.to_numeric(core[col], errors="coerce")
    def fmt(x, kind="num"):
        if pd.isna(x): return "—"
        if kind == "pct": return f"{x:.1%}"
        return f"{x:,.1f}"
    med = core.median(numeric_only=True)
    dragon_hit = (pd.to_numeric(core.get("billboardCount"), errors="coerce").fillna(0) > 0).mean()
    top = shortlist.sort_values("intervalGain", ascending=False).head(30).copy()
    cols = ["symbol","name","startDate","peakDate","intervalGain","startTotalMarketCap","avgTurnoverPct","volumeExpansion","billboardCount","mainNetIn"]
    top = top[[c for c in cols if c in top]].copy()
    if "intervalGain" in top: top["intervalGain"] = top["intervalGain"].map(lambda x:f"{x:.1%}")
    if "startTotalMarketCap" in top: top["startTotalMarketCap"] = top["startTotalMarketCap"].map(lambda x:f"{x/1e8:.1f}")
    html_table = top.to_html(index=False, border=0, classes="data")
    comp = comparison.to_html(index=False, border=0, classes="data")
    rumor_file = OUT / "rumor_evidence.csv"
    rumor_html = "<p>暂无已核验传闻证据。</p>"
    if rumor_file.exists():
        rumor = pd.read_csv(rumor_file, encoding="utf-8-sig")
        view = rumor[["symbol","name","episode","theme_or_rumor","evidence_level","finding","source_title","source_url"]].copy()
        view["source_url"] = view.apply(lambda r: f"<a href='{html_lib.escape(str(r['source_url']), quote=True)}'>来源</a>", axis=1)
        rumor_html = view.to_html(index=False, border=0, classes="data", escape=False)
    generated = datetime.now().astimezone().isoformat(timespec="seconds")
    html = f"""<!doctype html><html lang='zh-CN'><meta charset='utf-8'><title>近十年A股妖股研究</title><style>
body{{font-family:Inter,'Microsoft YaHei',sans-serif;background:#f3f5f7;color:#18212b;margin:0}}main{{max-width:1200px;margin:auto;padding:36px 24px 80px}}h1{{margin:0}}h2{{margin-top:38px;border-left:4px solid #b33939;padding-left:12px}}.meta{{color:#6c7883;margin:8px 0 24px}}.cards{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}.card{{background:#fff;padding:18px;border-radius:10px;box-shadow:0 2px 12px #00000010}}.v{{font-size:30px;font-weight:750;color:#a52222}}.callout{{background:#fff3dc;border-radius:10px;padding:18px;line-height:1.7;margin-top:22px}}table.data{{border-collapse:collapse;width:100%;background:#fff;font-size:13px}}th,td{{padding:8px 10px;border-bottom:1px solid #e2e7eb;text-align:right}}th:first-child,td:first-child{{text-align:left}}th{{background:#e9eef2}}.scroll{{overflow:auto}}li{{margin:7px 0}}@media(max-width:800px){{.cards{{grid-template-columns:1fr 1fr}}}}</style><main>
<h1>近十年A股“妖股”爆炒区间与共同特征</h1><div class='meta'>{START}—{END} · 数据快照 {snapshot_id} · 生成 {generated}</div>
<div class='cards'><div class='card'><div>核心妖股区间</div><div class='v'>{len(core)}</div></div><div class='card'><div>涉及股票</div><div class='v'>{core.instrumentKey.nunique()}</div></div><div class='card'><div>区间涨幅中位数</div><div class='v'>{fmt(med.get('intervalGain'), 'pct')}</div></div><div class='card'><div>峰后60日最大回撤中位数</div><div class='v'>{fmt(med.get('post60MaxDrawdown'), 'pct')}</div></div></div>
<div class='callout'><strong>定义不是贴标签：</strong>核心样本要求上市超过120个交易日、120日内从滚动低点至少上涨300%（价格达到4倍）、且至少3个单日涨幅≥9.5%；同一股票相邻极端行情合并。扩展候选为上涨200%–300%。这是一套可复现的“极端价格事件”定义，不等同于监管或媒体对“妖股”的认定。</div>
<h2>共同画像</h2><ul><li><strong>规模：</strong>起涨总市值中位数 {fmt(med.get('startTotalMarketCap')/1e8)} 亿元；起涨时市值横截面分位中位数 {fmt(med.get('startMarketCapPercentile'), 'pct')}。</li><li><strong>换手：</strong>爆炒期日均换手率中位数 {fmt(med.get('avgTurnoverPct'))}%，累计换手中位数 {fmt(med.get('cumulativeTurnoverPct'))}%。</li><li><strong>量能：</strong>区间平均成交量相对起涨前20日中位扩张 {fmt(med.get('volumeExpansion'))} 倍，成交额扩张 {fmt(med.get('amountExpansion'))} 倍。</li><li><strong>基本面：</strong>起涨前可见财报的ROE中位数 {fmt(med.get('roePct'))}%，营收同比中位数 {fmt(med.get('revenueYoyPct'))}%，净利润同比中位数 {fmt(med.get('netProfitYoyPct'))}%。财务缺失和极端值较多，应与覆盖率一起看。</li><li><strong>龙虎榜：</strong>现有龙虎榜库命中 {fmt(dragon_hit,'pct')} 的核心区间；库本身不完整，未命中不可解释为无游资。</li><li><strong>资金流：</strong>爆炒区间主力净流入占同期成交额的中位数为 {fmt(med.get('mainNetInPctOfTurnover'),'pct')}，正流入交易日占比中位数 {fmt(med.get('positiveFlowDayPct'),'pct')}。历史上价格暴涨并不要求供应商口径的“主力资金”持续净流入。</li></ul>
<h2>与同期市场对照</h2><div class='scroll'>{comp}</div>
<h2>年度代表清单（每年涨幅前10）</h2><div class='scroll'>{html_table}</div>
<h2>如何解读龙虎榜、资金流与传闻</h2><ul><li>龙虎榜只覆盖触发披露条件的交易日，不上榜不代表没有游资；席位净买入也不代表次日继续上涨。</li><li>资金流“大单/小单”是行情商按成交特征分类，不等同于真实账户身份；报告保留净流入与正流入日占比，避免只摘单日数据。</li><li>“坊间传闻”单独列在 rumor_evidence.csv，按公司公告/监管、正规媒体转述、未经证实讨论分级。传闻仅用于解释注意力扩散，不作为事实或因果证据。</li></ul>
<h2>代表案例的题材与传闻核验</h2><div class='scroll'>{rumor_html}</div>
<h2>主要限制</h2><ul><li>日线无法模拟涨停排队、盘中冲击成本和实际可成交性。</li><li>总市值和财务字段存在历史缺失；ST名称可能是当前名称，未必准确反映事件当日状态。</li><li>筛选阈值用于整理极端事件，并非投资规则；峰值是事后识别，存在明显后视偏差。</li></ul></main></html>"""
    (OUT / "research_report.html").write_text(html, encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    snapshot_id, snapshot = load_snapshot()
    episodes, shortlist, daily, comparison = build_local(snapshot)
    dragon_summary, dragon_detail, flow_summary = enrich_mysql(episodes)
    episodes = episodes.merge(dragon_summary, on="episodeId", how="left").merge(flow_summary, on="episodeId", how="left")
    episodes["mainNetInPctOfTurnover"] = episodes["mainNetIn"] / (episodes["avgAmount"] * episodes["tradingDays"]).replace(0, np.nan)
    shortlist = shortlist.drop(columns=[c for c in dragon_summary.columns if c != "episodeId"], errors="ignore").drop(columns=[c for c in flow_summary.columns if c != "episodeId"], errors="ignore")
    shortlist = shortlist.merge(dragon_summary, on="episodeId", how="left").merge(flow_summary, on="episodeId", how="left")
    shortlist["mainNetInPctOfTurnover"] = shortlist["mainNetIn"] / (shortlist["avgAmount"] * shortlist["tradingDays"]).replace(0, np.nan)
    episodes.to_csv(OUT / "monster_stock_intervals_all.csv", index=False, encoding="utf-8-sig")
    episodes[episodes.tier == "核心妖股"].to_csv(OUT / "monster_stock_core_list.csv", index=False, encoding="utf-8-sig")
    shortlist.to_csv(OUT / "annual_top10_shortlist.csv", index=False, encoding="utf-8-sig")
    daily.to_csv(OUT / "monster_stock_daily.csv", index=False, encoding="utf-8-sig")
    dragon_detail.to_csv(OUT / "dragon_tiger_detail.csv", index=False, encoding="utf-8-sig")
    comparison.to_csv(OUT / "market_comparison.csv", index=False, encoding="utf-8-sig")
    # Placeholder receives sourced rumor/news evidence in a separate research pass.
    rumor_path = OUT / "rumor_evidence.csv"
    if not rumor_path.exists():
        pd.DataFrame(columns=["symbol","name","episode","theme_or_rumor","evidence_level","finding","source_title","source_url","source_date","notes"]).to_csv(rumor_path,index=False,encoding="utf-8-sig")
    write_report(snapshot_id, episodes, shortlist, comparison)
    metadata = {"snapshotId":snapshot_id,"period":[START,END],"definition":{"coreGain":CORE_GAIN,"candidateGain":MIN_GAIN,"windowSessions":120,"minLargeUpDays":3},"episodeCount":len(episodes),"coreEpisodeCount":int((episodes.tier=='核心妖股').sum()),"coreStockCount":int(episodes.loc[episodes.tier=='核心妖股','instrumentKey'].nunique()),"shortlistCount":len(shortlist),"generatedAt":datetime.now().astimezone().isoformat()}
    (OUT / "run_metadata.json").write_text(json.dumps(metadata,ensure_ascii=False,indent=2),encoding="utf-8")
    print(json.dumps(metadata,ensure_ascii=False,indent=2))
    print(shortlist[["peakYear","annualRank","symbol","name","startDate","peakDate","intervalGain"]].to_string(index=False))


if __name__ == "__main__":
    main()
