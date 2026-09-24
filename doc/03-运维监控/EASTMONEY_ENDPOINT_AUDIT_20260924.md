# 东方财富数据接口审计（2026-09-24）

审计对象：`root@192.168.2.218` 上 `/opt/quant-backtest`，结合本地项目源码。实测时间为北京时间 18:07–18:15，数据库/日志取证约 18:04–18:14。

**结论：存在按接口路径、访问链路及时间变化的拒绝连接现象，不能解释为“东方财富所有接口被封”或“本服务器 IP 已被永久封禁”。** 当前最需要处理的是排行、价格 K 线、直连单股报价和直连个股资金流；北向数据存在独立的报表级错误，解禁模块另有已证实的参数错误。财报、分红、龙虎榜、新闻及宏观数据样本仍可用。

## 1. 证据和判断边界

- 全仓检索直接 URL、AKShare 调用与动态 URL，覆盖生产服务、定时入库、历史校验脚本和研究实验。核对服务器 AKShare 1.18.94 的函数源码，确认宏观和分红函数实际使用 `datacenter-web`，不是仅依据函数名称判断来源。
- 进行 84 次串行、无重试的只读 GET 探测：51 个初始用例、11 个 Node 原生 fetch 复测、7 个直连/参数复测、11 个定向复测、4 个 Windows 直连复测。通常每次只取 2 条，间隔 1.2 秒；应用参数复测最多取 30 条。
- 初始 `global-news` 探测漏传 `req_trace`，这一条是**探针参数错误，不是应用故障**。已用应用完整参数在 Node 和 Python 直连中复测成功；生产代码本来就有此参数。
- 对照生产 systemd 日志、数据库最新日期、财务 manifest、页面缓存；8 个关键源文件经换行归一化 SHA-256 比对，本地与服务器一致。
- Python 继承 SSH 环境时使用了现有代理；`Session.trust_env=False` 为直连。后端启动环境和项目 `.env` 均未设置代理，Node 原生 fetch 复测与其当前调用方式一致。未改变服务器路由或代理设置。
- Windows 直连也复现排行、报价、价格 K 线和日资金流连接断开；本机和服务器可能共享公网出口，**不能当作独立公网 IP 的交叉验证**。代理路径也未核实出口 IP，不能据此认定 IP 封禁。
- 本轮没有得到明确的 HTTP 403/429 或官方封禁说明。`RemoteDisconnected`、`UND_ERR_SOCKET` 只能证实请求链路被关闭；风控、接口策略和网络中间设备仍需区分。可用样本不代表全股票、全历史或持续可用。
- 本轮未运行采集入库、未更改业务代码、未修改生产数据。留存的是审计文档和脱敏诊断元数据。

原始结果保留在项目根目录下 `tmp_output/operations-audits/20260924/eastmoney_endpoint_audit_20260924.json`（不纳入 Git；校验值见 [原始产物索引](RAW_AUDIT_ARTIFACTS.md)）。其中保留时间、路径、公开请求参数、业务状态和错误类型，不包含密钥。

## 2. 高风险与异常接口

