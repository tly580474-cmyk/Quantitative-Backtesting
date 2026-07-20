import type { MarketNewsItem, NewsSourceTier } from '../marketData/marketNewsTypes.js';

export const MARKET_OPINION_TIERS = ['official', 'state_media', 'professional', 'aggregator'] as const satisfies readonly NewsSourceTier[];

export type OpinionNewsCategory = 'policy_macro' | 'market_funds' | 'industry' | 'company' | 'overseas_risk' | 'other';

export interface OpinionNewsAssessment {
  score: number;
  category: OpinionNewsCategory;
  reasons: string[];
  hardRejected: boolean;
  rejectionReason?: string;
}

export interface RankedOpinionNews {
  item: MarketNewsItem;
  assessment: OpinionNewsAssessment;
}

const CATEGORY_CAPS: Record<OpinionNewsCategory, number> = {
  policy_macro: 4, market_funds: 3, industry: 5, company: 3, overseas_risk: 3, other: 2,
};
const SOURCE_SCORE: Record<NewsSourceTier, number> = {
  official: 15, state_media: 13, professional: 10, aggregator: 6, self_media: 0,
};

const POLICY_MACRO = /国务院|中央政治局|央行|人民银行|财政部|证监会|发改委|统计局|海关总署|国常会|货币政策|财政政策|监管|降准|降息|利率|社融|信贷|GDP|CPI|PPI|PMI|进出口|房地产政策|关税/u;
const MARKET_FUNDS = /成交额|融资融券|北向资金|主力资金|ETF|回购|增持|减持|IPO|上市|退市|并购|重组|定增|解禁|股权|债券|汇率|人民币|港股|A股|证券交易|交易所/u;
const OVERSEAS_RISK = /美联储|欧洲央行|日本央行|中东|俄乌|伊朗|以色列|制裁|冲突|袭击|战争|原油|黄金|美元指数|美元兑|美元走强|美元走弱|美债|纳斯达克|标普|KOSPI|美股|美国.*(?:关税|CPI|就业|利率|GDP|制裁)|欧盟.*(?:关税|监管|制裁)/u;
const COMPANY = /公司公告|发布公告|业绩预告|业绩快报|中标|签署|收购|出售|停牌|复牌|回购股份|股东|董事会|重大合同|控制权|申请上市|上市申请/u;
const INDUSTRY = /人工智能|AI|机器人|半导体|芯片|算力|光伏|储能|新能源|医药|创新药|消费|汽车|低空经济|商业航天|有色|钢铁|煤炭|化工|房地产|银行|保险|券商|通信|军工/u;
const HARD_FACT = /发布|宣布|通过|批准|实施|下调|上调|增长|下降|签署|中标|收购|回购|增持|减持|暂停|恢复|启动|完成|发生|达到|突破|同比|环比|正式|决定|数据显示/u;
const OPINION_ONLY = /分析师|机构认为|券商认为|预计|预期|有望|或将|建议关注|看好|展望|复盘|盘点|解读|观点|策略|亟待|呼吁|反弹概率|若有催化/u;
const PROMOTIONAL = /必看|速看|一文看懂|机会来了|掘金|名单来了|潜力股|牛股|财富密码|不容错过|重磅推荐|值得关注|电报解读|分析师看好|机构看好|高潜力|打开.*成长空间/u;
const GENERIC_CONTAINER = /国内联播快讯|国际联播快讯|新闻联播|早间新闻精选|晚间新闻精选|新闻特写/u;
const VAGUE_EVENT = /调研$|举行$|会见$|出席$|强调$/u;
const NUMBER_FACT = /\d+(?:\.\d+)?(?:%|亿元|万元|亿|万|点|家|只|倍|美元|元|日|月|年)?/u;
const DATE_FACT = /\d{1,2}[月日时:]|今日|昨日|本周|上半年|一季度|二季度|三季度|四季度/u;

export function rankOpinionNews(
  items: MarketNewsItem[],
  now = Date.now(),
  options: { maxItems?: number; minScore?: number; maxPerSource?: number } = {},
): RankedOpinionNews[] {
  const cutoff = now - 72 * 60 * 60_000;
  const maxItems = Math.max(1, Math.min(30, options.maxItems ?? 18));
  const minScore = Math.max(0, Math.min(100, options.minScore ?? 60));
  const maxPerSource = Math.max(1, options.maxPerSource ?? 8);
  const candidates = items
    .filter((item) => MARKET_OPINION_TIERS.includes(item.sourceTier as typeof MARKET_OPINION_TIERS[number]))
    .filter((item) => Date.parse(item.publishedAt) >= cutoff)
    .map((item) => ({ item, assessment: assessOpinionNews(item, now) }))
    .filter(({ assessment }) => !assessment.hardRejected && assessment.score >= minScore)
    .sort((left, right) => right.assessment.score - left.assessment.score
      || right.item.publishedAt.localeCompare(left.item.publishedAt));
  const categoryCounts = new Map<OpinionNewsCategory, number>();
  const sourceCounts = new Map<string, number>();
  const selected: RankedOpinionNews[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxItems) break;
    const category = candidate.assessment.category;
    if ((categoryCounts.get(category) ?? 0) >= CATEGORY_CAPS[category]) continue;
    const source = candidate.item.sourceKey;
    if ((sourceCounts.get(source) ?? 0) >= maxPerSource) continue;
    selected.push(candidate);
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
  }
  return selected;
}

