import * as XLSX from 'xlsx';
import type {
  Csi1000LowPbSelectionBatch,
  Csi1000LowPbSelectionHistory,
  FactorSelectionBatch,
  FactorSelectionHistory,
  HistoricalTechnicalIndicators,
  MarketScreenerCriteria,
  MarketScreenerSnapshot,
  MarketTechnicalCandidate,
} from '../marketData/types';

export type SelectionExportFormat = 'md' | 'xlsx';

const trendLabels: Record<HistoricalTechnicalIndicators['trend'], string> = {
  bullish: '均线多头',
  aboveMa20: '站上 MA20',
  bearish: '均线空头',
  mixed: '均线交错',
};

const signalLabels = { golden: '金叉', death: '死叉', none: '无交叉' } as const;

function safeFilePart(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '-');
}

function markdownCell(value: unknown) {
  if (value == null || value === '') return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function markdownTable(headers: string[], rows: unknown[][]) {
  return [
    `| ${headers.map(markdownCell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(' | ')} |`),
  ].join('\n');
}

function formatNumber(value: number | null | undefined, digits = 2) {
  return value == null ? '—' : value.toFixed(digits);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadMarkdown(content: string, fileName: string) {
  downloadBlob(new Blob([`\uFEFF${content}`], { type: 'text/markdown;charset=utf-8' }), fileName);
}

function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string) {
  const content = XLSX.write(workbook, { type: 'array', bookType: 'xlsx', cellStyles: true });
  downloadBlob(new Blob([content], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }), fileName);
}

const criteriaLabels: Array<[keyof MarketScreenerCriteria, string, string?]> = [
  ['markets', '市场'],
  ['minChangePct', '涨幅下限', '%'],
  ['maxChangePct', '涨幅上限', '%'],
  ['minAmountYi', '最小成交额', ' 亿'],
  ['minTurnoverPct', '最小换手率', '%'],
  ['minVolumeRatio', '最小量比'],
  ['maxAmplitudePct', '最大振幅', '%'],
  ['trend', '均线趋势'],
  ['returnPeriod', '阶段周期', ' 日'],
  ['minPeriodReturn', '阶段涨幅下限', '%'],
  ['maxPeriodReturn', '阶段涨幅上限', '%'],
  ['streakDirection', '连续涨跌'],
  ['minStreakDays', '最少连续天数', ' 天'],
  ['minRsi', 'RSI14 下限'],
  ['maxRsi', 'RSI14 上限'],
  ['kdjSignal', 'KDJ 信号'],
  ['macdSignal', 'MACD 信号'],
  ['limit', '结果数量', ' 只'],
  ['excludeRiskNames', '排除 ST / 退市风险名称'],
];

function criteriaValue(criteria: MarketScreenerCriteria, key: keyof MarketScreenerCriteria, suffix = '') {
  const value = criteria[key];
  if (Array.isArray(value)) return value.join('、');
  if (typeof value === 'boolean') return value ? '是' : '否';
  const labels: Record<string, string> = {
    any: '不限', bullish: '均线多头', aboveMa20: '站上 MA20', bearish: '均线空头',
    up: '连续上涨', down: '连续下跌', golden: '金叉', death: '死叉',
  };
  return `${labels[String(value)] ?? String(value)}${suffix}`;
}

function technicalRows(snapshot: MarketScreenerSnapshot) {
  return snapshot.items.map((item, index) => ({
    排名: index + 1,
    股票代码: item.code,
    股票名称: item.name,
    市场: item.market,
    最新价: item.price,
    涨跌幅百分比: item.changePct,
    技术分: item.technicalScore,
    均线趋势: item.indicators ? trendLabels[item.indicators.trend] : '数据不足',
    五日涨跌幅百分比: item.indicators?.return5d ?? null,
    十日涨跌幅百分比: item.indicators?.return10d ?? null,
    二十日涨跌幅百分比: item.indicators?.return20d ?? null,
    连续涨跌天数: item.indicators?.streak ?? null,
    RSI14: item.indicators?.rsi14 ?? null,
    KDJ信号: item.indicators ? signalLabels[item.indicators.kdjSignal] : '—',
    MACD信号: item.indicators ? signalLabels[item.indicators.macdSignal] : '—',
    成交额亿元: item.amountYi,
    换手率百分比: item.turnoverPct,
    振幅百分比: item.amplitudePct,
    量比: item.volumeRatio,
    匹配信号: item.matchedSignals.join('；'),
    指标日期: item.indicators?.asOf ?? null,
  }));
}

