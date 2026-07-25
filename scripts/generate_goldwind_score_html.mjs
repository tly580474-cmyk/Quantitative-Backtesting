import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateSelectionScore } from '../src/features/marketData/selectionScore.ts';

const EASTMONEY_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=0.002202&klt=101&fqt=1&beg=20240101&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
const THRESHOLD = 80;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(scriptDir, '../tmp_output/金风科技_过去一年评分大于80节点.html');

const response = await fetch(EASTMONEY_URL, {
  headers: {
    Referer: 'https://quote.eastmoney.com/',
    'User-Agent': 'Mozilla/5.0',
  },
});
if (!response.ok) throw new Error(`行情请求失败：HTTP ${response.status}`);
const payload = await response.json();
if (!payload?.data?.klines?.length) throw new Error('行情返回为空');

const candles = payload.data.klines.map((line) => {
  const [date, open, close, high, low, volume, amount, amplitude, changePct, change, turnover] = line.split(',');
  return {
    date,
    open: Number(open),
    close: Number(close),
    high: Number(high),
    low: Number(low),
    volume: Number(volume),
    amount: Number(amount),
    amplitude: Number(amplitude),
    changePct: Number(changePct),
    change: Number(change),
    turnoverRatePct: Number(turnover),
  };
});

const latest = candles.at(-1);
const periodStartDate = new Date(`${latest.date}T00:00:00Z`);
periodStartDate.setUTCFullYear(periodStartDate.getUTCFullYear() - 1);
const periodStart = periodStartDate.toISOString().slice(0, 10);
const firstPeriodIndex = candles.findIndex((item) => item.date >= periodStart);
const yearCandles = candles.slice(firstPeriodIndex);

const scores = candles.map((_, index) => (
  calculateSelectionScore(candles.slice(0, index + 1), [])
));
const yearScores = scores.slice(firstPeriodIndex).map((result) => result.score);
const nodes = [];
for (let index = firstPeriodIndex; index < candles.length; index += 1) {
  const result = scores[index];
  if (result.score == null || result.score <= THRESHOLD) continue;
  const factorItems = result.sections
    .filter((section) => section.key !== 'risk')
    .flatMap((section) => section.items)
    .sort((left, right) => right.points - left.points);
  const forwardIndex = index + 10;
  nodes.push({
    index: index - firstPeriodIndex,
    date: candles[index].date,
    score: result.score,
    close: candles[index].close,
    changePct: candles[index].changePct,
    amountYi: candles[index].amount / 100_000_000,
    turnover: candles[index].turnoverRatePct,
    forward10d: forwardIndex < candles.length
      ? candles[forwardIndex].close / candles[index].close - 1
      : null,
    topFactors: factorItems.slice(0, 3).map((item) => ({
      label: item.label,
      points: item.points,
      detail: item.detail,
    })),
  });
}

const maximumNode = nodes.reduce((best, item) => !best || item.score > best.score ? item : best, null);
const completedForwardNodes = nodes.filter((item) => item.forward10d != null);
const positiveForwardRate = completedForwardNodes.length
  ? completedForwardNodes.filter((item) => item.forward10d > 0).length / completedForwardNodes.length
  : null;
const averageForward10d = completedForwardNodes.length
  ? completedForwardNodes.reduce((sum, item) => sum + item.forward10d, 0) / completedForwardNodes.length
  : null;
const episodes = nodes.reduce((count, item, index) => {
  if (index === 0) return 1;
  return item.index - nodes[index - 1].index > 1 ? count + 1 : count;
}, 0);

const chartData = yearCandles.map((item, index) => ({
  ...item,
  score: yearScores[index],
}));
const serializedChartData = JSON.stringify(chartData).replaceAll('<', '\\u003c');
const serializedNodes = JSON.stringify(nodes).replaceAll('<', '\\u003c');
const generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });

function formatPercent(value) {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;
}

