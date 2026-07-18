# 7/18 计划：龙虎榜全市场改造 + 市场消息面

> 日期：2026-07-18  
> 修订：2026-07-18（完成本地代码核查、东财/沪深交易所接口实测）  
> 状态：**可实施，须按本文 Phase 0 → Phase 1 顺序执行**
> 范围：将个股龙虎榜改造为全市场龙虎榜；新增市场消息面（按来源分级）
> 参考：[simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data) V3.4.0（10 层架构，43 端点，15 数据源）
> 执行记录：2026-07-18 已完成 Phase 0、Phase 1 与 Phase 2 数据治理；官方龙虎榜备源及独立新闻备源保留在后续 Phase 2。

---

## 关键调研发现

在制定方案前，以下发现直接影响架构决策：

1. **财联社旧接口已下线，但 V3.4.0 新接口已恢复**：旧 `nodeapi` 已废弃；参考仓库当前通过 `v1/roll/get_roll_list` + 本地签名恢复电报能力。本阶段仍以东财全球资讯（np-weblist）为主，财联社作为 Phase 2 可选独立备源，不再以“接口已下线”作为不接入理由。
2. **项目已有东财限流代码，但目前不可直接复用**：`sevenLayerDataService.ts` 的 `limitedFetchJson`、`eastmoneyDataCenter`、`parseLooseJson` 均为文件私有函数。Phase 0 必须先抽取为共享 HTTP 基础设施，并确保所有东财模块共用同一串行限流队列（请求间隔至少 1.1 秒 + 抖动 + 3 次重试）。
3. **hotSectorService 是市场级数据的成熟范式**：内存缓存 + 文件缓存 + in-flight 去重 + 多端点容灾，作为龙虎榜全市场和新闻面的实现模板。
4. **七层架构是个股维度**：`SevenLayerSnapshot` 以 `code` 为核心，而龙虎榜全市场和新闻面是市场维度，不宜强行塞入七层，应新建独立模块。
5. **数据治理已有成熟模式**：`dataCoverageMatrix.ts` 的 `coverageRow()` 和 `dataHealthGate.ts` 的 `DataHealthCheck` 可直接扩展。
6. **CLAUDE.md 与实际代码不符**：CLAUDE.md 声称有"七层数据含 News 层"，但实际只有 4 层（signal/capital/fundamental/announcement），News 层不存在。本计划将真正落地 news 层。
7. **龙虎榜报表名已实测校正**：`RPT_BILLBOARD_DETAILSLIST`、`RPT_BILLBOARD_TRADEDETAILS` 当前返回东财错误码 9501（报表配置不存在）；有效报表为 `RPT_DAILYBILLBOARD_DETAILSNEW`、`RPT_BILLBOARD_DAILYDETAILSBUY`、`RPT_BILLBOARD_DAILYDETAILSSELL`。
8. **同股同日可能多次上榜**：2026-07-17 实测 78 条记录对应 68 只股票，9 只股票存在重复记录，单股最多 3 条；不能以 `trade_date + security_code + source` 去重，必须使用 `TRADE_ID`/事件指纹。
9. **后台采集必须进入 Phase 1**：若仅在 API 被访问时拉取，无法保证历史连续、新闻无人访问时不会入库，数据治理也失去基础。因此龙虎榜定时采集、新闻后台轮询、启动补采和新闻清理均属于核心闭环。

---

## 一、架构设计

### 1.1 总体架构：双轨制（个股七层 + 市场级独立模块）

```
市场数据层
├── 个股维度（已有，保持不变）
│   └── sevenLayerDataService.ts（signal/capital/fundamental/announcement 四层）
│       ├── 龙虎榜个股记录：保留但改为委托调用 dragonTigerService
│       └── 新增 news section：委托调用 marketNewsService
│
├── 市场级维度（新增）
│   ├── dragonTigerService.ts（全市场龙虎榜，落库 + 实时）
│   └── marketNewsService.ts（市场消息面，落库 + 实时）
│
└── 数据治理（扩展）
    ├── dataCoverageMatrix.ts：新增 lhb_coverage / news_coverage 两行
    └── dataHealthGate.ts：新增 lhb_freshness / news_freshness 检查项
```

### 1.2 龙虎榜架构决策

| 决策项 | 结论 | 理由 |
|--------|------|------|
| 新建独立模块 | **是**，`server/src/marketData/dragonTigerService.ts` | 全市场维度与个股七层不同生命周期，独立模块便于复用与测试 |
| 是否落库 | **是**，新建 `dragon_tiger_billboards` + `dragon_tiger_seats` 两表 | 龙虎榜是事件型数据，每日 50-200 条，历史数据可做席位聚类分析和因子研究；落库后避免重复拉取 |
| 是否进 DuckDB 快照 | **Phase 3 可选**，先落 MySQL | 龙虎榜数据量小（年均约 1-2 万行），MySQL 足够；若后续要做"龙虎榜效应"因子，再按 snapshotBuilder 流程导 Parquet |
| 是否纳入数据治理 | **是**，coverage matrix + health gate | 盘后龙虎榜是当日信号的重要组成，缺失应告警 |
| 个股七层中的龙虎榜 | **保留但委托**，`loadSignalLayer` 改为调用 `dragonTigerService.getStockBillboard(code)` 并过滤 | 保持七层 API 向后兼容，但数据源统一 |
| 数据源 | 东财 datacenter-web（主）+ 沪深交易所交易公开信息（备） | 主源字段全、有结构化席位明细；官方备源与东财不同风控面 |
| 缓存策略 | 内存缓存 5 分钟 + 文件缓存 1 小时（同 hotSectorService） | 盘中频繁刷新，盘后稳定 |

### 1.3 新闻面架构决策