| 接口/报表 | 项目使用的数据与功能 | 本轮证据 | 判断与影响 |
|---|---|---|---|
| `push2*.eastmoney.com/api/qt/clist/get` | 个股资金流盘后入库；全市场主力净流入；行业/概念热榜、板块成分股；七层信号中的板块资金 | `push2`、`push2delay`、`82.push2`、`7.push2`、`48.push2` 的代理探测全部断连；主域/延迟域 Node 直连失败；行业/成分股请求失败 | **最高优先级：明确不可用、疑似受限。** 切换这几个域名仍是同一家源，不能视为独立备用数据源。资金流库缺 9/23、9/24，两天定时任务共四次均失败 |
| `push2his.../api/qt/stock/kline/get` | 个股日线在线补充、历史换手率；中证2000/日经/KOSPI图表；8个国内指数定时采集；复权外部校验 | 个股、3个指数小样本代理请求断连；实际 UI 参数 `fqt=1,lmt=30` 失败；上证指数实际起止日期参数也在直连和代理下失败 | **高风险：当前样本不可用。** 但18:00定时任务刚成功更新国内指数至9/24，不能称为已持续停更；存在时间/请求路径差异，需按任务最新成功时间判断 |
| `push2.../api/qt/stock/get` | 公司行业/上市信息、估值画像，中证2000/日经/KOSPI即时报价，指数收盘快照校正 | 个股 Node、Python直连均断连；代理下个股及3个指数均返回 `rc=0` 和报价 | **访问链路相关风险。** 直连报价故障已证实；3个指数使用同一路径，存在连带风险，未据单股样本断言每个指数直连都失败。普通A股腾讯报价不等于东方财富画像信息可用 |
| `push2his.../api/qt/stock/fflow/kline/get` | 七层资金面分钟/120日资金流；研判中的个股资金证据；市场观点盘中资金备用路径 | 日资金流 Node/Python直连失败；代理下600426返回2条历史日资金数据；分钟样本 `rc=0` 但空数组 | **直连路径已失败，接口并非全链路关闭。** 代理成功样本不能证明当前生产应用可取数；盘后分钟空数组不能直接归为封禁，需结合交易时段/参数判断 |
| `datacenter-web...` 的 `RPT_MUTUAL_STOCK_NORTHSTA` | 七层信号中的北向资金/持仓 | 带600426筛选与无股票筛选、Node直连与Python代理均返回 HTTP200、`success=false,code=9701,服务器繁忙` | **报表级不可用。** 可能是服务/权限/报表策略变化，证据不足以称为IP封禁；相同数据中心的其他报表正常 |
| `datacenter-web...` 的 `RPT_LIFT_STAGE` | 解禁日期、规模与信号 | 当前代码使用 `sortColumns=LIFT_DATE`，返回 `9501,LIFT_DATE排序列不存在`；去掉排序可得数据，返回字段为 `FREE_DATE`；改用 `FREE_DATE` 的只读探测成功 | **已确认代码与接口字段不匹配，不是封接口。** 需要同时调整排序、日期解析和展示字段，不能只更换域名 |

生产数据事实：`stock_fund_flows` 最近仍为 **2026-09-22，5,209条**；9/23、9/24没有记录。最新定时失败时间是9/24 17:20:41。热门板块和全市场资金缓存最后生成于9/24 15:00:24——它们说明当时有成功结果，不证明18点后的接口仍可用，也不能把收盘缓存的时间直接等同于业务数据错误。

## 3. 目前可用、仍存在单一来源依赖的数据

| 数据/接口 | 实测及生产证据 | 注意点 |
|---|---|---|
| 财务报表：`RPT_LICO_FN_CPD`、3个 `RPT_DMSK_FN_*`、12个 `RPT_F10_FINANCE_{G/B/S/I}{BALANCE/INCOME/CASHFLOW}` | 16个报表逐一抽样均为HTTP200、`success=true`；昨晚manifest `failedStages=0` | 财务卡片的部分失败是2026Q1的603435、603448缺 `total_liabilities/total_equity`；并非财务接口整体受限。9/24审计时尚未到19:00财务计划时间 |
| 财务展示备用：`datacenter.eastmoney.com/securities/api/data/v1/get` 的 `RPT_F10_FINANCE_MAINFINADATA`、`RPT_LICO_FN_CPD` | 两个报表均返回有效数据 | 本地财报存在时应用优先本地；备用接口出错也应检查业务状态码 |
| 分红送配：AKShare `stock_fhps_em`、`stock_fhps_detail_em` → `RPT_SHAREBONUS_DET` | 单股与报告期查询正常；18:02生产任务仍在更新；2026中期报告期返回1040条 | 历史任务仅920201失败，AKShare报 `NoneType`；只读复测实际为 `9201,返回数据为空`，属于空响应处理问题，不能解释为封禁 |
| 龙虎榜及买卖席位：`RPT_DAILYBILLBOARD_DETAILSNEW`、`RPT_BILLBOARD_DAILYDETAILSBUY/SELL` | 3个报表抽样有效；龙虎榜已入库到9/24，18:00任务成功 | 某只股票的最近上榜日期较旧是正常可能性，不能仅以样本日期旧判断停更 |
| 两融、大宗交易、股东户数：`RPTA_WEB_RZRQ_GGMX`、`RPT_BLOCKTRADE_STA`、`RPT_HOLDERNUM_DET` | 均为HTTP200、业务成功、有数据 | 不同数据发布频率不同；样本两融最新9/23，股东户数2026中报，不等于网络异常 |
| PPI、PMI、货币供应：AKShare宏观函数 → `RPT_ECONOMY_PPI/PMI/CURRENCY_SUPPLY` | 均返回有效数据，最新观察期2026年8月 | PPI用于名义盈利周期；PMI、货币供应还用于mhi-v3实验。它们实际依赖东财镜像，不能误当统计局/央行直连接口 |
| 券商研报：`reportapi.eastmoney.com/report/list` | 代理和直连均返回有效研报 | 单一来源，失败会减少个股研究的研报证据；PDF链接是 `pdf.dfcfw.com`，属于客户端打开链接，本轮未下载PDF验证 |
| 全球资讯：`np-weblist.../comm/web/getFastNewsList` | 完整参数Node/Python直连成功；18:09采集入库成功 | 与财联社/新闻联播聚合，有其他来源不代表东财来源始终健康，应分别记录每个源状态 |
| 个股新闻：`search-api-web.../search/jsonp` | Node和Python均返回有效JSONP新闻 | 按需获取且有数据库缓存；数据库最近抓取在9/22不等于今日接口失败 |
| 市场观点盘后备用：`push2his.../api/qt/stock/fflow/daykline/get` | 直连和代理均取得9/18–9/24共5个交易日数据 | **与已失败的 `/fflow/kline/get` 是不同路径。** 沪深大盘聚合口径不能替代逐股资金流、也不能冒充逐股覆盖率；盘中分支仍走风险路径 |