export function buildTechnicalSelectionMarkdown(
  snapshot: MarketScreenerSnapshot,
  criteria: MarketScreenerCriteria,
) {
  const rows = snapshot.items.map((item, index) => [
    index + 1,
    item.code,
    item.name,
    item.market,
    formatNumber(item.price),
    item.changePct == null ? '—' : `${formatNumber(item.changePct)}%`,
    formatNumber(item.technicalScore),
    item.indicators ? trendLabels[item.indicators.trend] : '数据不足',
    item.indicators ? `${formatNumber(item.indicators.return5d)}% / ${formatNumber(item.indicators.return10d)}% / ${formatNumber(item.indicators.return20d)}%` : '—',
    item.indicators?.streak ?? '—',
    formatNumber(item.indicators?.rsi14),
    item.indicators ? signalLabels[item.indicators.kdjSignal] : '—',
    item.indicators ? signalLabels[item.indicators.macdSignal] : '—',
    item.matchedSignals.join('；'),
  ]);
  const filterRows = criteriaLabels.map(([key, label, suffix]) => [label, criteriaValue(criteria, key, suffix)]);
  return [
    '# 技术选股结果',
    '',
    `- 结果时间：${new Date(snapshot.updatedAt).toLocaleString('zh-CN')}`,
    `- 扫描数量：${snapshot.totalScanned} 只`,
    `- 日 K 分析：${snapshot.totalEnriched} 只`,
    `- 命中数量：${snapshot.items.length} 只`,
    '',
    '## 筛选条件',
    '',
    markdownTable(['条件', '设置'], filterRows),
    '',
    '## 选股明细',
    '',
    markdownTable(['排名', '代码', '名称', '市场', '最新价', '涨跌幅', '技术分', '均线趋势', '5/10/20 日', '连续涨跌', 'RSI14', 'KDJ', 'MACD', '匹配信号'], rows),
    '',
  ].join('\n');
}

export function exportTechnicalSelection(
  snapshot: MarketScreenerSnapshot,
  criteria: MarketScreenerCriteria,
  format: SelectionExportFormat,
) {
  const stamp = snapshot.updatedAt.slice(0, 10);
  const baseName = safeFilePart(`技术选股结果-${stamp}`);
  if (format === 'md') {
    downloadMarkdown(buildTechnicalSelectionMarkdown(snapshot, criteria), `${baseName}.md`);
    return `${baseName}.md`;
  }

  const workbook = XLSX.utils.book_new();
  const resultSheet = XLSX.utils.json_to_sheet(technicalRows(snapshot));
  resultSheet['!cols'] = [6, 12, 14, 8, 10, 12, 10, 12, 14, 14, 14, 12, 10, 10, 12, 12, 12, 10, 36, 12].map((wch) => ({ wch }));
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['项目', '内容'],
    ['结果时间', new Date(snapshot.updatedAt).toLocaleString('zh-CN')],
    ['扫描数量', snapshot.totalScanned],
    ['日 K 分析数量', snapshot.totalEnriched],
    ['命中数量', snapshot.items.length],
    [],
    ['筛选条件', '设置'],
    ...criteriaLabels.map(([key, label, suffix]) => [label, criteriaValue(criteria, key, suffix)]),
  ]);
  infoSheet['!cols'] = [{ wch: 24 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(workbook, resultSheet, '选股结果');
  XLSX.utils.book_append_sheet(workbook, infoSheet, '导出信息');
  downloadWorkbook(workbook, `${baseName}.xlsx`);
  return `${baseName}.xlsx`;
}

function factorRows(batch: FactorSelectionBatch) {
  return batch.items.map((item) => ({
    排名: item.rank,
    股票代码: item.code,
    股票名称: item.name,
    市场: item.market,
    行业: item.industry,
    综合得分: item.selectionScore,
    有效因子数: item.factorCount,
    入选价: item.selectedPrice,
    最新价: item.latestPrice,
    入选收益百分比: item.returnSinceSelectionPct,
    财务数据截至: item.financialAsOf,
  }));
}

export function buildFactorSelectionMarkdown(history: FactorSelectionHistory, batch: FactorSelectionBatch) {
  return [
    `# ${history.strategy}选股结果`,
    '',
    `- 选股日期：${batch.tradeDate}`,
    `- 数据截至：${history.dataAsOf}`,
    `- 入选数量：${batch.items.length} 只`,
    `- 平均入选收益：${formatNumber(batch.averageReturnPct)}%`,
    `- 上涨数量：${batch.positiveCount} / ${batch.items.length}`,
    `- 处理流程：${history.methodology.processing.join(' → ')}`,
    '',
    '## 选股明细',
    '',
    markdownTable(
      ['排名', '代码', '名称', '市场', '行业', '综合得分', '有效因子', '入选价', '最新价', '入选收益', '财务数据截至'],
      batch.items.map((item) => [
        item.rank, item.code, item.name, item.market, item.industry,
        item.selectionScore.toFixed(4), `${item.factorCount} / ${history.methodology.factorCount}`,
        item.selectedPrice.toFixed(2), item.latestPrice.toFixed(2),
        `${formatNumber(item.returnSinceSelectionPct)}%`, item.financialAsOf,
      ]),
    ),
    '',
  ].join('\n');
}

export function exportFactorSelection(
  history: FactorSelectionHistory,
  batch: FactorSelectionBatch,
  format: SelectionExportFormat,
) {
  const baseName = safeFilePart(`${history.strategy}选股结果-${batch.tradeDate}`);
  if (format === 'md') {
    downloadMarkdown(buildFactorSelectionMarkdown(history, batch), `${baseName}.md`);
    return `${baseName}.md`;
  }

  const workbook = XLSX.utils.book_new();
  const resultSheet = XLSX.utils.json_to_sheet(factorRows(batch));
  resultSheet['!cols'] = [6, 12, 14, 8, 16, 12, 12, 10, 10, 14, 16].map((wch) => ({ wch }));
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['项目', '内容'],
    ['策略', history.strategy],
    ['选股日期', batch.tradeDate],
    ['数据截至', history.dataAsOf],
    ['快照生成时间', new Date(history.generatedAt).toLocaleString('zh-CN')],
    ['入选数量', batch.items.length],
    ['平均入选收益（%）', batch.averageReturnPct],
    ['上涨数量', batch.positiveCount],
    ['因子数量', history.methodology.factorCount],
    ['最少有效因子', history.methodology.minimumFactorCount],
    ['处理流程', history.methodology.processing.join(' → ')],
  ]);
  infoSheet['!cols'] = [{ wch: 22 }, { wch: 64 }];
  XLSX.utils.book_append_sheet(workbook, resultSheet, '选股结果');
  XLSX.utils.book_append_sheet(workbook, infoSheet, '导出信息');
  downloadWorkbook(workbook, `${baseName}.xlsx`);
  return `${baseName}.xlsx`;
}

