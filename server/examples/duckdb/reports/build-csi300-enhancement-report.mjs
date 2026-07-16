import fs from "node:fs/promises";
import path from "node:path";

const root =
  "D:\\github_public_repo\\量化回测\\server\\out\\index-enhancement-final\\csi300-enhancement";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers, ...data] = rows;
  return data.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

async function readCsv(fileName) {
  return parseCsv(await fs.readFile(path.join(root, fileName), "utf8"));
}

const summary = (
  await readCsv("monthly-rebalance-return-2026-07-01-2026-07-16.csv")
)[0];
const daily = await readCsv("daily-performance-2026-07-01-2026-07-16.csv");
const target = await readCsv("target-portfolio-2026-06-30.csv");
const weightDeviation = await readCsv(
  "weight-deviation-2026-07-01-2026-07-16.csv",
);
const minute = await readCsv(
  "intraday-excess-by-minute-2026-07-01-2026-07-16.csv",
);
const stockDay = await readCsv(
  "intraday-excess-by-stock-day-2026-07-01-2026-07-16.csv",
);

const number = (value) => Number(value || 0);
const percent = (value, digits = 2) => `${(number(value) * 100).toFixed(digits)}%`;
const percentagePoint = (value, digits = 3) => `${number(value).toFixed(digits)}pp`;
const signedPercent = (value, digits = 2) => {
  const result = number(value) * 100;
  return `${result >= 0 ? "+" : ""}${result.toFixed(digits)}%`;
};

const activeSorted = [...target].sort(
  (a, b) => number(b.activeWeightPct) - number(a.activeWeightPct),
);
const topOverweights = activeSorted.slice(0, 10);
const topUnderweights = activeSorted.slice(-10).reverse();

const stockContributionMap = new Map();
for (const row of stockDay) {
  const key = row.symbol;
  const current = stockContributionMap.get(key) ?? {
    symbol: row.symbol,
    name: row.name,
    industry: row.level1Name,
    contribution: 0,
  };
  current.contribution += number(row.intradayExcessContribution);
  stockContributionMap.set(key, current);
}
const stockContributions = [...stockContributionMap.values()].sort(
  (a, b) => b.contribution - a.contribution,
);
const topPositiveContributors = stockContributions.slice(0, 10);
const topNegativeContributors = stockContributions.slice(-10).reverse();

const latestDate = daily[daily.length - 1].tradeDate;
const latestMinute = minute.filter((row) => row.tradeDate === latestDate);

const data = {
  daily: daily.map((row) => ({
    date: row.tradeDate.slice(5),
    enhanced: number(row.enhancedCumulativeReturn),
    constituent: number(row.constituentBenchmarkCumulativeReturn),
    official: number(row.officialIndexCumulativeReturn),
    excess: number(row.constituentExcessReturn),
  })),
  activeWeights: [...topOverweights, ...topUnderweights].map((row) => ({
    label: `${row.symbol} ${row.name}`,
    value: number(row.activeWeightPct),
  })),
  contributors: [
    ...topPositiveContributors.slice(0, 6),
    ...topNegativeContributors.slice(0, 6),
  ].map((row) => ({
    label: `${row.symbol} ${row.name}`,
    value: row.contribution,
  })),
  latestIntraday: latestMinute.map((row) => ({
    time: row.minuteOfDay,
    value: number(row.cumulativeIntradayExcessContribution),
    covered: number(row.coveredStocks),
  })),
};

function rows(items, render) {
  return items.map(render).join("");
}

const dailyRows = rows(daily, (row) => `
  <tr>
    <td>${row.tradeDate}</td>
    <td class="num">${percent(row.enhancedCumulativeReturn)}</td>
    <td class="num">${percent(row.constituentBenchmarkCumulativeReturn)}</td>
    <td class="num">${percent(row.officialIndexCumulativeReturn)}</td>
    <td class="num ${number(row.constituentExcessReturn) >= 0 ? "positive" : "negative"}">${signedPercent(row.constituentExcessReturn)}</td>
    <td class="num">${percent(row.activeShare)}</td>
  </tr>`);