function nodeRows() {
  if (!nodes.length) {
    return '<tr><td colspan="8" class="empty">过去一年没有评分严格大于 80 的交易日。</td></tr>';
  }
  return nodes.map((node) => `
    <tr>
      <td><time>${node.date}</time></td>
      <td><strong class="score-pill">${node.score}</strong></td>
      <td>${node.close.toFixed(2)}</td>
      <td class="${node.changePct >= 0 ? 'up' : 'down'}">${node.changePct >= 0 ? '+' : ''}${node.changePct.toFixed(2)}%</td>
      <td>${node.amountYi.toFixed(2)} 亿</td>
      <td>${node.turnover.toFixed(2)}%</td>
      <td class="${node.forward10d == null ? '' : node.forward10d >= 0 ? 'up' : 'down'}">${formatPercent(node.forward10d)}</td>
      <td>${node.topFactors.map((factor) => `<span class="factor">${factor.label} +${factor.points}</span>`).join('')}</td>
    </tr>
  `).join('');
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>金风科技｜过去一年评分大于 80 节点</title>
  <style>
    :root {
      --ink: #172033;
      --muted: #697386;
      --line: #e6e9ef;
      --panel: #ffffff;
      --wash: #f5f7fa;
      --red: #d92d20;
      --red-soft: #fff0ee;
      --green: #079455;
      --gold: #b54708;
      --navy: #253b5b;
      --shadow: 0 14px 40px rgba(23, 32, 51, .08);
    }
    * { box-sizing: border-box; }
    html { background: var(--wash); }
    body {
      margin: 0;
      color: var(--ink);
      font: 14px/1.55 Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
    }
    main { width: min(1440px, calc(100% - 32px)); margin: 28px auto 56px; }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      padding: 28px 30px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: linear-gradient(135deg, #fff 0%, #fff 65%, #f8eee9 100%);
      box-shadow: var(--shadow);
    }
    .eyebrow { margin: 0 0 8px; color: var(--red); font-size: 12px; font-weight: 800; letter-spacing: .12em; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 48px); line-height: 1.12; letter-spacing: -.035em; }
    .subtitle { margin: 12px 0 0; color: var(--muted); font-size: 15px; }
    .symbol { display: inline-flex; margin-left: 10px; padding: 4px 9px; border-radius: 99px; background: #edf2f7; color: var(--navy); font-size: 13px; vertical-align: middle; }
    .asof { color: var(--muted); text-align: right; white-space: nowrap; }
    .asof strong { display: block; color: var(--ink); font-size: 20px; }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 16px 0; }
    .metric { padding: 18px 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--panel); }
    .metric span { display: block; color: var(--muted); font-size: 12px; }
    .metric strong { display: block; margin-top: 5px; font-size: 25px; letter-spacing: -.02em; }
    .metric.primary { border-color: #f4c7c2; background: var(--red-soft); }
    .metric.primary strong { color: var(--red); }
    .panel { margin-top: 16px; border: 1px solid var(--line); border-radius: 18px; background: var(--panel); box-shadow: var(--shadow); overflow: hidden; }
    .panel-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 20px 24px 12px; }
    .panel-head h2 { margin: 0; font-size: 18px; }
    .panel-head p { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .legend { display: flex; flex-wrap: wrap; gap: 14px; color: var(--muted); font-size: 12px; }
    .legend span::before { content: ""; display: inline-block; width: 9px; height: 9px; margin-right: 6px; border-radius: 2px; }
    .legend .rise::before { background: var(--red); }
    .legend .fall::before { background: var(--green); }
    .legend .mark::before { border-radius: 50%; background: #ffb020; box-shadow: 0 0 0 2px var(--red); }
    .chart-wrap { position: relative; height: 520px; margin: 0 16px 10px; border-top: 1px solid var(--line); }
    canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
    .tooltip {
      position: absolute;
      z-index: 3;
      display: none;
      min-width: 210px;
      padding: 10px 12px;
      border: 1px solid #d8dde6;
      border-radius: 10px;
      background: rgba(255,255,255,.96);
      box-shadow: 0 10px 24px rgba(23,32,51,.14);
      pointer-events: none;
      font-size: 12px;
    }
    .tooltip strong { display: block; margin-bottom: 4px; font-size: 13px; }
    .tooltip-grid { display: grid; grid-template-columns: auto auto; gap: 2px 12px; color: var(--muted); }
    .node-strip { display: flex; gap: 8px; overflow-x: auto; padding: 2px 24px 18px; scrollbar-width: thin; }
    .node-chip { flex: 0 0 auto; padding: 7px 10px; border: 1px solid #f0bbb5; border-radius: 9px; background: var(--red-soft); color: #8f241c; font: inherit; cursor: pointer; }
    .node-chip:hover, .node-chip:focus-visible { outline: 2px solid #f5a8a0; outline-offset: 1px; }
    .node-chip b { color: var(--red); }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 1060px; }
    th, td { padding: 12px 14px; border-top: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { position: sticky; top: 0; background: #f8fafc; color: var(--muted); font-size: 12px; font-weight: 700; }
    tbody tr:hover { background: #fffafa; }
    .score-pill { display: inline-grid; min-width: 34px; height: 28px; place-items: center; border-radius: 8px; background: var(--red); color: #fff; }
    .factor { display: inline-block; margin: 0 5px 4px 0; padding: 2px 7px; border-radius: 99px; background: #edf2f7; color: #44546a; font-size: 11px; white-space: nowrap; }
    .up { color: var(--red); font-weight: 650; }
    .down { color: var(--green); font-weight: 650; }
    .empty { padding: 36px; text-align: center; color: var(--muted); }
    .notes { display: grid; grid-template-columns: 1.2fr 1fr; gap: 18px; padding: 22px 24px; }
    .notes h3 { margin: 0 0 8px; font-size: 14px; }
    .notes p, .notes li { color: var(--muted); font-size: 12px; }
    .notes ul { margin: 0; padding-left: 18px; }
    .stamp { margin-top: 14px; color: #98a2b3; font-size: 11px; text-align: right; }
    @media (max-width: 900px) {
      main { width: min(100% - 18px, 1440px); margin-top: 10px; }
      .hero { grid-template-columns: 1fr; padding: 22px; }
      .asof { text-align: left; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .chart-wrap { height: 430px; margin-inline: 6px; }
      .notes { grid-template-columns: 1fr; }
      .panel-head { flex-direction: column; }
    }
    @media print {
      body { background: #fff; }
      main { width: 100%; margin: 0; }
      .hero, .panel, .metric { box-shadow: none; }
      .chart-wrap { height: 420px; }
      .node-strip { display: none; }
    }
  </style>
</head>
<body>
<main>
  <header class="hero">
    <div>
      <p class="eyebrow">DATA-DRIVEN REVERSAL SCORE</p>
      <h1>金风科技<span class="symbol">002202.SZ</span></h1>
      <p class="subtitle">过去一年日 K 中，选股评分严格大于 ${THRESHOLD} 分的节点标记</p>
    </div>
    <div class="asof">行情截至<strong>${latest.date}</strong>前复权日线</div>
  </header>

  <section class="metrics" aria-label="统计摘要">
    <div class="metric primary"><span>高分交易日</span><strong>${nodes.length}</strong></div>
    <div class="metric"><span>独立高分阶段</span><strong>${episodes}</strong></div>
    <div class="metric"><span>最高评分</span><strong>${maximumNode ? `${maximumNode.score}` : '—'}</strong></div>
    <div class="metric"><span>节点后 10 日平均</span><strong class="${averageForward10d == null ? '' : averageForward10d >= 0 ? 'up' : 'down'}">${formatPercent(averageForward10d)}</strong></div>
    <div class="metric"><span>节点后 10 日上涨率</span><strong>${positiveForwardRate == null ? '—' : `${(positiveForwardRate * 100).toFixed(1)}%`}</strong></div>
  </section>

  <section class="panel" aria-labelledby="chart-title">
    <div class="panel-head">
      <div>
        <h2 id="chart-title">过去一年日 K 与高分节点</h2>
        <p>${periodStart} 至 ${latest.date}，共 ${yearCandles.length} 个交易日；鼠标悬停查看当日行情与评分。</p>
      </div>
      <div class="legend" aria-label="图例">
        <span class="rise">上涨 K 线</span>
        <span class="fall">下跌 K 线</span>
        <span class="mark">评分 &gt; ${THRESHOLD}</span>
      </div>
    </div>
    <div class="chart-wrap" id="chartWrap">
      <canvas id="chart" aria-label="金风科技过去一年日 K 图"></canvas>
      <div class="tooltip" id="tooltip"></div>
    </div>
    <div class="node-strip" id="nodeStrip" aria-label="高分节点快捷定位"></div>
  </section>

  <section class="panel" aria-labelledby="table-title">
    <div class="panel-head">
      <div>
        <h2 id="table-title">评分大于 ${THRESHOLD} 的全部节点</h2>
        <p>“后 10 日表现”为节点收盘价到第 10 个后续交易日收盘价的实际涨跌，仅用于复盘。</p>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>日期</th><th>评分</th><th>收盘价</th><th>当日涨跌</th><th>成交额</th><th>换手率</th><th>后 10 日表现</th><th>主要贡献因子</th></tr></thead>
        <tbody>${nodeRows()}</tbody>
      </table>
    </div>
  </section>

  <section class="panel notes" aria-label="口径说明">
    <div>
      <h3>评分口径</h3>
      <p>采用系统当前的中期反转评分：突破强度、均量比、换手率、RSI、20 日收益、波幅比、当日量比、MA60 斜率、价格相对 MA20 距离，共 9 个可用量价因子。各因子按最近最多 252 个历史观测转换为方向调整后的分位，再按研究报告中的 |Rank ICIR| 加权。</p>
    </div>
    <div>
      <h3>阅读提示</h3>
      <ul>
        <li>本页筛选条件是评分严格大于 ${THRESHOLD}，等于 ${THRESHOLD} 不计入。</li>
        <li>PB 历史数据未进入页面评分，其权重由其他可用因子重新归一化。</li>
        <li>高分是研究信号，不等于买入建议；模型建议约 10 个交易日观察周期。</li>
      </ul>
      <div class="stamp">数据：东方财富前复权日 K｜生成时间：${generatedAt}</div>
    </div>
  </section>
</main>
<script>
  const data = ${serializedChartData};
  const nodes = ${serializedNodes};
  const canvas = document.getElementById('chart');
  const wrap = document.getElementById('chartWrap');
  const tooltip = document.getElementById('tooltip');
  const strip = document.getElementById('nodeStrip');
  let focusIndex = null;

  nodes.forEach((node) => {
    const button = document.createElement('button');
    button.className = 'node-chip';
    button.type = 'button';
    button.innerHTML = node.date.slice(5) + ' · <b>' + node.score + '</b>';
    button.addEventListener('click', () => { focusIndex = node.index; draw(); showTooltip(node.index, true); });
    strip.appendChild(button);
  });
  if (!nodes.length) {
    strip.innerHTML = '<span style="color:#697386">过去一年无高分节点</span>';
  }

  function layout() {
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width: rect.width, height: rect.height, left: 58, right: 60, top: 28, bottom: 42 };
  }

  function scales(box) {
    const min = Math.min(...data.map(d => d.low));
    const max = Math.max(...data.map(d => d.high));
    const pad = (max - min) * .08 || 1;
    const low = min - pad;
    const high = max + pad;
    const plotW = box.width - box.left - box.right;
    const plotH = box.height - box.top - box.bottom;
    return {
      x: (index) => box.left + (index + .5) / data.length * plotW,
      y: (price) => box.top + (high - price) / (high - low) * plotH,
      low, high, plotW, plotH,
    };
  }

  function draw() {
    const box = layout();
    const { ctx, width, height } = box;
    const scale = scales(box);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px Inter, "PingFang SC", sans-serif';
    ctx.textBaseline = 'middle';

    for (let step = 0; step <= 5; step++) {
      const price = scale.low + (scale.high - scale.low) * step / 5;
      const y = scale.y(price);
      ctx.strokeStyle = '#edf0f4';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(box.left, y); ctx.lineTo(width - box.right, y); ctx.stroke();
      ctx.fillStyle = '#7b8494';
      ctx.textAlign = 'right';
      ctx.fillText(price.toFixed(2), width - 8, y);
    }

    const tickEvery = Math.max(1, Math.round(data.length / 8));
    data.forEach((item, index) => {
      if (index % tickEvery !== 0 && index !== data.length - 1) return;
      const x = scale.x(index);
      ctx.strokeStyle = '#f2f4f7';
      ctx.beginPath(); ctx.moveTo(x, box.top); ctx.lineTo(x, height - box.bottom); ctx.stroke();
      ctx.fillStyle = '#7b8494';
      ctx.textAlign = 'center';
      ctx.fillText(item.date.slice(5), x, height - 18);
    });

    const candleWidth = Math.max(1.5, Math.min(7, scale.plotW / data.length * .68));
    data.forEach((item, index) => {
      const x = scale.x(index);
      const rising = item.close >= item.open;
      const color = rising ? '#d92d20' : '#079455';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, scale.y(item.high)); ctx.lineTo(x, scale.y(item.low)); ctx.stroke();
      const top = scale.y(Math.max(item.open, item.close));
      const bottom = scale.y(Math.min(item.open, item.close));
      ctx.fillRect(x - candleWidth / 2, top, candleWidth, Math.max(1, bottom - top));
    });

    nodes.forEach((node) => {
      const item = data[node.index];
      const x = scale.x(node.index);
      const y = scale.y(item.high) - 12;
      ctx.fillStyle = '#ffb020';
      ctx.strokeStyle = '#d92d20';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (nodes.length <= 18 || node === nodes.at(-1) || node === nodes[0]) {
        ctx.fillStyle = '#a3261d';
        ctx.textAlign = 'center';
        ctx.font = '700 10px Inter, sans-serif';
        ctx.fillText(String(node.score), x, y - 11);
      }
    });

    if (focusIndex != null && data[focusIndex]) {
      const x = scale.x(focusIndex);
      ctx.strokeStyle = '#7b8494';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(x, box.top); ctx.lineTo(x, height - box.bottom); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function showTooltip(index, pinned = false, event) {
    const item = data[index];
    if (!item) return;
    focusIndex = index;
    const node = nodes.find(entry => entry.index === index);
    tooltip.innerHTML =
      '<strong>' + item.date + (node ? ' · 高分节点' : '') + '</strong>' +
      '<div class="tooltip-grid">' +
      '<span>开 / 高</span><b>' + item.open.toFixed(2) + ' / ' + item.high.toFixed(2) + '</b>' +
      '<span>低 / 收</span><b>' + item.low.toFixed(2) + ' / ' + item.close.toFixed(2) + '</b>' +
      '<span>涨跌</span><b class="' + (item.changePct >= 0 ? 'up' : 'down') + '">' + (item.changePct >= 0 ? '+' : '') + item.changePct.toFixed(2) + '%</b>' +
      '<span>换手率</span><b>' + item.turnoverRatePct.toFixed(2) + '%</b>' +
      '<span>评分</span><b>' + (item.score == null ? '—' : item.score) + '</b>' +
      '</div>';
    tooltip.style.display = 'block';
    const rect = wrap.getBoundingClientRect();
    const x = event ? event.clientX - rect.left : rect.width * (index + .5) / data.length;
    const y = event ? event.clientY - rect.top : 90;
    tooltip.style.left = Math.max(8, Math.min(rect.width - 228, x + 14)) + 'px';
    tooltip.style.top = Math.max(8, Math.min(rect.height - 150, y + 14)) + 'px';
    if (pinned) draw();
  }

  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const left = 58;
    const right = 60;
    const ratio = (event.clientX - rect.left - left) / Math.max(1, rect.width - left - right);
    const index = Math.max(0, Math.min(data.length - 1, Math.floor(ratio * data.length)));
    showTooltip(index, false, event);
    draw();
  });
  canvas.addEventListener('pointerleave', () => {
    focusIndex = null;
    tooltip.style.display = 'none';
    draw();
  });
  window.addEventListener('resize', draw);
  draw();
</script>
</body>
</html>`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html, 'utf8');
console.log(JSON.stringify({
  outputPath,
  instrument: payload.data.name,
  periodStart,
  periodEnd: latest.date,
  tradingDays: yearCandles.length,
  threshold: `>${THRESHOLD}`,
  nodes: nodes.length,
  episodes,
  maximumNode,
  averageForward10d,
  positiveForwardRate,
}, null, 2));