| 决策项 | 结论 | 理由 |
|--------|------|------|
| 新建独立模块 | **是**，`server/src/marketData/marketNewsService.ts` | 市场级新闻与个股七层维度不同，来源分级体系复杂，独立模块更清晰 |
| 是否落库 | **是**，新建 `market_news` 表 | 新闻是流式数据，落库后可做去重、来源分级展示、历史检索；但不做长期归档（保留 30 天，定期清理） |
| 来源分级字段 | `source_tier` 枚举：`official`/`state_media`/`professional`/`aggregator`/`self_media` | 直接映射"官方披露>官媒>专业财经媒体>聚合平台>自媒体" |
| 是否进七层 | **个股新闻加入七层**（新增 `news` section），市场新闻独立 | 个股新闻是个股维度，适合七层；市场快讯是市场维度，独立展示 |
| 是否进 DuckDB | **否** | 新闻是非结构化文本，不适合 OLAP 分析 |
| 是否纳入数据治理 | **是**，但仅采集心跳/来源成功率，不进 coverage matrix | 新闻是否产生不可控，不能用“十分钟内必须有新文章”判故障 |
| 缓存策略 | 内存缓存 3 分钟（新闻时效性强）+ 文件缓存 30 分钟 | 平衡时效性与源站压力 |

### 1.4 来源分级映射

| 分级 | source_tier | 数据源（优先级从高到低） | 实现阶段 |
|------|-------------|--------------------------|----------|
| 官方披露 | `official` | 巨潮公告（已有，`cninfo_announcements`）+ 沪深交易所官方页面 | Phase 1 复用现有 + Phase 2 新增官方页面 |
| 官媒报道 | `state_media` | 新华财经、人民日报（评估可达性后接入） | **Phase 2**，先评估 |
| 专业财经媒体 | `professional` | 东财全球资讯（`np-weblist`，7×24 快讯） | **Phase 1**，参考仓库已验证 |
| 聚合平台 | `aggregator` | 东财个股新闻（`search-api-web`） | **Phase 1**，参考仓库已验证 |
| 自媒体 | `self_media` | 暂不接入 | 低优先级，信噪比低 |

---

## 二、后端实现

### 2.1 新建文件清单

```
server/src/marketData/
├── dragonTigerService.ts          # 全市场龙虎榜服务（主）
├── dragonTigerService.test.ts     # 龙虎榜测试
├── marketNewsService.ts           # 市场消息面服务（主）
├── marketNewsService.test.ts      # 新闻面测试
└── repositories/
    ├── dragonTigerRepository.ts   # 龙虎榜 DB 仓储
    └── marketNewsRepository.ts    # 新闻 DB 仓储

server/src/marketData/http/
├── eastmoneyClient.ts             # 东财共享请求、报表查询、全局限流
├── cninfoClient.ts                # 巨潮公告共享客户端
├── rateLimiter.ts                 # 按主机串行限流
└── looseJson.ts                   # JSON/JSONP 安全解析

server/src/db/migrations/
├── 0025_dragon_tiger.sql          # 龙虎榜表
├── 0026_market_news.sql           # 市场新闻表
└── 0027_market_data_collector_runs.sql # 采集运行键、重试与互斥状态

server/src/routes/
└── marketData.ts                  # 修改：新增端点

server/src/
├── config.ts                      # 修改：新增配置项
├── app.ts                         # 修改：注册后台采集器及启动补采
├── db/schema.ts                   # 修改：新增三张表的 Drizzle 定义
└── research/
    ├── dataCoverageMatrix.ts      # 修改：新增 lhb_coverage 行
    └── dataHealthGate.ts          # 修改：新增 lhb/news 检查项

server/src/marketData/jobs/
├── dragonTigerScheduler.ts        # 盘后龙虎榜定时拉取（Phase 1）
├── marketNewsScheduler.ts         # 新闻后台轮询（Phase 1）
└── marketNewsCleanup.ts           # 新闻分批清理（Phase 1）
```

### 2.2 数据库 Schema 变更

#### 迁移 0025_dragon_tiger.sql

