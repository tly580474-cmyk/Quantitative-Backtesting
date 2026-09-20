import { sanitizePublicContent } from './eventProtocol.js';

interface Daily { date: string; net: number | null; samples: number; expected: number | null; }
interface Rank { symbol: string; name: string; net: number; days: number; }
export interface FundFlowEvidence {
  scope: string; daily: Daily[]; inflows: Rank[]; outflows: Rank[];
  sources: string[]; complete: boolean;
}
const clean = (value: unknown) => sanitizePublicContent(String(value ?? '')).replace(/[|\r\n]/g, ' ').slice(0, 180);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Allowlisted data only, extracted before provider display truncation. */
export function fundFlowEvidence(output: unknown): FundFlowEvidence | undefined {
  try {
    const text = Array.isArray(output) ? output.map(item => item?.text ?? '').join('\n') : output;
    let data = typeof text === 'string' ? JSON.parse(text) : text;
    if (typeof data?.output === 'string') data = JSON.parse(data.output);
    if (data?.kind !== 'research-data' || data?.dataset !== 'fund_flows' || data?.ok !== true
      || data?.usable !== true || data?.unit !== '亿元' || data?.requested?.group !== 'stock'
      || !Array.isArray(data.daily) || !data.daily.length || data.daily.length > 60) return;
    const daily: Daily[] = data.daily.map((row: any) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate) || !(row.mainNetInYi === null || finite(row.mainNetInYi))
        || !finite(row.sampleCount) || !(row.expectedCount === null || finite(row.expectedCount))) throw new Error('Invalid daily data');
      return { date: row.tradeDate, net: row.mainNetInYi, samples: row.sampleCount, expected: row.expectedCount };
    });
    const ranks = (items: any): Rank[] => {
      if (!Array.isArray(items) || items.length > 50) throw new Error('Invalid ranking');
      return items.map(row => {
        if (!/^\d{6}$/.test(row.symbol) || !finite(row.mainNetInYi) || !finite(row.daysCovered)) throw new Error('Invalid rank');
        return { symbol: row.symbol, name: clean(row.name), net: row.mainNetInYi, days: row.daysCovered };
      });
    };
    return { scope: JSON.stringify([data.requested.symbol ?? '*', daily]), daily,
      inflows: ranks(data.topInflow), outflows: ranks(data.topOutflow), complete: data.windowComplete === true,
      sources: (Array.isArray(data.source?.providers) ? data.source.providers : []).slice(0, 10).map((row: any) =>
        `${clean(row.sourceKey)} / ${clean(row.sourceVersion)}；最新采集 ${clean(row.latestFetchedAtShanghai ?? row.latestFetchedAtUtc ?? '未知时区')}（带显式时区）`),
    };
  } catch { return undefined; }
}

/** Narrow check: recognizable daily net-amount tables explicitly denominated in 亿元. */
export function fundFlowAmountMismatch(content: string, evidence: FundFlowEvidence): boolean {
  let dateColumn = -1; let amountColumn = -1; let inYi = false; let headingYi = false;
  for (const line of content.split('\n')) {
    if (/^\s*#/.test(line)) headingYi = line.includes('亿元');
    if (!line.includes('|')) { if (line.trim()) { dateColumn = -1; amountColumn = -1; } continue; }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim().replace(/[*`]/g, ''));
    const dateHeader = cells.findIndex(cell => /^(?:交易日|业务日期|日期)/.test(cell));
    const amountHeader = cells.findIndex(cell => /主力.*(?:净额|净流入|净流向)|^净额/.test(cell));
    if (dateHeader >= 0 && amountHeader >= 0) {
      dateColumn = dateHeader; amountColumn = amountHeader;
      inYi = cells[amountHeader].includes('亿元') || (!cells[amountHeader].includes('元') && headingYi);
      continue;
    }
    if (dateColumn < 0 || amountColumn < 0 || !inYi) continue;
    const date = cells[dateColumn]?.match(/(?:\d{4}-)?\d{2}-\d{2}/)?.[0];
    const row = date && evidence.daily.find(item => item.date === date || item.date.slice(5) === date);
    if (!row || row.net == null) continue;
    const amount = cells[amountColumn]?.replace(/[*,，\s]/g, '').replace(/−/g, '-');
    if (!amount || /万元/.test(amount) || !/^[+-]?\d+(?:\.\d+)?(?:亿元)?$/.test(amount)) continue;
    if (Math.abs(Number.parseFloat(amount) - row.net) > 0.0051) return true;
  }
  return false;
}

export function verifiedFundFlowReport(data: FundFlowEvidence): string {
  const known = data.daily.filter(row => row.net != null);
  const total = known.reduce((sum, row) => sum + row.net!, 0);
  const table = (rows: Rank[]) => ['| 代码 | 名称 | 净额（亿元） | 有数据天数 |', '|---|---|---:|---:|',
    ...rows.map(row => `| ${row.symbol} | ${row.name} | ${row.net.toFixed(2)} | ${row.days} |`)].join('\n');
  return `# A股主力资金流向核验简报\n\n> 模型草稿的每日金额未通过一致性检查；以下正文直接由本轮工具数据生成，未采用有误草稿。\n\n`
    + `业务日期：${data.daily[0].date} 至 ${data.daily.at(-1)!.date}。本地 stock_fund_flows，只读查询；主力为超大单与大单净额之和，库内元除以 100000000 后为亿元。\n\n`
    + `实际来源：${data.sources.join('；') || '工具未提供来源明细'}。\n\n`
    + `## 每日主力净额（亿元）\n\n| 交易日 | 主力净额 | 实际样本数 | 本地日线参照数 |\n|---|---:|---:|---:|\n`
    + data.daily.map(row => `| ${row.date} | ${row.net?.toFixed(2) ?? '缺失'} | ${row.samples} | ${row.expected ?? '未知'} |`).join('\n')
    + `\n\n所列样本${data.complete ? '' : '已取得日期的部分'}合计 **${total.toFixed(2)} 亿元**；${known.filter(row => row.net! > 0).length} 个净流入日、${known.filter(row => row.net! < 0).length} 个净流出日。\n\n`
    + `## 净流入排名\n\n${table(data.inflows)}\n\n## 净流出排名\n\n${table(data.outflows)}\n\n`
    + `## 覆盖与限制\n\n${data.complete ? '请求窗口内各交易日均有记录。' : '窗口或最终记录存在缺口，合计只覆盖已取得数据。'}每日样本与日线参照数量的差异未经逐股核实，不代表已查明缺失原因；不能把所列样本当作全市场完整覆盖。排名按工具返回的本地样本统计，各对象实际覆盖天数见表。此为资金流描述统计，不构成投资建议。`;
}