## 4. 已定位的代码风险

1. **旧热门板块缓存可能掩盖断流。** `hotSectorService.ts:297` 的普通读取路径在缓存超时后直接返回旧对象，后台刷新异常被吞掉，未补 `stale:true/fallbackReason`。只有强制刷新失败的路径补这些字段。持续失败时页面仍可能看起来有正常数据；依赖 `stale` 的市场观点备用源判断也可能不触发。此项是代码风险，不把15点收盘缓存本身认定为错误行情。
2. **七层数据把接口业务失败变成“无记录”。** `sevenLayerDataService.ts:268/290` 只提取 `result.data`，未检查 `success/code/message`，因此北向9701和解禁9501均会变成空数组。其他来源有记录时，组合模块甚至可能得到 `status=ok`。应区分成功空结果、报表拒绝、参数错误、网络失败。
3. **指数任务可能以成功状态返回旧数据。** `index_update.py:123` 在已有数据集时将采集异常转换为 `cached-fallback` 并继续，最终退出可能为0。监控需要同时检查每个指数的最新交易日和 `warning`，不能仅看systemd成功。本次10个国内指数实际都已到9/24，不能据此风险宣称它们已经缺数。
4. **多个独立客户端不共享总限流。** `http/eastmoneyClient.ts` 每host约1.1秒串行；`aStockDataService.ts:389`另有0.5秒队列；热门板块、全市场资金、Python采集和辅助脚本又各走自己的请求机制。模块内限流不能控制服务器对同一供应商的总压力。
5. **并发和重试可能放大受限状态。** `marketCapitalFlowService.ts:19/145`用6个并发工作单元分页，并为每页轮换5个域名；`dividend_update.py:44/81`默认8并发，AKShare详情函数预取后又请求第一页且未显式设置网络超时；`fundFlow/update.py:387`分页成功后仅睡0.05秒，外层4轮重试。它们是被限流的风险因素，**并非本轮断连的已证实原因**。
6. **不可恢复的数据缺项触发整批财报重跑。** 财务调度器把partial任务每10分钟重试，默认不带 `--resume`；当前两只股票字段不完整可能使整套报告期接口反复抓取。代码已有缓存复用能力，但调度路径没有按失败类型区分重抓范围。
7. **统一HTTP客户端未处理限流冷却。** 当前重试未针对403/429、`Retry-After`、连续同源失败做熔断；轮换东财子域不能提供真正的数据源独立性。
8. **路径/进程健康不能代表全部业务健康。** 同一 `push2his` 域名下，价格K线失败、个股日资金流仅代理样本成功、大盘 `daykline` 直连成功；同一 `datacenter-web` 下北向失败、财务和分红正常。监控粒度应细到路径、报表名与调用进程。

## 5. 调用位置清单

以下路径相对项目根目录，可用于后续修复定位。