const activeRows = rows(
  [...topOverweights.slice(0, 8), ...topUnderweights.slice(0, 8)],
  (row) => `
  <tr>
    <td><span class="code">${row.symbol}</span> ${row.name}</td>
    <td>${row.level1Name || "未分类"}</td>
    <td class="num">${percentagePoint(row.benchmarkWeightPct)}</td>
    <td class="num">${percentagePoint(row.targetWeightPct)}</td>
    <td class="num ${number(row.activeWeightPct) >= 0 ? "positive" : "negative"}">${number(row.activeWeightPct) >= 0 ? "+" : ""}${percentagePoint(row.activeWeightPct)}</td>
  </tr>`,
);

const contributionRows = rows(
  [...topPositiveContributors.slice(0, 8), ...topNegativeContributors.slice(0, 8)],
  (row) => `
  <tr>
    <td><span class="code">${row.symbol}</span> ${row.name}</td>
    <td>${row.industry || "未分类"}</td>
    <td class="num ${row.contribution >= 0 ? "positive" : "negative"}">${signedPercent(row.contribution, 4)}</td>
  </tr>`,
);

const outputFiles = [
  ["月度调仓收益", "monthly-rebalance-return-2026-07-01-2026-07-16.csv"],
  ["每日组合表现", "daily-performance-2026-07-01-2026-07-16.csv"],
  ["目标组合权重", "target-portfolio-2026-06-30.csv"],
  ["每日权重偏离", "weight-deviation-2026-07-01-2026-07-16.csv"],
  ["分钟超额汇总", "intraday-excess-by-minute-2026-07-01-2026-07-16.csv"],
  ["股票日内贡献", "intraday-excess-by-stock-day-2026-07-01-2026-07-16.csv"],
  ["完整分钟明细", "intraday-excess-detail-2026-07-01-2026-07-16.csv"],
];

const reportData = JSON.stringify(data).replaceAll("<", "\\u003c");

