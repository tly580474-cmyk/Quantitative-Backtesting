#!/usr/bin/env python3
"""Compare explicit sell rules for the trend/momentum entry strategy."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import shutil
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
BASE_SCRIPT = ROOT / "scripts" / "experiments" / "trend_momentum" / "run_experiment.py"
spec = importlib.util.spec_from_file_location("trend_momentum_base", BASE_SCRIPT)
if spec is None or spec.loader is None:
    raise RuntimeError(f"cannot load {BASE_SCRIPT}")
base = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = base
spec.loader.exec_module(base)

duckdb = base.duckdb
np = base.np
pd = base.pd
go = base.go
make_subplots = base.make_subplots


POLICIES = {
    "review_only": "仅20日调仓卖出",
    "ma60": "跌破MA60",
    "ma20_confirmed": "MA60或连续2日跌破MA20",
    "profit_trailing": "MA60或盈利后回撤保护",
    "combined": "组合退出",
}
BUY_COST = 0.0008
SELL_COST = 0.0013


def paths() -> dict[str, Path]:
    tmp = ROOT / "tmp_output" / "trend_momentum_exit_experiment"
    return {
        "tmp": tmp,
        "db": tmp / "exit_experiment.duckdb",
        "report": tmp / "trend_momentum_sell_strategy_report.html",
        "conclusion": ROOT / "output" / "trend_momentum_sell_strategy_report.html",
        "trades": tmp / "exit_trade_details.csv",
        "periods": tmp / "period_returns.csv",
        "metrics": tmp / "metrics.csv",
        "stages": tmp / "stage_metrics.csv",
        "metadata": tmp / "run_metadata.json",
    }


def build_trades(con: duckdb.DuckDBPyConnection, base_db: Path) -> None:
    escaped = str(base_db).replace("'", "''")
    con.execute("SET threads=6")
    con.execute("SET memory_limit='6GB'")
    try:
        con.execute("DETACH base_exp")
    except duckdb.Error:
        pass
    con.execute(f"ATTACH '{escaped}' AS base_exp (READ_ONLY)")
    con.execute("DROP TABLE IF EXISTS exit_trades")
    con.execute(
        """
        CREATE TABLE exit_trades AS
        WITH entry_set AS (
          SELECT * FROM base_exp.selections WHERE variant='full_stop'
        ), path_raw AS (
          SELECT s.periodNo, s.signalDate, s.entryDate, s.nextSignalDate,
                 s.plannedExitDate, s.instrumentKey, s.market, s.symbol,
                 s.name, s.industry, s.score,
                 entry.pxOpen AS entryOpen,
                 f.tradeDate, f.pxClose, f.ma20, f.ma60,
                 f.pxClose < f.ma20 AS belowMa20,
                 f.pxClose < f.ma60 AS belowMa60
          FROM entry_set s
          LEFT JOIN base_exp.features entry
            ON entry.instrumentKey=s.instrumentKey AND entry.tradeDate=s.entryDate
          LEFT JOIN base_exp.features f
            ON f.instrumentKey=s.instrumentKey
           AND f.tradeDate BETWEEN s.entryDate AND s.nextSignalDate
        ), path_windows AS (
          SELECT *,
            LAG(belowMa20) OVER (
              PARTITION BY periodNo, instrumentKey ORDER BY tradeDate
            ) AS previousBelowMa20,
            MAX(pxClose) OVER (
              PARTITION BY periodNo, instrumentKey ORDER BY tradeDate
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS runningPeak
          FROM path_raw
        ), expanded AS (
          SELECT *, 'review_only' AS policy, FALSE AS triggered FROM path_windows
          UNION ALL
          SELECT *, 'ma60', belowMa60 FROM path_windows
          UNION ALL
          SELECT *, 'ma20_confirmed',
                 belowMa60 OR (belowMa20 AND previousBelowMa20)
          FROM path_windows
          UNION ALL
          SELECT *, 'profit_trailing',
                 belowMa60 OR (
                   runningPeak / NULLIF(entryOpen, 0) - 1 >= 0.15
                   AND pxClose / NULLIF(runningPeak, 0) - 1 <= -0.08
                 )
          FROM path_windows
          UNION ALL
          SELECT *, 'combined',
                 belowMa60
                 OR (belowMa20 AND previousBelowMa20)
                 OR (
                   runningPeak / NULLIF(entryOpen, 0) - 1 >= 0.15
                   AND pxClose / NULLIF(runningPeak, 0) - 1 <= -0.08
                 )
          FROM path_windows
        ), triggers AS (
          SELECT policy, periodNo, instrumentKey,
                 MIN(tradeDate) FILTER (WHERE triggered) AS triggerDate
          FROM expanded
          GROUP BY policy, periodNo, instrumentKey
        ), requested AS (
          SELECT p.policy, p.periodNo, p.signalDate, p.entryDate,
                 p.nextSignalDate, p.plannedExitDate, p.instrumentKey,
                 p.market, p.symbol, p.name, p.industry, p.score,
                 p.entryOpen, t.triggerDate,
                 CASE WHEN t.triggerDate IS NULL THEN p.plannedExitDate
                      ELSE (
                        SELECT MIN(i.tradeDate) FROM base_exp.index_features i
                        WHERE i.tradeDate > t.triggerDate
                      )
                 END AS requestedExitDate
          FROM (
            SELECT DISTINCT policy, periodNo, signalDate, entryDate,
                   nextSignalDate, plannedExitDate, instrumentKey, market,
                   symbol, name, industry, score, entryOpen
            FROM expanded
          ) p
          JOIN triggers t USING (policy, periodNo, instrumentKey)
        ), resolved AS (
          SELECT r.*,
            (
              SELECT MIN(f.tradeDate) FROM base_exp.features f
              WHERE f.instrumentKey=r.instrumentKey
                AND f.tradeDate >= r.requestedExitDate
            ) AS actualExitDate
          FROM requested r
        )
        SELECT r.*, exit.pxOpen AS exitOpen,
               r.entryOpen IS NOT NULL AND r.entryOpen > 0 AS executed,
               CASE
                 WHEN r.entryOpen IS NULL OR r.entryOpen <= 0 THEN 0
                 WHEN exit.pxOpen IS NULL OR exit.pxOpen <= 0 THEN -1
                 ELSE exit.pxOpen / r.entryOpen - 1
               END AS grossReturn
        FROM resolved r
        LEFT JOIN base_exp.features exit
          ON exit.instrumentKey=r.instrumentKey AND exit.tradeDate=r.actualExitDate;
        """
    )


def period_results(
    trades: pd.DataFrame, index_prices: pd.DataFrame
) -> pd.DataFrame:
    index_prices = index_prices.set_index("tradeDate")
    rows: list[dict] = []
    for policy, source in trades.groupby("policy", sort=False):
        prior_survivors: set[int] = set()
        nav = nav_2x = 1.0
        for period_no, group in source.groupby("periodNo", sort=True):
            executed = group["executed"].fillna(False).astype(bool)
            current = set(group.loc[executed, "instrumentKey"].astype(int))
            triggered = set(
                group.loc[executed & group["triggerDate"].notna(), "instrumentKey"].astype(int)
            )
            continuing = current & prior_survivors
            buys = len(current - continuing) / len(group)
            boundary_sells = (
                len(prior_survivors - current) / len(prior_survivors)
                if prior_survivors
                else 0.0
            )
            trigger_sells = len(triggered) / len(group)
            gross = float(group["grossReturn"].mean())
            cost = BUY_COST * buys + SELL_COST * (boundary_sells + trigger_sells)
            net = gross - cost
            net_2x = gross - 2 * cost
            nav *= 1 + net
            nav_2x *= 1 + net_2x
            first = group.iloc[0]
            entry_date = pd.Timestamp(first["entryDate"])
            exit_date = pd.Timestamp(first["plannedExitDate"])
            bench = (
                float(index_prices.loc[exit_date, "open"])
                / float(index_prices.loc[entry_date, "open"])
                - 1
            )
            rows.append(
                {
                    "policy": policy,
                    "periodNo": int(period_no),
                    "entryDate": entry_date,
                    "exitDate": exit_date,
                    "holdings": len(current),
                    "triggeredExits": len(triggered),
                    "grossReturn": gross,
                    "cost": cost,
                    "netReturn": net,
                    "netReturn2xCost": net_2x,
                    "benchmarkReturn": bench,
                    "nav": nav,
                    "nav2xCost": nav_2x,
                }
            )
            prior_survivors = current - triggered
    result = pd.DataFrame(rows).sort_values(["policy", "entryDate"])
    result["benchmarkNav"] = result.groupby("policy")["benchmarkReturn"].transform(
        lambda x: (1 + x).cumprod()
    )
    return result


def max_drawdown(returns: pd.Series) -> float:
    nav = (1 + returns.fillna(0)).cumprod()
    return float((nav / nav.cummax() - 1).min())


def metric_row(group: pd.DataFrame) -> dict:
    annual_periods = 252 / 20
    r = group["netReturn"]
    b = group["benchmarkReturn"]
    years = len(group) / annual_periods
    ann = float(np.prod(1 + r)) ** (1 / years) - 1
    ann_b = float(np.prod(1 + b)) ** (1 / years) - 1
    excess = r - b
    vol = float(r.std(ddof=1) * math.sqrt(annual_periods))
    tracking = float(excess.std(ddof=1) * math.sqrt(annual_periods))
    ann_2x = float(np.prod(1 + group["netReturn2xCost"])) ** (1 / years) - 1
    return {
        "periods": len(group),
        "annualReturn": ann,
        "benchmarkAnnualReturn": ann_b,
        "annualExcess": ann - ann_b,
        "annualVolatility": vol,
        "sharpe": ann / vol if vol else np.nan,
        "informationRatio": (ann - ann_b) / tracking if tracking else np.nan,
        "maxDrawdown": max_drawdown(r),
        "annualReturn2xCost": ann_2x,
        "winRate": float((r > 0).mean()),
        "triggeredExits": int(group["triggeredExits"].sum()),
    }


def metrics(periods: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for policy, group in periods.groupby("policy", sort=False):
        rows.append({"policy": policy, "name": POLICIES[policy], **metric_row(group)})
    return pd.DataFrame(rows)


def stage_metrics(periods: pd.DataFrame) -> pd.DataFrame:
    stages = [
        ("2010–2021 研究期", "2010-01-01", "2021-12-31"),
        ("2022–2023 验证期", "2022-01-01", "2023-12-31"),
        ("2024–当前 观察期", "2024-01-01", "2099-12-31"),
    ]
    rows = []
    for policy, source in periods.groupby("policy"):
        for stage, start, end in stages:
            group = source[source["entryDate"].between(start, end)]
            if not group.empty:
                rows.append(
                    {
                        "policy": policy,
                        "name": POLICIES[policy],
                        "stage": stage,
                        **metric_row(group),
                    }
                )
    return pd.DataFrame(rows)


def pct(value: float) -> str:
    return "—" if pd.isna(value) else f"{value:.2%}"


def table(df: pd.DataFrame, percent: list[str]) -> str:
    shown = df.copy()
    for column in percent:
        if column in shown:
            shown[column] = shown[column].map(pct)
    return shown.to_html(index=False, border=0, classes="data-table", escape=True)


def chart(periods: pd.DataFrame) -> str:
    fig = make_subplots(
        rows=2,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.12,
        row_heights=[0.72, 0.28],
        subplot_titles=("不同卖出策略成本后净值", "组合退出相对仅调仓卖出的累计差异"),
    )
    for policy, label in POLICIES.items():
        group = periods[periods["policy"] == policy]
        fig.add_trace(
            go.Scatter(
                x=group["exitDate"],
                y=group["nav"],
                name=label,
                line={"width": 2.8 if policy == "combined" else 1.5},
            ),
            row=1,
            col=1,
        )
    combined = periods[periods["policy"] == "combined"].reset_index(drop=True)
    baseline = periods[periods["policy"] == "review_only"].reset_index(drop=True)
    fig.add_trace(
        go.Scatter(
            x=combined["exitDate"],
            y=combined["nav"] / baseline["nav"] - 1,
            name="组合退出相对改善",
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
        margin={"l": 55, "r": 25, "t": 65, "b": 45},
        legend={"orientation": "h", "y": 1.1},
    )
    return fig.to_html(full_html=False, include_plotlyjs=True)


def render(
    report: Path,
    metric_df: pd.DataFrame,
    stage_df: pd.DataFrame,
    periods: pd.DataFrame,
    metadata: dict,
) -> None:
    ranked = metric_df.sort_values(
        ["annualReturn", "maxDrawdown"], ascending=[False, False]
    )
    best = ranked.iloc[0]
    baseline = metric_df.set_index("policy").loc["review_only"]
    combined = metric_df.set_index("policy").loc["combined"]
    rescue = best["annualExcess"] > 0 and best["annualReturn2xCost"] > 0
    verdict = "卖出策略未能挽救入场逻辑" if not rescue else "存在可继续观察的卖出策略"
    verdict_class = "fail" if not rescue else "warn"
    view = metric_df[
        [
            "name",
            "annualReturn",
            "annualExcess",
            "sharpe",
            "informationRatio",
            "maxDrawdown",
            "annualReturn2xCost",
            "triggeredExits",
        ]
    ].rename(
        columns={
            "name": "卖出规则",
            "annualReturn": "年化收益",
            "annualExcess": "相对沪深300年化",
            "sharpe": "Sharpe",
            "informationRatio": "信息比率",
            "maxDrawdown": "最大回撤",
            "annualReturn2xCost": "双倍成本年化",
            "triggeredExits": "盘中周期退出次数",
        }
    )
    stages = stage_df[
        ["name", "stage", "annualReturn", "annualExcess", "maxDrawdown", "annualReturn2xCost"]
    ].rename(
        columns={
            "name": "卖出规则",
            "stage": "阶段",
            "annualReturn": "年化收益",
            "annualExcess": "年化超额",
            "maxDrawdown": "最大回撤",
            "annualReturn2xCost": "双倍成本年化",
        }
    )
    html = f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>趋势动量卖出策略验证</title><style>
body{{margin:0;background:#f4f7fb;color:#172033;font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
.wrap{{max-width:1280px;margin:auto;padding:30px}}.hero,.card{{background:#fff;border:1px solid #dbe4f0;border-radius:16px;padding:24px;margin-bottom:18px;box-shadow:0 8px 24px #15345b0d}}
h1{{margin:0 0 8px;font-size:30px}}h2{{margin:0 0 14px;font-size:20px}}.muted{{color:#64748b}}
.verdict{{display:inline-block;padding:5px 13px;border-radius:999px;font-weight:700}}.fail{{background:#fee2e2;color:#991b1b}}.warn{{background:#fef3c7;color:#92400e}}
.grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}.kpi{{background:#f8fafc;border-radius:12px;padding:15px}}.kpi b{{display:block;font-size:23px;color:#0f3d89}}
.data-table{{width:100%;border-collapse:collapse;font-size:13px}}.data-table th,.data-table td{{padding:10px;border-bottom:1px solid #e5eaf1;text-align:right}}.data-table th:first-child,.data-table td:first-child{{text-align:left}}
.note{{border-left:4px solid #f59e0b;padding:10px 14px;background:#fffbeb}}code{{background:#edf2f7;padding:2px 6px;border-radius:5px}}
@media(max-width:800px){{.grid{{grid-template-columns:1fr 1fr}}.wrap{{padding:12px}}}}
</style></head><body><main class="wrap">
<section class="hero"><div class="muted">同一入场信号，仅替换卖出逻辑</div>
<h1>趋势动量策略：卖出规则验证</h1><p><span class="verdict {verdict_class}">{verdict}</span></p>
<div class="grid"><div class="kpi"><span>表现最好规则</span><b style="font-size:18px">{best["name"]}</b></div>
<div class="kpi"><span>最好年化收益</span><b>{pct(best["annualReturn"])}</b></div>
<div class="kpi"><span>组合退出相对基线</span><b>{pct(combined["annualReturn"]-baseline["annualReturn"])}</b></div>
<div class="kpi"><span>最好最大回撤</span><b>{pct(best["maxDrawdown"])}</b></div></div></section>
<section class="card"><h2>结论</h2>
<p>五组规则使用完全相同的趋势、相对动量和量价入场信号。表现最好的是
<b>{best["name"]}</b>，但成本后年化为 <b>{pct(best["annualReturn"])}</b>、相对沪深300年化为
<b>{pct(best["annualExcess"])}</b>。因此卖出规则只能改变损失路径，不能把缺乏正向期望的入场信号变成可用策略。</p>
<p>明确的建议规则是：每20日复核，未再入选即卖出；周期内若收盘跌破MA60，或连续两日跌破MA20，
或浮盈曾达到15%后从最高收盘回撤8%，则下一可交易日开盘卖出。该规则结构合理，但在本数据上
<b>仅可作为风险控制对照，不应进入模拟盘</b>。</p></section>
<section class="card"><h2>净值对照</h2>{chart(periods)}</section>
<section class="card"><h2>全样本结果</h2>
{table(view, ["年化收益","相对沪深300年化","最大回撤","双倍成本年化"])}</section>
<section class="card"><h2>分阶段结果</h2>
{table(stages, ["年化收益","年化超额","最大回撤","双倍成本年化"])}</section>
<section class="card"><h2>五种卖出规则</h2><ol>
<li><b>仅调仓：</b>持有到下一次20日复核；不再入选则在复核后的下一交易日开盘卖出。</li>
<li><b>MA60：</b>增加收盘跌破MA60后的下一可交易日开盘卖出。</li>
<li><b>MA20确认：</b>MA60硬止损，或连续两个收盘低于MA20后卖出，过滤单日假跌破。</li>
<li><b>盈利回撤：</b>MA60硬止损；持仓最高收盘相对入场开盘盈利达到15%后，若回撤达到8%则保护利润。</li>
<li><b>组合退出：</b>同时使用MA60、连续两日MA20和盈利回撤，任一先触发即卖出。</li>
</ol><p>所有条件均只使用当日收盘及更早数据；成交安排在下一可交易日开盘。没有固定止盈价，因为趋势策略需要保留大赢家的上行空间。</p></section>
<section class="card"><h2>研究边界</h2>
<p class="note">这些退出参数是在上一轮全样本结果已知后提出，因此本报告属于探索性验证，不把2024年至今冒充从未读取的锁定测试。
下一轮若修改15%/8%或确认天数，必须冻结新版本并使用新的未来模拟期检验。</p>
<p>基础快照：<code>{metadata["snapshotId"]}</code>；基础脚本校验和：<code>{metadata["baseScriptSha256"]}</code>；
卖出脚本校验和：<code>{metadata["scriptSha256"]}</code>。买入8bp、卖出13bp，并做双倍成本压力测试。</p>
<p class="muted">生成时间：{metadata["generatedAt"]}</p></section>
</main></body></html>"""
    report.write_text(html, encoding="utf-8")


def main() -> None:
    out = paths()
    out["tmp"].mkdir(parents=True, exist_ok=True)
    out["conclusion"].parent.mkdir(parents=True, exist_ok=True)
    base_db = ROOT / "tmp_output" / "trend_momentum_experiment" / "trend_momentum.duckdb"
    if not base_db.exists():
        raise FileNotFoundError("run trend_momentum experiment first")
    con = duckdb.connect(str(out["db"]))
    build_trades(con, base_db)
    trades = con.execute("SELECT * FROM exit_trades ORDER BY policy, periodNo, score DESC").fetchdf()
    index_prices = con.execute(
        "SELECT tradeDate, open FROM base_exp.index_features ORDER BY tradeDate"
    ).fetchdf()
    snapshot_id = con.execute(
        "SELECT value FROM base_exp.experiment_meta WHERE key='snapshot_id'"
    ).fetchone()[0]
    con.close()
    periods = period_results(trades, index_prices)
    metric_df = metrics(periods)
    stage_df = stage_metrics(periods)
    trades.to_csv(out["trades"], index=False, encoding="utf-8-sig")
    periods.to_csv(out["periods"], index=False, encoding="utf-8-sig")
    metric_df.to_csv(out["metrics"], index=False, encoding="utf-8-sig")
    stage_df.to_csv(out["stages"], index=False, encoding="utf-8-sig")
    metadata = {
        "snapshotId": snapshot_id,
        "generatedAt": pd.Timestamp.now(tz="Asia/Shanghai").isoformat(),
        "baseScriptSha256": hashlib.sha256(BASE_SCRIPT.read_bytes()).hexdigest(),
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "sellPolicies": POLICIES,
        "costs": {"buy": BUY_COST, "sell": SELL_COST},
        "artifacts": {key: str(value) for key, value in out.items()},
    }
    out["metadata"].write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    render(out["report"], metric_df, stage_df, periods, metadata)
    shutil.copy2(out["report"], out["conclusion"])
    print(metric_df.to_string(index=False))
    print(f"\nreport: {out['report']}")
    print(f"conclusion: {out['conclusion']}")


if __name__ == "__main__":
    main()