| 文件 | 关键位置 | 用途 |
|---|---|---|
| `server/src/fundFlow/update.py` | 387、436、464 | 东财全市场资金排行、AKShare包装、日入库 |
| `server/src/marketData/marketCapitalFlowService.ts` | 31、71、136 | 全市场资金汇总及5入口轮换 |
| `server/src/marketData/hotSectorService.ts` | 86、205、297、318 | 热门板块、成分股、缓存降级 |
| `server/src/marketData/aStockDataService.ts` | 25–27、389、520、737、1950、2070、2090、2206 | 报价、画像、指数/个股K线、券商研报 |
| `server/src/marketData/sevenLayerDataService.ts` | 142、174、200、268、290 | 北向、解禁、两融、大宗、股东、资金流与财务备用 |
| `server/src/marketData/http/eastmoneyClient.ts` | 12、66 | 通用HTTP与龙虎榜报表查询 |
| `server/src/marketData/http/rateLimiter.ts` | 27 | 进程内按host限流 |
| `server/src/marketData/dragonTigerService.ts` | 50、109、155、168 | 龙虎榜总表、个股、买卖席位 |
| `server/src/marketData/marketNewsService.ts` | 15、55、86 | 个股新闻、全球资讯 |
| `server/src/referenceData/financial_eastmoney.py` | 59、149、220 | 财报16类报表采集与缓存 |
| `server/src/marketData/jobs/financialDataScheduler.ts` | 84、93、140 | 财报定时调度与partial重试 |
| `server/src/referenceData/dividend_current_update.py` | 92 | 分红当期全市场 |
| `server/src/referenceData/dividend_update.py` | 44、81 | 单股分红历史及刷新 |
| `server/src/referenceData/index_update.py` | 32、123、200 | 8个东财国内指数；另2个使用中证官方 |
| `server/src/marketData/jobs/indexDatasetUpdater.ts` | 174、212、341 | 腾讯指数主源与东财收盘校正；中证2000官方源 |
| `server/src/services/marketOpinionFallback.ts` | 13、21 | 市场观点大盘资金备用（盘中kline/盘后daykline） |
| `server/src/marketHealth/akshare_ppi.py` | 20 | PPI镜像数据→名义盈利周期 |
| `server/experiments/mhi-v3/fetch_macro.py` | 56、71、86 | PMI/PPI/货币供应实验，不是三条生产采集任务 |
| `server/src/marketData/jobs/adjustmentReferenceAuditCli.ts` | 163 | 手工选择eastmoney时的复权交叉校验 |
| `scripts/generate-zijin-chanlun.mjs`、`scripts/generate_goldwind_score_html.mjs` | 文件开头URL | 一次性图表脚本，运行时也受价格K线接口影响 |

`adjustmentEventAuditCli.ts`/`adjustmentEventPlan.ts`主要消费已抓取的分红事件文件，名称中的eastmoney不代表每次运行都发网络请求。前端筹码分布中的Eastmoney注释也是算法说明，不是隐藏的取数接口。

## 6. 不应一并归入本次东方财富问题的数据

- 普通A股主行情、日线采集与复权刷新还存在腾讯提供器/本地已发布数据链路，不能因为东财失败便认定原始日线或整个复权数据库错误；东财交叉校验失效会减少独立证据。
- AKShare在本项目中也用于新浪市场快照、换手率、财务备用；不能把所有AKShare函数都当作东财。
- 中证官方成分/权重、申万分类、巨潮公告、通达信分钟数据不是同一接口来源。今日中证成分任务确有 `oss-ch.csindex.com.cn` 超时与缓存降级，但这是另一条外部数据链路，应单独排查。
- 本地研究快照和策略结果不会因网络接口瞬时断开自动损坏；主要风险是后续更新停止、旧缓存继续展示、以及研究证据缺失未被标明。

## 7. 处理优先级

1. **先避免把旧数据/失败报表展示成正常。** 修正热门板块stale标记和七层业务状态码处理；监控同时记录来源、请求路径、目标交易日、最后成功时间、是否使用旧缓存。
2. **恢复可验证的数据链路。** 优先处理资金排行和价格K线故障，保留原始行情与缺失日期。个股历史资金接口的代理样本目前可读，可作为后续补数候选，但仍须校验完整分项、交易日、覆盖率、数值口径，并单独验证生产调用方式；大盘daykline不得代填逐股表。
3. **修正已确定的参数/空响应问题。** 解禁改用真实字段 `FREE_DATE` 并调整映射；北向9701明确展示不可用；920201分红空响应按无数据情形处理，勿归为封禁或盲目重试。
4. **控制供应商总请求量。** 整合客户端限流、退避、熔断和缓存；按失败类型缩小财报重试范围；避免同一故障在多个模块同时轮换子域重试。

所有“正常”与“失败”均限定于本轮时点和样本；后续验证应使用生产进程相同网络配置及真实参数。此报告不把瞬时断连扩大为永久封禁结论。