```sql
-- 全市场龙虎榜上榜记录（每日 50-200 只）
CREATE TABLE IF NOT EXISTS dragon_tiger_billboards (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  trade_id VARCHAR(64) NOT NULL,             -- 东财 TRADE_ID；备源使用事件指纹
  trade_date DATE NOT NULL,                 -- 上榜交易日
  security_code VARCHAR(10) NOT NULL,       -- 证券代码
  security_name VARCHAR(64) NOT NULL,       -- 证券简称
  exchange VARCHAR(4) NOT NULL,             -- SH/SZ/BJ
  explanation VARCHAR(500) NULL,            -- 上榜原因
  net_buy_amt DOUBLE NULL,                  -- 净买入额（元）
  buy_amt DOUBLE NULL,                      -- 买入额（元）
  sell_amt DOUBLE NULL,                     -- 卖出额（元）
  total_buy_amt DOUBLE NULL,                -- 总买入额（元）
  total_sell_amt DOUBLE NULL,               -- 总卖出额（元）
  billboard_deal_amt DOUBLE NULL,           -- 当日成交额（元）
  close_price DOUBLE NULL,                  -- 收盘价
  change_pct DOUBLE NULL,                   -- 涨跌幅（%）
  turnover_rate DOUBLE NULL,                -- 换手率（%）
  change_type VARCHAR(32) NULL,             -- 东财 CHANGE_TYPE
  reason_codes JSON NULL,                   -- 上榜原因代码/标签
  source_key VARCHAR(32) NOT NULL DEFAULT 'eastmoney',  -- eastmoney/sse/szse
  source_fingerprint CHAR(64) NOT NULL,     -- source+trade_id；备源为事件字段 hash
  fetched_at DATETIME(3) NOT NULL,
  UNIQUE INDEX idx_dtb_fingerprint (source_fingerprint),
  UNIQUE INDEX idx_dtb_source_trade (source_key, trade_id),
  INDEX idx_dtb_date (trade_date),
  INDEX idx_dtb_code_date (security_code, trade_date),
  INDEX idx_dtb_net_buy (trade_date, net_buy_amt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 龙虎榜营业部席位明细（每只上榜股票 5 买 + 5 卖）
CREATE TABLE IF NOT EXISTS dragon_tiger_seats (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  billboard_id BIGINT UNSIGNED NOT NULL,     -- 关联具体上榜事件，而非仅关联股票日期
  trade_id VARCHAR(64) NOT NULL,
  trade_date DATE NOT NULL,
  security_code VARCHAR(10) NOT NULL,
  seat_name VARCHAR(255) NOT NULL,          -- 营业部名称
  seat_side VARCHAR(8) NOT NULL,            -- buy/sell；机构是属性而不是第三种方向
  operate_dept_code VARCHAR(64) NULL,
  buy_amt DOUBLE NULL,                      -- 买入额（元）
  sell_amt DOUBLE NULL,                     -- 卖出额（元）
  net_amt DOUBLE NULL,                      -- 净额（元）
  rank INT UNSIGNED NOT NULL,               -- 席位排名 1-5
  is_institutional TINYINT(1) NOT NULL DEFAULT 0,  -- 是否机构席位
  source_key VARCHAR(32) NOT NULL DEFAULT 'eastmoney',
  source_fingerprint CHAR(64) NOT NULL,     -- source+trade_id+side+seat/rank
  fetched_at DATETIME(3) NOT NULL,
  UNIQUE INDEX idx_dts_fingerprint (source_fingerprint),
  INDEX idx_dts_billboard (billboard_id),
  INDEX idx_dts_date_code (trade_date, security_code),
  INDEX idx_dts_seat (seat_name),
  INDEX idx_dts_date_seat (trade_date, seat_name),
  CONSTRAINT fk_dts_billboard FOREIGN KEY (billboard_id)
    REFERENCES dragon_tiger_billboards(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### 迁移 0026_market_news.sql

```sql
-- 市场新闻（全市场快讯 + 个股新闻统一表）
CREATE TABLE IF NOT EXISTS market_news (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  news_id VARCHAR(64) NOT NULL,             -- 源站新闻 ID（去重用）
  source_key VARCHAR(32) NOT NULL,          -- eastmoney_global/eastmoney_stock/cninfo/sse/szse
  source_name VARCHAR(64) NOT NULL,         -- 东财全球资讯/东财个股新闻/巨潮公告
  source_tier VARCHAR(16) NOT NULL,         -- official/state_media/professional/aggregator/self_media
  content_type VARCHAR(16) NOT NULL,        -- flash/article/announcement/irm
  source_url VARCHAR(1024) NULL,            -- 原文链接
  title VARCHAR(500) NOT NULL,
  summary TEXT NULL,                        -- 摘要
  content TEXT NULL,                        -- 正文（可选）
  published_at DATETIME(3) NOT NULL,        -- 发布时间
  security_code VARCHAR(10) NULL,           -- 关联个股代码（市场新闻为 NULL）
  security_name VARCHAR(64) NULL,
  industry VARCHAR(64) NULL,                -- 关联行业
  tags JSON NULL,                           -- 标签数组
  raw JSON NULL,                            -- 原始数据
  canonical_hash CHAR(64) NOT NULL,         -- 规范标题+时间窗+证券，用于跨源聚合
  fetched_at DATETIME(3) NOT NULL,
  UNIQUE INDEX idx_mn_news_id (news_id, source_key),
  INDEX idx_mn_canonical (canonical_hash, published_at),
  INDEX idx_mn_published (published_at),
  INDEX idx_mn_tier (source_tier, published_at),
  INDEX idx_mn_source (source_key, published_at),
  INDEX idx_mn_code (security_code, published_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 新闻清理策略：由 marketNewsCleanup 分批删除；artifactLifecycle 仅清理文件产物，不参与 DB 清理
```

#### 迁移 0027_market_data_collector_runs.sql

采集任务运行键使用独立的不可变迁移保存，记录任务类型、状态、尝试次数、起止时间、错误与运行摘要；用于启动补采、多实例去重和最多三次失败重试。

> Schema 约束：同股同日多原因上榜必须保留为多个事件；席位必须关联 `billboard_id/trade_id`。正式公告仍由公告数据源持有，`market_news` 只保存展示所需元数据或聚合引用，不复制并在 30 天后删除公告事实本身。

### 2.3 配置项变更（server/src/config.ts）

```typescript
// 龙虎榜与新闻面
DRAGON_TIGER_ENABLED: z.enum(['true', 'false']).default('true'),
DRAGON_TIGER_SYNC_TIME: z.string().default('18:00'),  // 盘后龙虎榜拉取时间
DRAGON_TIGER_RECHECK_TIME: z.string().default('18:30'), // 二次补齐
MARKET_NEWS_ENABLED: z.enum(['true', 'false']).default('true'),
MARKET_NEWS_REFRESH_INTERVAL_MINUTES: z.string().default('3'),  // 新闻刷新间隔
MARKET_NEWS_RETENTION_DAYS: z.string().default('30'),  // 新闻保留天数
```

配置加载时对 `HH:mm`、正整数范围做校验；两个后台采集器仅在 DB 在线且对应开关启用时启动。启动后先按持久化 `run_key` 检查缺口，再进入定时轮询，不能只依赖内存中的 `setInterval` 状态。

### 2.4 龙虎榜服务实现（dragonTigerService.ts）

#### 核心接口设计

```typescript
// 全市场龙虎榜快照
export interface DragonTigerMarketSnapshot {
  tradeDate: string;
  items: DragonTigerMarketItem[];
  total: number;
  updatedAt: string;
  source: string;
}

export interface DragonTigerMarketItem {
  rank: number;
  code: string;
  name: string;
  exchange: 'SH' | 'SZ' | 'BJ';
  explanation: string;
  netBuyAmt: number | null;       // 净买入额（元）
  buyAmt: number | null;
  sellAmt: number | null;
  totalBuyAmt: number | null;
  totalSellAmt: number | null;
  billboardDealAmt: number | null;
  closePrice: number | null;
  changePct: number | null;
  turnoverRate: number | null;
  reasonCodes: string[];
}

// 个股龙虎榜详情（含席位）
export interface DragonTigerStockDetail {
  code: string;
  name: string;
  records: DragonTigerStockRecord[];
}

export interface DragonTigerStockRecord {
  tradeDate: string;
  explanation: string;
  netBuyAmt: number | null;
  buySeats: DragonTigerSeat[];   // 买入 TOP5
  sellSeats: DragonTigerSeat[];  // 卖出 TOP5
}

export interface DragonTigerSeat {
  rank: number;
  seatName: string;
  buyAmt: number | null;
  sellAmt: number | null;
  netAmt: number | null;
  isInstitutional: boolean;
}
```

#### 数据源接入（Python → TS 移植）

**主源：东财 datacenter-web（复用现有 `eastmoneyDataCenter` helper）**

参考仓库 V3.4.0 和 2026-07-18 实测均使用 `RPT_DAILYBILLBOARD_DETAILSNEW`。项目现有的 `RPT_DAILYBILLBOARD_DETAILS` 仍可作为兼容降级，但新服务必须按真实字段映射 `TRADE_ID`、`BILLBOARD_NET_AMT`、`BILLBOARD_BUY_AMT`、`BILLBOARD_SELL_AMT`、`CHANGE_RATE`、`TURNOVERRATE`：

```typescript
// eastmoneyClient.ts：共享 helper，所有模块共用同一个限流队列
export async function eastmoneyDataCenterQuery(
  reportName: string,
  sortColumn: string,
  pageSize: number,
  filter = '',
): Promise<Record<string, unknown>[]> {
  const data = await limitedFetchJson(EASTMONEY_DATACENTER_URL, {
    reportName,
    columns: 'ALL',
    filter,
    pageNumber: '1',
    pageSize: String(pageSize),
    sortColumns: sortColumn,
    sortTypes: '-1',
    source: 'WEB',
    client: 'WEB',
  }, 'https://data.eastmoney.com/');
  return data?.result?.data ?? [];
}

// 全市场龙虎榜：RPT_DAILYBILLBOARD_DETAILSNEW
// 买方席位：RPT_BILLBOARD_DAILYDETAILSBUY
// 卖方席位：RPT_BILLBOARD_DAILYDETAILSSELL
```

**备源：沪深交易所官方（Phase 2 新增）**

```typescript
// 上交所交易公开信息：
// https://query.sse.com.cn/infodisplay/showTradePublicFile.do
// 深交所交易公开信息：
// https://www.szse.cn/api/report/ShowReport/data?CATALOGID=1842_xxpl
// 注意：queryLatestBulletinNewJSON 和 annList 是公告接口，不是龙虎榜接口
```

#### 缓存与落库策略

```typescript
// 内存缓存（5 分钟）
let marketCache: { data: DragonTigerMarketSnapshot; cachedAt: number } | null = null;
let refreshInFlight: Promise<DragonTigerMarketSnapshot> | null = null;
const CACHE_MS = 5 * 60_000;

// 文件缓存（1 小时，盘后降级读取）
const CACHE_FILE = localModulePath('../../.cache/dragon-tiger-market.json', '.cache/dragon-tiger-market.json');

// 榜单拉取后先批量 upsert dragon_tiger_billboards。
// 席位默认按需拉取并持久化；后台可低速补齐，不阻塞榜单 API。
async function persistBillboard(snapshot: DragonTigerMarketSnapshot): Promise<void> {
  // 按 source_key + trade_id 幂等 upsert；不得按 date+code 合并
}
```

全市场榜单通常一次请求可取完，但席位需每个事件分别请求买方/卖方报表。禁止在一次前台 HTTP 请求中串行补齐全市场席位；前台按需加载，后台限速补齐。

### 2.5 新闻面服务实现（marketNewsService.ts）

#### 核心接口设计

```typescript
export interface MarketNewsSnapshot {
  items: MarketNewsItem[];
  total: number;
  updatedAt: string;
  sources: string[];  // 本次命中的数据源
}

export interface MarketNewsItem {
  newsId: string;
  sourceKey: 'eastmoney_global' | 'eastmoney_stock' | 'cninfo' | 'sse' | 'szse';
  sourceName: string;
  sourceTier: 'official' | 'state_media' | 'professional' | 'aggregator' | 'self_media';
  contentType: 'flash' | 'article' | 'announcement' | 'irm';
  sourceUrl?: string;
  title: string;
  summary?: string;
  content?: string;
  publishedAt: string;
  securityCode?: string;
  securityName?: string;
  industry?: string;
  tags?: string[];
}

// 来源优先级排序权重（数字越小优先级越高）
export const TIER_PRIORITY: Record<MarketNewsItem['sourceTier'], number> = {
  official: 1,
  state_media: 2,
  professional: 3,
  aggregator: 4,
  self_media: 5,
};
```

#### 数据源接入（Python → TS 移植）

**东财全球资讯（professional 级，主力源）**

```typescript
const EASTMONEY_NEWS_GLOBAL_URL = 'https://np-weblist.eastmoney.com/comm/web/getFastNewsList';
// 参数：client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=20&req_trace=...
// 返回：{ data: { fastNewsList: [{ title, content, showTime, news_url, ... }] } }
```

**东财个股新闻（aggregator 级）**

```typescript
const EASTMONEY_NEWS_STOCK_URL = 'https://search-api-web.eastmoney.com/jsonp';
// 参数：cb=jQuery...&param={"uid":"","keyword":"688017","type":["cmsArticleWebOld"],"client":"web","clientType":"web","clientVersion":"curr","param":{"cmsArticleWebOld":{"searchScope":"default","sort":"default","pageIndex":1,"pageSize":10,"preTag":"","postTag":""}}}
// JSONP 格式，需复用现有 parseLooseJson 解析
```

**巨潮公告（official 级，作为个股聚合展示源）**

将现有 `sevenLayerDataService.ts` 中的 `loadAnnouncementLayer` 公告拉取逻辑抽取到 `cninfoClient.ts`，供公告层和个股聚合展示复用，标记 `source_tier = 'official'`、`content_type = 'announcement'`。当前巨潮实现是按个股查询，不能通过遍历全市场股票来构造市场实时新闻流；市场流 Phase 1 仅接入全市场快讯源。

#### 来源分级排序逻辑

```typescript
export function sortNewsByPriority(items: MarketNewsItem[]): MarketNewsItem[] {
  return items.sort((a, b) => {
    // 实时流首先按发布时间倒序；同一时间/同一事件再以来源等级确定主展示源
    const timeDiff = b.publishedAt.localeCompare(a.publishedAt);
    return timeDiff || TIER_PRIORITY[a.sourceTier] - TIER_PRIORITY[b.sourceTier];
  });
}
```

跨源去重分两层：`news_id + source_key` 保证单源幂等；`canonical_hash` 只用于聚合同一事件的多个来源，保留原始来源记录并选最高等级来源作为主展示项。

### 2.6 API 端点设计

在 `server/src/routes/marketData.ts` 的 `registerMarketDataRoutes` 中新增：

```
# 龙虎榜全市场
GET  /api/market-data/dragon-tiger/market                    # 当日全市场龙虎榜（默认）
GET  /api/market-data/dragon-tiger/market?date=2026-07-17    # 指定日期全市场龙虎榜
GET  /api/market-data/dragon-tiger/market?force=true         # 强制刷新缓存

# 龙虎榜个股详情（含席位）
GET  /api/market-data/dragon-tiger/stocks/:code              # 个股最近 8 次上榜记录 + 席位

# 龙虎榜历史统计
GET  /api/market-data/dragon-tiger/seats?seat=xxx&days=30    # 营业部近 30 天上榜统计
GET  /api/market-data/dragon-tiger/stats?days=30             # 近 30 天龙虎榜统计

# 市场新闻
GET  /api/market-data/news/market                            # 全市场快讯（默认 20 条）
GET  /api/market-data/news/market?tier=professional          # 按来源分级过滤
GET  /api/market-data/news/market?limit=50&hours=24          # 最近 24 小时 50 条
GET  /api/market-data/news/market?limit=30&before=<ISO>&beforeId=<id> # 游标分页
GET  /api/market-data/news/market?force=true                 # 强制刷新

# 个股新闻
GET  /api/market-data/news/stocks/:code                      # 个股相关新闻

# 七层扩展（个股新闻加入七层）
GET  /api/market-data/stocks/:code/seven-layer/news          # 新增 news section
```

#### 七层 section 扩展

修改 `SevenLayerSection['key']` 类型：

```typescript
key: 'signal' | 'capital' | 'fundamental' | 'announcement' | 'news';
```

`loadSignalLayer` 中的龙虎榜调用改为委托 `dragonTigerService.getStockBillboard(code)`，新增 `loadNewsLayer(security)` 调用 `marketNewsService.getStockNews(code)`。

### 2.7 数据治理纳入

#### dataCoverageMatrix.ts 扩展

```typescript
// 龙虎榜覆盖率（按交易日维度）
coverageRow('dragon_tiger', '龙虎榜覆盖', lhbRows[0], 0.95),
// 新闻不进入 coverage matrix；改在 health gate 统计采集心跳和来源成功率
```

#### dataHealthGate.ts 扩展

新增检查项：

- `dragon_tiger_freshness`：仅交易日 18:30 后检查当日事件是否入库；
- `market_news_collector_heartbeat`：采集任务最近一次运行时间；
- `market_news_source_success`：各来源最近一次成功/失败、连续失败次数；
- 分开记录 `latest_published_at` 与 `latest_fetched_at`，不能以“十分钟内必须发布新文章”判断系统故障。

### 2.8 后台采集与清理（Phase 1）

1. `dragonTigerScheduler.ts`：交易日 18:00 拉取榜单，18:30 二次补齐；启动时检查最近开放交易日的 `run_key` 并补采；失败重试 3 次。
2. `marketNewsScheduler.ts`：按配置间隔后台拉取，不依赖浏览器访问；以 `sortEnd`/新闻 ID 做增量游标。
3. `marketNewsCleanup.ts`：每日分批删除过期媒体新闻；不调用仅清理 `.partial` 文件的 `artifactLifecycle`。
4. 所有任务必须有持久化运行键和互斥锁，支持进程重启补偿，并避免多实例重复执行。

---

## 三、前端实现

### 3.1 新建文件清单

```
src/features/marketData/
├── DragonTigerPanel.tsx           # 全市场龙虎榜面板（市场数据页 tab）
├── DragonTigerSeatsDrawer.tsx     # 席位明细抽屉（点击个股展开）
├── MarketNewsPanel.tsx            # 市场消息面面板（市场数据页 tab）
├── StockNewsSection.tsx           # 个股新闻七层 section 组件
├── types.ts                       # 修改：新增类型
├── MarketDataPage.tsx             # 修改：新增 overview 子视图切换
└── marketDataCache.ts             # 修改：新增缓存字段
```

### 3.2 类型定义扩展（types.ts）

```typescript
// 龙虎榜
export interface DragonTigerMarketItem { /* 同后端 */ }
export interface DragonTigerMarketSnapshot { /* 同后端 */ }
export interface DragonTigerSeat { /* 同后端 */ }
export interface DragonTigerStockDetail { /* 同后端 */ }

// 新闻
export type NewsSourceTier = 'official' | 'state_media' | 'professional' | 'aggregator' | 'self_media';
export interface MarketNewsItem { /* 同后端 */ }
export interface MarketNewsSnapshot { /* 同后端 */ }

// 七层扩展
export interface SevenLayerSection {
  key: 'signal' | 'capital' | 'fundamental' | 'announcement' | 'news';  // 新增 news
  // ...
}
```

### 3.3 全市场龙虎榜面板（DragonTigerPanel.tsx）

组件结构：
```
DragonTigerPanel
├── 头部：交易日选择 + 刷新按钮 + 数据源标签
├── 统计卡片：上榜家数 / 净买入 TOP1 / 机构席位占比
├── 主表格（AntD Table）：
│   ├── 列：排名 / 代码+名称 / 涨跌幅 / 净买入额 / 上榜原因 / 席位数
│   ├── 点击行 → 打开 DragonTigerSeatsDrawer
│   └── 净买入额红绿着色（红正绿负，符合 A 股惯例）
└── DragonTigerSeatsDrawer：买/卖 TOP5 席位明细，机构席位高亮
```

实现要点：仿照 `HotSectorPanel.tsx` 的缓存与刷新模式；localStorage 缓存上次快照（离线可看）；金额统一用"亿"为单位展示。

### 3.4 市场消息面面板（MarketNewsPanel.tsx）

组件结构：
```
MarketNewsPanel
├── 头部：来源分级筛选（Segmented：全部/官方/官媒/专业/聚合）+ 自动刷新开关
├── 时间轴（AntD Timeline）：
│   ├── 每条新闻：来源标签（颜色分级）+ 时间 + 标题 + 摘要
│   ├── 官方披露：红色 Tag
│   ├── 官媒报道：橙色 Tag
│   ├── 专业财经：蓝色 Tag
│   ├── 聚合平台：灰色 Tag
│   └── 点击 → 打开原文链接（Drawer 内展示）
└── 基于 API 游标的增量加载（IntersectionObserver 或“加载更多”）
```

项目当前未安装独立 `InfiniteScroll` 组件包，Phase 1 不新增依赖，优先使用原生 `IntersectionObserver`；无障碍和失败重试场景保留“加载更多”按钮。原文默认在新窗口打开，Drawer 仅显示本地摘要和来源信息，避免目标站点 `X-Frame-Options`/跨域策略导致内嵌失败。

来源分级颜色映射：
```typescript
const TIER_COLORS: Record<NewsSourceTier, string> = {
  official: 'red',       // 官方披露 - 红
  state_media: 'orange', // 官媒 - 橙
  professional: 'blue',  // 专业财经 - 蓝
  aggregator: 'default', // 聚合 - 灰
  self_media: 'default', // 自媒体 - 灰
};
```

### 3.5 市场数据页视图扩展

当前 `MarketDataPage.tsx` 中市场情绪与 `HotSectorPanel` 是并列区块，并不存在可直接扩展的 overview 子视图。先抽取 `MarketOverviewWorkspace`，再用 Segmented 切换四个子视图，避免把状态和请求继续堆叠到已较大的页面组件中：

```typescript
const OVERVIEW_TABS = [
  { key: 'sentiment', label: '市场情绪', icon: <DashboardOutlined /> },
  { key: 'hotSector', label: '热门板块', icon: <FireOutlined /> },
  { key: 'dragonTiger', label: '龙虎榜', icon: <TrophyOutlined /> },      // 新增
  { key: 'news', label: '市场资讯', icon: <NotificationOutlined /> },     // 新增
];
```

### 3.6 七层个股新闻 section

修改 `SEVEN_LAYER_DEFS`：

```typescript
const SEVEN_LAYER_DEFS = [
  { key: 'signal', title: '信号', summary: '同花顺热点/北向/龙虎榜/解禁/行业线索' },
  { key: 'capital', title: '资金面', summary: '融资融券/大宗交易/股东户数/分钟资金流/120日资金流' },
  { key: 'fundamental', title: '基础数据', summary: '公司画像/估值股本/核心财务/财报摘要' },
  { key: 'announcement', title: '公告', summary: '巨潮公告检索' },
  { key: 'news', title: '新闻', summary: '东财个股新闻/全球资讯' },  // 新增
];
```

`SevenLayerSectionContent` 新增 news 分支，渲染 `StockNewsSection` 组件。

### 3.7 缓存策略（marketDataCache.ts）

```typescript
interface MarketDataPageCache {
  // ... 现有字段
  dragonTigerMarket?: DragonTigerMarketSnapshot;   // 新增
  marketNews?: MarketNewsSnapshot;                 // 新增
  stockNews: Record<string, MarketNewsSnapshot>;   // 新增：个股新闻缓存
}
```

新闻缓存应记录游标、写入时间和查询条件；`force=true` 仅刷新第一页，不能把不同 tier/证券代码的结果混写到同一个缓存槽。龙虎榜缓存键必须包含交易日。

---

## 四、数据源映射（参考仓库 → 项目实现）

### 4.1 龙虎榜数据源映射

| 参考仓库端点 | 项目实现 | 报表名 / URL | 说明 |
|-------------|---------|-------------|------|
| `dragon_tiger_market` | `dragonTigerService.getMarketBillboard()` | 东财 `RPT_DAILYBILLBOARD_DETAILSNEW` | 全市场，按日期过滤、按 `BILLBOARD_NET_AMT` 排序 |
| `dragon_tiger_seats_buy` | `dragonTigerService.getStockBillboard(code)` | 东财 `RPT_BILLBOARD_DAILYDETAILSBUY` | 按 `TRADE_ID`/代码/日期取买方席位 |
| `dragon_tiger_seats_sell` | `dragonTigerService.getStockBillboard(code)` | 东财 `RPT_BILLBOARD_DAILYDETAILSSELL` | 按 `TRADE_ID`/代码/日期取卖方席位 |
| `dragon_tiger_backup` | `dragonTigerService.getOfficialBillboard()` | 上交所 `showTradePublicFile.do` + 深交所 `ShowReport/data` | 降级备源；上交所返回文本，需独立解析与 fixture |

**TS 移植要点**：
- 参考仓库的 `eastmoney_datacenter()` helper 与项目现有 `eastmoneyDataCenter()` 几乎一致，仅 filter 构造不同
- 全市场查询必须处理分页元数据，不能假定 `pageSize` 永远覆盖全部记录
- 席位明细按买/卖两个报表分别请求；默认按需加载，后台低速补齐
- 以 `TRADE_ID` 标识上榜事件，同股同日多原因不得合并

### 4.2 新闻面数据源映射

| 参考仓库端点 | 项目实现 | source_tier | URL | 说明 |
|-------------|---------|-------------|-----|------|
| `cninfo_announcements` | 复用现有 `loadAnnouncementLayer` | `official` | cninfo.com.cn | 已实现，抽取为独立函数 |
| `eastmoney_global_news` | `marketNewsService.fetchGlobalNews()` | `professional` | np-weblist.eastmoney.com | 7×24 全球财经快讯 |
| `eastmoney_stock_news` | `marketNewsService.fetchStockNews(code)` | `aggregator` | search-api-web.eastmoney.com | JSONP 格式，个股新闻 |
| `cninfo_irm` | `marketNewsService.fetchIrmQa(code)` | `official` | cninfo.com.cn | 互动易问答（Phase 3） |
| `cls_telegraph` | Phase 2 可选备源 | `professional` | cls.cn 新版 v1 签名接口 | V3.4.0 已恢复；Phase 1 为控制范围暂不接入 |

**TS 移植要点**：
- 东财全球资讯：`np-weblist.eastmoney.com/comm/web/getFastNewsList`，参数 `client=web&biz=web_724&fastColumn=102`，返回 JSON
- 东财个股新闻：`search-api-web.eastmoney.com/jsonp`，JSONP 格式需用 `parseLooseJson` 解析
- 所有东财请求复用共享 `eastmoneyClient`（至少 1.1 秒间隔 + 抖动），禁止各服务建立独立限流器

---

## 五、测试计划

### 5.1 后端测试

#### dragonTigerService.test.ts

- 数据解析：全市场龙虎榜 JSON → `DragonTigerMarketItem[]` 映射；席位明细映射（含机构席位识别）；涨跌幅、净买入额的数值解析（含 null 处理）；空响应降级
- 事件身份：同股同日多原因保留多条；`TRADE_ID` 幂等；备源事件指纹稳定
- 缓存：内存缓存命中（5 分钟内不重复请求）；in-flight 去重；文件缓存降级读取
- 仓储：按 `source_key + trade_id` upsert；席位关联正确 billboard；按日期范围/营业部查询
- 降级：东财失败时切换到沪深交易所官方源
- 排序：按净买入额倒序、按涨跌幅排序

#### marketNewsService.test.ts

- 数据解析：东财全球资讯 JSON 映射；东财个股新闻 JSONP 映射；巨潮公告映射（source_tier=official）
- 来源分级：`TIER_PRIORITY` 排序正确性；`sortNewsByPriority`：official > professional > aggregator；同级按时间倒序
- 去重：`news_id + source_key` 单源幂等；`canonical_hash` 跨源聚合但不删除来源记录
- 缓存：3 分钟内存缓存；force=true 强制刷新
- 仓储：按 tier 过滤查询；按时间范围查询；按 security_code 查询
- 清理：超过 `MARKET_NEWS_RETENTION_DAYS` 的记录被清理
- 分页：相同发布时间下以 `id` 作为第二游标，不重不漏
- 调度：启动补采、持久化 `run_key`、多次 tick 不重复执行、非交易日不误报龙虎榜缺失

#### 现有测试回归

- `sevenLayerDataService` 测试：验证龙虎榜委托调用后七层快照仍正常
- `dataCoverageMatrix` 测试：仅新增龙虎榜交易日覆盖行，新闻不进入覆盖率矩阵
- `dataHealthGate` 测试：龙虎榜交易日/时点判断、新闻采集心跳与来源成功率正确

### 5.2 前端测试

- `DragonTigerPanel`：渲染空状态；渲染表格（排名、净买入额红绿色）；点击行打开席位 Drawer；日期切换刷新
- `MarketNewsPanel`：渲染时间轴；来源分级 Tag 颜色正确；分级筛选过滤
- 七层 news section：折叠面板展开后加载个股新闻；缓存命中不重复请求

### 5.3 集成测试

- 端到端：启动后端 → `/api/market-data/dragon-tiger/market` 返回当日龙虎榜；`/api/market-data/news/market` 返回来源分级新闻；七层 `/seven-layer/news` 返回个股新闻
- 数据治理：`/api/admin/overview` 包含龙虎榜覆盖率、新闻采集心跳及来源成功率
- 降级：mock 东财 503 → 切换到沪深交易所官方源

---

## 六、分阶段实施

### Phase 0：接口与模型定版（编码前置门槛）

1. 保存东财全市场榜单、买方席位、卖方席位、全球快讯、个股新闻及沪深官方备源 fixture。
2. 固化字段映射和异常响应；确认 `TRADE_ID`、同股同日多事件及机构席位判断。
3. 抽取共享 `eastmoneyClient`、`rateLimiter`、`looseJson`、`cninfoClient`，并让现有七层调用迁移到共享实现。
4. 完成迁移 SQL 和 `db/schema.ts` 评审；通过后才进入 Phase 1。

**退出条件**：所有主源 fixture 解析测试通过；失效报表名不再出现在代码或实施章节；Schema 能无损保存同股同日多事件。

### Phase 1：核心可用闭环（优先级最高）

**目标**：完成龙虎榜全市场 + 新闻面的核心可用闭环

1. **DB 迁移**：`0025_dragon_tiger.sql` + `0026_market_news.sql` + `0027_market_data_collector_runs.sql`
2. **龙虎榜服务**：
   - `dragonTigerService.ts`：东财全市场接口 + 席位按需加载 + 内存/文件缓存 + 落库
   - `dragonTigerRepository.ts`：upsert + 查询
   - API 端点：`GET /api/market-data/dragon-tiger/market` + `GET /api/market-data/dragon-tiger/stocks/:code`
3. **新闻面服务**：
   - `marketNewsService.ts`：东财全球资讯 + 东财个股新闻 + 巨潮公告复用 + 来源分级 + 缓存 + 落库
   - `marketNewsRepository.ts`：upsert + 查询 + 清理
   - API 端点：`GET /api/market-data/news/market` + `GET /api/market-data/news/stocks/:code`
4. **七层扩展**：新增 `news` section，龙虎榜个股委托调用
5. **前端**：
   - `DragonTigerPanel.tsx` + `DragonTigerSeatsDrawer.tsx`
   - `MarketNewsPanel.tsx`
   - `MarketDataPage.tsx` overview 子视图切换
   - 七层 `news` section 渲染
6. **配置**：`config.ts` 新增配置项
7. **后台采集**：龙虎榜 18:00/18:30 + 启动补采；新闻轮询；新闻清理；持久化运行键与任务锁
8. **测试**：服务层 + 仓储层 + 调度层 + 前端组件基础测试

### Phase 2：增强与治理（优先级中）

1. **数据治理**：
   - `dataCoverageMatrix.ts` 仅新增龙虎榜交易日覆盖行
   - `dataHealthGate.ts` 新增龙虎榜时点检查、新闻采集心跳与来源成功率
   - admin console 展示
2. **官方备源**：
   - 沪深交易所官方龙虎榜抓取（降级方案）
   - 官方公告页面抓取（补充 official 级来源）
3. **独立新闻备源**：
   - 评估接入财联社新版 v1 签名接口，与东财形成不同风控面的备源
4. **官媒来源评估**：
   - 新华财经、人民日报 API 可达性调研
   - 可达则接入 `state_media` 级

### Phase 3：高级分析（优先级低）

1. **龙虎榜进 DuckDB 快照**：用于"龙虎榜效应"因子研究
2. **营业部画像**：近 30/90 天上榜频率、胜率统计
3. **互动易问答**：`cninfo_irm` 接入（official 级补充）
4. **新闻情感分析**：接入 AI 服务做新闻情感打分
5. **龙虎榜 + 新闻联动**：上榜股票关联新闻展示

---

## 七、风险与注意事项

### 7.1 参考仓库 Python → TS 移植风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Python 字典 → TS 对象字段名映射错误 | 数据解析失败 | 严格对照参考仓库返回字段，编写字段映射测试用例 |
| JSONP 解析差异（东财个股新闻） | 解析异常 | 将现有 `parseLooseJson` 抽取到共享模块并用真实 JSONP fixture 锁定行为 |
| 参考仓库版本迭代（V3.4.0）字段变更 | 接口失效 | 在 `dragonTigerService` 中做字段兼容处理，缺失字段返回 null |

### 7.2 东财防封策略

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 高频请求触发东财风控 | IP 被封 | 所有东财请求复用共享 `eastmoneyClient`（至少 1.1 秒间隔 + 抖动 + 3 次重试）；榜单可少量请求，席位按需/后台串行补齐 |
| 住宅 IP 间歇风控（HTTP 000 / 空响应） | 偶发失败 | 至少 1.1 秒共享串行限流 + 重试 3 次 + 降级到沪深交易所官方源 |
| 东财 datacenter-web 接口变更 | 接口失效 | 字段缺失时降级处理，不抛异常；备源切换 |

### 7.3 财联社签名机制（Phase 2 可选）

参考仓库 V3.2 废弃的是财联社旧 `nodeapi`；V3.4.0 已通过 `v1/roll/get_roll_list` 和本地签名恢复。Phase 1 仍采用东财全球资讯以控制实现范围，Phase 2 可把财联社作为独立备源。接入前必须用固定签名向量、错误响应 fixture 和接口探针覆盖签名变更风险。

### 7.4 官方接口可达性

| 接口 | 可达性 | 风险 |
|------|--------|------|
| 上交所 `showTradePublicFile.do` | 2026-07-18 实测可用 | 返回 JSONP 包裹的文本内容，需 Referer 和独立文本解析器 |
| 深交所 `ShowReport/data` | 2026-07-18 实测可用 | 结构化 JSON，目录参数可能变化 |
| 新华财经/人民日报 | **待评估** | 可能有反爬或需 Key，Phase 2 先做可达性探测 |

### 7.5 数据量评估

| 数据 | 日增量 | 年增量 | 存储评估 |
|------|--------|--------|---------|
| 龙虎榜上榜事件 | 50-200 行 | 1-5 万行 | 同股同日多原因必须分别保存，MySQL 无压力 |
| 龙虎榜席位明细 | 500-2000 行 | 10-40 万行 | 小，MySQL 无压力 |
| 市场新闻 | 200-500 条 | 5-12 万条 | 中等，保留 30 天约 1.5 万条，需定期清理 |
| 个股新闻 | 按需拉取 | 取决于访问量 | 可入统一新闻表并遵循 30 天保留策略；未入库结果使用短期缓存 |

### 7.6 其他注意事项

1. **七层向后兼容**：新增 `news` section 后，前端 `SEVEN_LAYER_DEFS` 和后端 `SevenLayerSection['key']` 类型需同步修改，已有 `signal/capital/fundamental/announcement` 不受影响
2. **龙虎榜个股委托**：`loadSignalLayer` 中的龙虎榜调用改为委托 `dragonTigerService`，需确保返回结构兼容现有 `SevenLayerRecord` 格式，避免前端 `metricPreview` 和 `METRIC_LABELS` 渲染异常
3. **前端 NET_BUY_AMT 标签缺失**：现有前端缺少 `NET_BUY_AMT` 标签，需在 `METRIC_LABELS` 中补充 `{ NET_BUY_AMT: { label: '净买入额', unit: 'yuan' } }`
4. **时区处理**：MySQL session 固定 UTC；`published_at/fetched_at` 写 UTC；龙虎榜 `trade_date` 始终表示北京时间交易日，不做 UTC 日期偏移；API 输出 ISO 8601，前端按 `Asia/Shanghai` 展示
5. **迁移文件编号**：当前最新为 `0024_sync_jobs_run_key.sql`，新增为 `0025`、`0026` 和 `0027`，严格顺序且已应用迁移保持不可变
6. **DuckDB 快照**：龙虎榜 Phase 1 不进快照，若 Phase 3 需做因子研究，需在 `snapshotBuilder.ts` 中新增龙虎榜字段导出

---

## 八、核心设计决策总结

1. **双轨制架构**：个股维度（七层）保持不变，市场维度（龙虎榜全市场 + 新闻面）新建独立模块，避免七层架构被市场级数据污染
2. **事件身份优先**：龙虎榜以 `TRADE_ID`/事件指纹建模，完整保存同股同日多原因记录，席位关联具体事件
3. **落库策略差异化**：龙虎榜事件永久落库；媒体新闻短期落库；公告事实不随新闻保留策略删除
4. **实时排序与来源分级分离**：新闻流按时间倒序，来源等级用于同事件选主源、筛选和标签展示
5. **共享请求基础设施**：先抽取全局东财限流和 JSONP/巨潮客户端，再建设新服务，避免模块级限流失效
6. **后台采集属于核心闭环**：Phase 1 即交付定时采集、启动补偿、清理、任务锁和运行键；Phase 2 聚焦治理与备源
7. **分阶段交付**：Phase 0 定版接口与模型，Phase 1 核心闭环，Phase 2 治理与备源，Phase 3 高级分析