const html = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="沪深300指数增强组合与日内分钟超额贡献研究报告">
  <title>沪深300指数增强与日内超额贡献报告</title>
  <style>
    :root {
      --navy: #0f2f5f;
      --blue: #1e40af;
      --blue-2: #3b82f6;
      --amber: #d97706;
      --green: #087f5b;
      --red: #c2414b;
      --ink: #172033;
      --muted: #526079;
      --line: #dbe3ef;
      --soft: #eef4fb;
      --paper: #ffffff;
      --canvas: #f6f8fc;
      --shadow: 0 12px 32px rgba(15, 47, 95, 0.08);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at 85% -10%, rgba(59,130,246,.13), transparent 30rem),
        var(--canvas);
      font-family: "Fira Sans", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif;
      font-size: 16px;
      line-height: 1.62;
    }
    .shell { width: min(1220px, calc(100% - 32px)); margin: 0 auto; }
    .hero {
      margin: 24px auto 18px;
      padding: 34px 38px;
      color: white;
      border-radius: 22px;
      background:
        linear-gradient(125deg, rgba(15,47,95,.98), rgba(30,64,175,.94)),
        var(--navy);
      box-shadow: 0 20px 44px rgba(15,47,95,.2);
    }
    .hero-grid { display: grid; grid-template-columns: 1.5fr .8fr; gap: 30px; align-items: end; }
    .eyebrow {
      margin: 0 0 8px;
      color: #bfd7ff;
      font: 600 12px/1.4 "Fira Code", Consolas, monospace;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    h1 { margin: 0; max-width: 820px; font-size: clamp(30px, 5vw, 52px); line-height: 1.12; letter-spacing: -.035em; }
    .hero p { max-width: 760px; margin: 18px 0 0; color: #dce9ff; }
    .meta { display: grid; gap: 10px; font-size: 14px; }
    .meta div { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,.18); }
    .meta span:first-child { color: #bcd1f2; }
    .notice {
      margin: 18px 0;
      padding: 16px 18px;
      border: 1px solid #f2cf95;
      border-left: 5px solid var(--amber);
      border-radius: 12px;
      background: #fff9ed;
      color: #68430a;
    }
    .kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
    .card, .panel {
      background: rgba(255,255,255,.96);
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: var(--shadow);
    }
    .card { padding: 19px; }
    .card .label { color: var(--muted); font-size: 13px; }
    .card .value { margin-top: 7px; font: 700 clamp(24px, 3vw, 34px)/1.1 "Fira Code", Consolas, monospace; color: var(--navy); }
    .card .hint { margin-top: 8px; font-size: 12px; color: var(--muted); }
    .positive { color: var(--green) !important; }
    .negative { color: var(--red) !important; }
    .panel { margin: 18px 0; padding: 22px; }
    .panel-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 14px; }
    h2 { margin: 0; color: var(--navy); font-size: 23px; line-height: 1.25; }
    h3 { margin: 0 0 10px; color: var(--navy); font-size: 17px; }
    .panel-head p, .muted { margin: 0; color: var(--muted); font-size: 13px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    .chart {
      width: 100%;
      min-height: 310px;
      display: block;
      overflow: visible;
      font-family: "Fira Code", Consolas, monospace;
    }
    .legend { display: flex; flex-wrap: wrap; gap: 16px; color: var(--muted); font-size: 12px; }
    .legend span::before { content: ""; display: inline-block; width: 9px; height: 9px; margin-right: 6px; border-radius: 50%; background: var(--legend); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; }
    table { width: 100%; min-width: 720px; border-collapse: collapse; background: white; font-size: 13px; }
    th { position: sticky; top: 0; z-index: 1; padding: 11px 12px; text-align: left; color: #33425c; background: var(--soft); border-bottom: 1px solid var(--line); white-space: nowrap; }
    td { padding: 10px 12px; border-bottom: 1px solid #edf1f6; white-space: nowrap; }
    tbody tr:hover { background: #f8fbff; }
    tbody tr:last-child td { border-bottom: 0; }
    .num { text-align: right; font-family: "Fira Code", Consolas, monospace; }
    .code { color: var(--blue); font-family: "Fira Code", Consolas, monospace; font-weight: 600; }
    .method { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 14px; counter-reset: method; }
    .method article { padding: 18px; border-radius: 13px; background: var(--soft); border: 1px solid #d7e4f3; }
    .method article::before { counter-increment: method; content: "0" counter(method); display: block; margin-bottom: 8px; color: var(--blue); font: 700 13px "Fira Code", monospace; }
    .files { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; }
    .file-link {
      display: flex; justify-content: space-between; gap: 12px; align-items: center;
      min-height: 48px; padding: 10px 13px; color: var(--blue); text-decoration: none;
      border: 1px solid var(--line); border-radius: 10px; background: white;
      transition: border-color .2s ease, background .2s ease;
    }
    .file-link:hover { border-color: var(--blue-2); background: #f4f8ff; }
    .file-link:focus-visible { outline: 3px solid rgba(59,130,246,.35); outline-offset: 2px; }
    footer { padding: 24px 0 40px; color: var(--muted); font-size: 12px; text-align: center; }
    @media (max-width: 900px) {
      .hero-grid, .grid-2 { grid-template-columns: 1fr; }
      .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .method { grid-template-columns: 1fr; }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 20px, 1220px); }
      .hero { padding: 26px 20px; border-radius: 16px; }
      .panel { padding: 16px; }
      .kpis, .files { grid-template-columns: 1fr; }
      .panel-head { align-items: flex-start; flex-direction: column; }
      body { font-size: 16px; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    }
    @media print {
      body { background: white; }
      .shell { width: 100%; }
      .hero, .card, .panel { box-shadow: none; break-inside: avoid; }
      .file-link { color: var(--ink); }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="hero-grid">
        <div>
          <p class="eyebrow">CSI 300 · INDEX ENHANCEMENT · INTRADAY ATTRIBUTION</p>
          <h1>沪深300指数增强与日内超额贡献报告</h1>
          <p>基于 2026-06-30 沪深300完整权重批次，以估值、120–20 日动量和低波动行业内评分构建增强组合，并使用全市场 1 分钟行情拆解个股日内超额贡献。</p>
        </div>
        <div class="meta" aria-label="报告元数据">
          <div><span>权重基准日</span><strong>${summary.benchmarkWeightDate}</strong></div>
          <div><span>分析窗口</span><strong>${summary.periodStartDate} — ${summary.periodEndDate}</strong></div>
          <div><span>成分数量</span><strong>300</strong></div>
          <div><span>分钟明细</span><strong>862,080 条</strong></div>
        </div>
      </div>
    </header>

    <aside class="notice">
      <strong>数据范围说明：</strong>本地系统目前只有 2026-06-30 一份带完整权重的沪深300批次，以及 2026-07-15 的无权重成分名单。两份名单成分一致。本报告因此是 2026 年 7 月的可验证月内样本，不代表多年历史回测。
    </aside>

    <section class="kpis" aria-label="核心指标">
      <article class="card">
        <div class="label">增强组合收益</div>
        <div class="value ${number(summary.enhancedPortfolioReturn) >= 0 ? "positive" : "negative"}">${signedPercent(summary.enhancedPortfolioReturn)}</div>
        <div class="hint">复权成分组合，月内截至 07-16</div>
      </article>
      <article class="card">
        <div class="label">成分重建基准收益</div>
        <div class="value ${number(summary.constituentBenchmarkCumulativeReturn) >= 0 ? "positive" : "negative"}">${signedPercent(summary.constituentBenchmarkCumulativeReturn)}</div>
        <div class="hint">基于 6 月 30 日权重并每日漂移</div>
      </article>
      <article class="card">
        <div class="label">主口径累计超额</div>
        <div class="value ${number(summary.constituentExcessReturn) >= 0 ? "positive" : "negative"}">${signedPercent(summary.constituentExcessReturn)}</div>
        <div class="hint">增强组合减成分重建复权基准</div>
      </article>
      <article class="card">
        <div class="label">初始主动份额</div>
        <div class="value">${percent(summary.initialActiveShare)}</div>
        <div class="hint">最大单股初始偏离 ${percentagePoint(summary.maxInitialAbsoluteWeightDeviationPct)}</div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>月内累计表现</h2><p>复权增强组合、成分权重重建基准与官方沪深300价格指数。</p></div>
        <div class="legend" aria-label="图例">
          <span style="--legend:#1e40af">增强组合</span>
          <span style="--legend:#087f5b">成分重建基准</span>
          <span style="--legend:#d97706">官方价格指数</span>
        </div>
      </div>
      <svg id="performance-chart" class="chart" viewBox="0 0 920 320" role="img" aria-label="月内累计收益折线图"></svg>
    </section>

    <section class="grid-2">
      <article class="panel">
        <div class="panel-head"><div><h2>初始权重偏离</h2><p>正值为超配，负值为低配，单位为百分点。</p></div></div>
        <svg id="active-chart" class="chart" viewBox="0 0 660 420" role="img" aria-label="主要主动权重偏离条形图"></svg>
      </article>
      <article class="panel">
        <div class="panel-head"><div><h2>日内超额贡献个股</h2><p>将 12 个交易日分钟级主动权重贡献汇总到个股。</p></div></div>
        <svg id="contribution-chart" class="chart" viewBox="0 0 660 420" role="img" aria-label="个股日内超额贡献条形图"></svg>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div><h2>${latestDate} 分时累计超额贡献</h2><p>仅统计开盘后的分钟收益，不包含隔夜跳空；停牌股票当日贡献为 0。</p></div>
        <span class="muted">覆盖 299–300 只 / 分钟</span>
      </div>
      <svg id="intraday-chart" class="chart" viewBox="0 0 920 320" role="img" aria-label="最新交易日分时累计超额贡献折线图"></svg>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>每日组合表现</h2><p>主超额口径为增强组合减成分权重重建基准。</p></div></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>日期</th><th class="num">增强累计</th><th class="num">成分基准</th><th class="num">官方指数</th><th class="num">主口径超额</th><th class="num">主动份额</th></tr></thead>
          <tbody>${dailyRows}</tbody>
        </table>
      </div>
    </section>

    <section class="grid-2">
      <article class="panel">
        <div class="panel-head"><div><h2>主要超配与低配</h2><p>展示主动偏离绝对值较大的证券。</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>证券</th><th>行业</th><th class="num">基准</th><th class="num">目标</th><th class="num">偏离</th></tr></thead>
            <tbody>${activeRows}</tbody>
          </table>
        </div>
      </article>
      <article class="panel">
        <div class="panel-head"><div><h2>日内贡献明细排名</h2><p>正负贡献各展示 8 只。</p></div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>证券</th><th>行业</th><th class="num">累计日内超额贡献</th></tr></thead>
            <tbody>${contributionRows}</tbody>
          </table>
        </div>
      </article>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>研究方法</h2><p>本报告强调可复核性，所有计算结果均可由附带 CSV 重建。</p></div></div>
      <div class="method">
        <article><h3>动态基准权重</h3><p>以 2026-06-30 官方成分权重为初值，按每只成分复权累计收益逐日漂移并重新归一化。停牌期间沿用最近可用价格。</p></article>
        <article><h3>增强权重</h3><p>在申万一级行业内分别计算估值、120–20 日动量和低波动分位分数，按 35% / 40% / 25% 合成，再通过指数权重指数倾斜生成目标组合。</p></article>
        <article><h3>分钟贡献</h3><p>以每日开盘前主动权重乘以个股分钟收益，得到个股分钟超额贡献；首分钟以当分钟开盘价为基准，因此不包含隔夜收益。</p></article>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>口径限制与解释</h2></div></div>
      <ul>
        <li>主基准是按成分复权收益重建的组合，与官方沪深300价格指数并非相同收益口径。</li>
        <li>截至 2026-07-16，增强组合相对成分重建基准超额为 <strong>${signedPercent(summary.constituentExcessReturn)}</strong>，相对官方价格指数为 <strong>${signedPercent(summary.officialIndexExcessReturn)}</strong>。</li>
        <li>未计交易成本、冲击成本、涨跌停成交限制和最小交易单位。</li>
        <li>当前只有一个完整权重批次，无法评估长期稳定性、年度换手和跨周期风险。</li>
        <li>分钟贡献采用线性加总，适合归因展示；跨分钟复利与组合真实成交路径可能存在微小差异。</li>
      </ul>
    </section>

    <section class="panel">
      <div class="panel-head"><div><h2>数据文件</h2><p>链接均为相对路径，报告文件移动时请与 CSV 保持在同一目录。</p></div></div>
      <div class="files">
        ${rows(outputFiles, ([label, file]) => `<a class="file-link" href="${file}"><span>${label}</span><span class="code">${file}</span></a>`)}
      </div>
    </section>
  </main>
  <footer>沪深300指数增强研究报告 · 生成日期 2026-07-16 · 仅供研究与系统验证</footer>

  <script>
    const DATA = ${reportData};
    const NS = "http://www.w3.org/2000/svg";
    const colors = { enhanced:"#1e40af", constituent:"#087f5b", official:"#d97706", positive:"#087f5b", negative:"#c2414b", grid:"#dbe3ef", text:"#526079" };
    const pct = value => (value * 100).toFixed(2) + "%";
    const pp = value => (value >= 0 ? "+" : "") + value.toFixed(3) + "pp";

    function lineChart(id, points, series, labelKey, valueFormatter) {
      const svg = document.getElementById(id);
      const width = 920, height = 320, left = 62, right = 24, top = 22, bottom = 44;
      const values = points.flatMap(point => series.map(item => point[item.key]));
      let min = Math.min(...values, 0), max = Math.max(...values, 0);
      const padding = Math.max((max - min) * .12, .001);
      min -= padding; max += padding;
      const x = index => left + index * (width - left - right) / Math.max(points.length - 1, 1);
      const y = value => top + (max - value) * (height - top - bottom) / (max - min || 1);
      let markup = "";
      for (let i = 0; i <= 5; i++) {
        const value = min + (max - min) * i / 5;
        const py = y(value);
        markup += '<line x1="' + left + '" y1="' + py + '" x2="' + (width-right) + '" y2="' + py + '" stroke="' + colors.grid + '" stroke-width="1"/>';
        markup += '<text x="' + (left-10) + '" y="' + (py+4) + '" text-anchor="end" fill="' + colors.text + '" font-size="11">' + valueFormatter(value) + '</text>';
      }
      points.forEach((point, index) => {
        if (index % Math.ceil(points.length / 7) === 0 || index === points.length - 1) {
          markup += '<text x="' + x(index) + '" y="' + (height-16) + '" text-anchor="middle" fill="' + colors.text + '" font-size="11">' + point[labelKey] + '</text>';
        }
      });
      for (const item of series) {
        const path = points.map((point,index) => (index ? "L" : "M") + x(index).toFixed(2) + " " + y(point[item.key]).toFixed(2)).join(" ");
        markup += '<path d="' + path + '" fill="none" stroke="' + item.color + '" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>';
        points.forEach((point,index) => {
          markup += '<circle cx="' + x(index) + '" cy="' + y(point[item.key]) + '" r="3" fill="' + item.color + '"><title>' + point[labelKey] + " · " + item.name + " " + valueFormatter(point[item.key]) + '</title></circle>';
        });
      }
      svg.innerHTML = markup;
    }

    function barChart(id, items, formatter) {
      const svg = document.getElementById(id);
      const width = 660, height = 420, left = 168, right = 42, top = 16, bottom = 20;
      const maxAbs = Math.max(...items.map(item => Math.abs(item.value)), .0001);
      const zero = left + (width-left-right)/2;
      const scale = (width-left-right)/2/maxAbs;
      const rowHeight = (height-top-bottom)/items.length;
      let markup = '<line x1="' + zero + '" y1="' + top + '" x2="' + zero + '" y2="' + (height-bottom) + '" stroke="#94a3b8"/>';
      items.forEach((item,index) => {
        const y = top + index*rowHeight + 3;
        const barWidth = Math.abs(item.value)*scale;
        const x = item.value >= 0 ? zero : zero-barWidth;
        const color = item.value >= 0 ? colors.positive : colors.negative;
        markup += '<text x="' + (left-8) + '" y="' + (y+rowHeight*.56) + '" text-anchor="end" fill="' + colors.text + '" font-size="10">' + item.label + '</text>';
        markup += '<rect x="' + x + '" y="' + y + '" width="' + Math.max(barWidth,1) + '" height="' + Math.max(rowHeight-6,5) + '" rx="3" fill="' + color + '"><title>' + item.label + " · " + formatter(item.value) + '</title></rect>';
      });
      svg.innerHTML = markup;
    }

    lineChart("performance-chart", DATA.daily, [
      {key:"enhanced",name:"增强组合",color:colors.enhanced},
      {key:"constituent",name:"成分重建基准",color:colors.constituent},
      {key:"official",name:"官方价格指数",color:colors.official}
    ], "date", pct);
    barChart("active-chart", DATA.activeWeights, pp);
    barChart("contribution-chart", DATA.contributors, value => (value*100).toFixed(4) + "%");
    lineChart("intraday-chart", DATA.latestIntraday, [
      {key:"value",name:"累计日内超额",color:colors.enhanced}
    ], "time", value => (value*100).toFixed(3) + "%");
  </script>
</body>
</html>`;

const outputPath = path.join(
  root,
  "csi300-index-enhancement-report-2026-07-16.html",
);
await fs.writeFile(outputPath, html, "utf8");
console.log(outputPath);