function csi1000LowPbRows(batch: Csi1000LowPbSelectionBatch) {
  return batch.items.map((item) => ({
    排名: item.rank,
    股票代码: item.code,
    股票名称: item.name,
    市场: item.market,
    行业: item.industry,
    PB: item.pb,
    总市值亿元: item.totalMarketCapYi,
    等权权重百分比: item.portfolioWeightPct,
    入选价: item.selectedPrice,
    最新价: item.latestPrice,
    调仓后收益百分比: item.returnSinceSelectionPct,
  }));
}

export function buildCsi1000LowPbSelectionMarkdown(
  history: Csi1000LowPbSelectionHistory,
  batch: Csi1000LowPbSelectionBatch,
) {
  return [
    `# ${history.strategy}选股结果`,
    '',
    `- 调仓日期：${batch.rebalanceDate}`,
    `- 成分日期：${batch.constituentDate}`,
    `- 数据截至：${history.dataAsOf}`,
    `- 入选数量：${batch.items.length} 只`,
    `- 组合平均 PB：${batch.averagePb.toFixed(3)}`,
    `- 调仓后等权收益：${formatNumber(batch.averageReturnPct)}%`,
    `- 上涨数量：${batch.positiveCount} / ${batch.items.length}`,
    `- 处理流程：${history.methodology.processing.join(' → ')}`,
    `- 风险提示：${history.methodology.caveats.join('；')}`,
    '',
    '## 选股明细',
    '',
    markdownTable(
      ['排名', '代码', '名称', '市场', '行业', 'PB', '总市值（亿元）', '等权权重', '入选价', '最新价', '调仓后收益'],
      batch.items.map((item) => [
        item.rank, item.code, item.name, item.market, item.industry,
        item.pb.toFixed(3), item.totalMarketCapYi.toFixed(2),
        `${item.portfolioWeightPct.toFixed(2)}%`, item.selectedPrice.toFixed(2),
        item.latestPrice.toFixed(2), `${formatNumber(item.returnSinceSelectionPct)}%`,
      ]),
    ),
    '',
  ].join('\n');
}

export function exportCsi1000LowPbSelection(
  history: Csi1000LowPbSelectionHistory,
  batch: Csi1000LowPbSelectionBatch,
  format: SelectionExportFormat,
) {
  const baseName = safeFilePart(`${history.strategy}选股结果-${batch.rebalanceDate}`);
  if (format === 'md') {
    downloadMarkdown(buildCsi1000LowPbSelectionMarkdown(history, batch), `${baseName}.md`);
    return `${baseName}.md`;
  }

  const workbook = XLSX.utils.book_new();
  const resultSheet = XLSX.utils.json_to_sheet(csi1000LowPbRows(batch));
  resultSheet['!cols'] = [6, 12, 14, 8, 16, 10, 14, 14, 10, 10, 16].map((wch) => ({ wch }));
  const infoSheet = XLSX.utils.aoa_to_sheet([
    ['项目', '内容'],
    ['策略', history.strategy],
    ['指数', `${history.methodology.indexName}（${history.methodology.indexCode}）`],
    ['调仓日期', batch.rebalanceDate],
    ['成分日期', batch.constituentDate],
    ['数据截至', history.dataAsOf],
    ['研究快照', history.snapshotId],
    ['成分快照', batch.constituentSnapshotId],
    ['入选数量', batch.items.length],
    ['组合平均 PB', batch.averagePb],
    ['调仓后等权收益（%）', batch.averageReturnPct],
    ['处理流程', history.methodology.processing.join(' → ')],
    ['风险提示', history.methodology.caveats.join('；')],
  ]);
  infoSheet['!cols'] = [{ wch: 22 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, resultSheet, '选股结果');
  XLSX.utils.book_append_sheet(workbook, infoSheet, '策略与数据口径');
  downloadWorkbook(workbook, `${baseName}.xlsx`);
  return `${baseName}.xlsx`;
}