export function assessOpinionNews(item: MarketNewsItem, now = Date.now()): OpinionNewsAssessment {
  const title = item.title.trim();
  const summary = (item.summary || item.content || '').trim();
  const text = `${title} ${summary}`;
  if (title.length < 6) return rejected('标题过短，缺少可识别事件');
  if (PROMOTIONAL.test(title)) return rejected('营销或荐股式标题');
  if (GENERIC_CONTAINER.test(title.replace(/[【】]/g, ''))) return rejected('合集式标题，无法形成单一可验证事件');
  if (title.length + summary.length < 18) return rejected('事实材料过少');
  const category = classify(text, item);
  const reasons: string[] = [];
  let score = SOURCE_SCORE[item.sourceTier];
  reasons.push(`来源质量 +${SOURCE_SCORE[item.sourceTier]}`);
  const impact = impactScore(category, text);
  score += impact;
  reasons.push(`市场影响 +${impact}`);
  let density = 0;
  if (NUMBER_FACT.test(text)) density += 8;
  if (HARD_FACT.test(text)) density += 8;
  density += Math.min(5, Math.floor(summary.length / 80));
  if ((item.tags?.length ?? 0) > 0 || item.securityCode || item.industry) density += 2;
  if ((item.sourceCount ?? item.relatedSources?.length ?? 1) > 1) density += 2;
  density = Math.min(25, density);
  score += density;
  reasons.push(`信息密度 +${density}`);
  let verifiability = 0;
  if (NUMBER_FACT.test(text)) verifiability += 6;
  if (DATE_FACT.test(text)) verifiability += 2;
  if (item.sourceTier === 'official' || item.sourceTier === 'state_media') verifiability += 5;
  if (item.sourceUrl) verifiability += 2;
  verifiability = Math.min(15, verifiability);
  score += verifiability;
  reasons.push(`可验证性 +${verifiability}`);
  const sourceCount = new Set((item.relatedSources ?? []).map((source) => source.sourceKey)).size || item.sourceCount || 1;
  const corroboration = Math.min(10, Math.max(0, sourceCount - 1) * 5);
  score += corroboration;
  if (corroboration) reasons.push(`多源确认 +${corroboration}`);
  const ageHours = Math.max(0, (now - Date.parse(item.publishedAt)) / 3_600_000);
  const freshness = ageHours <= 6 ? 5 : ageHours <= 24 ? 3 : 1;
  score += freshness;
  reasons.push(`时效性 +${freshness}`);
  if (OPINION_ONLY.test(title) && !NUMBER_FACT.test(title) && !HARD_FACT.test(title)) {
    score -= 20;
    reasons.push('纯观点无新增事实 -20');
  }
  if (title.length < 12) {
    score -= 8;
    reasons.push('标题事实不充分 -8');
  }
  if (VAGUE_EVENT.test(title) && !NUMBER_FACT.test(title) && !HARD_FACT.test(title)) {
    score -= 12;
    reasons.push('标题未给出具体政策或结果 -12');
  }
  return { score: Math.max(0, Math.min(100, Math.round(score))), category, reasons, hardRejected: false };
}

function classify(text: string, item: MarketNewsItem): OpinionNewsCategory {
  const title = item.title;
  if (POLICY_MACRO.test(title)) return 'policy_macro';
  if (item.securityCode || COMPANY.test(title)) return 'company';
  if (MARKET_FUNDS.test(title)) return 'market_funds';
  if (OVERSEAS_RISK.test(title)) return 'overseas_risk';
  if (INDUSTRY.test(title) || /无人机|航空航天|航天|卫星|神舟/u.test(title)) return 'industry';
  // Some policy releases use neutral titles, so allow the body to recover only
  // this systemically important category. Other categories must be explicit in the title.
  if (POLICY_MACRO.test(text) && HARD_FACT.test(title)) return 'policy_macro';
  return 'other';
}

function impactScore(category: OpinionNewsCategory, text: string): number {
  const base: Record<OpinionNewsCategory, number> = {
    policy_macro: 27, market_funds: 24, overseas_risk: 25, industry: 20, company: 18, other: 0,
  };
  const systemic = /全国|全市场|重大|首次|紧急|创历史|超预期|低于预期|高于预期|暴涨|暴跌|暂停交易/u.test(text) ? 3 : 0;
  return Math.min(30, base[category] + systemic);
}

function rejected(reason: string): OpinionNewsAssessment {
  return { score: 0, category: 'other', reasons: [], hardRejected: true, rejectionReason: reason };
}
