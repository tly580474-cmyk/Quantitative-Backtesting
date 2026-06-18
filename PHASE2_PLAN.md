# 量化行情展示项目：二期回测功能开发计划

## 1. 项目现状

一期已经形成以下基础能力：

- React + TypeScript + Vite 的纯前端应用骨架；
- Excel 行情导入、字段映射、数据校验和统一 `Candle[]` 模型；
- 蜡烛图、成交量、十字光标及多指标图表；
- SMA、EMA、BOLL、MACD、RSI、KDJ、ATR、CCI、WR、OBV、成交量均线等指标计算；
- Zustand 状态管理和 Vitest 自动化测试。

二期在一期基础上增加“数据持久化—策略定义—信号生成—撮合与账户—结果分析”的完整回测闭环。

## 2. 二期目标与范围

### 2.1 核心目标

用户能够：

1. 将导入并校验通过的行情保存到浏览器本地，并按标的、周期和日期范围读取或删除；
2. 选择内置策略、修改策略参数并保存策略配置；
3. 在行情图上查看买入、卖出和空仓信号；
4. 设置初始资金、仓位、手续费、滑点等回测参数并运行回测；
5. 查看收益曲线、回撤曲线、交易记录和核心绩效指标；
6. 保存、重新打开、比较和删除历史回测结果；
7. 使用同一输入重复运行时得到一致结果。

### 2.2 二期 MVP 范围

- 日频、单标的、单策略回测；
- 只做多，不支持做空和融资融券；
- 一次只持有一个方向的仓位；
- 支持全仓和固定比例仓位；
- 信号按 K 线收盘后生成，默认在下一交易日开盘成交；
- 支持按成交额比例收取手续费、最低手续费、印花税和固定滑点；
- 内置参数化策略，不在浏览器中执行用户任意 JavaScript；
- 行情、策略配置和回测结果保存在 IndexedDB；
- 回测在 Web Worker 中执行，避免阻塞图表交互。

### 2.3 暂不纳入二期

- 实时行情、实盘交易和券商接口；
- 多标的组合、资产配置和跨品种策略；
- 做空、杠杆、融资融券、期货保证金；
- 分钟级及 Tick 级回测；
- 用户任意代码在线执行和策略沙箱；
- 参数寻优、蒙特卡洛和 Walk-forward 分析；
- 用户系统、云同步、多人协作和异步任务队列。

## 3. 技术方案

### 3.1 二期架构选择

二期 MVP 继续采用本地优先的纯前端架构：

| 层级 | 技术 | 用途 |
| --- | --- | --- |
| 页面与交互 | React + Ant Design | 数据管理、策略配置和结果展示 |
| 状态管理 | Zustand | 当前数据集、策略、任务状态和页面状态 |
| 持久化 | IndexedDB，建议使用 Dexie | 行情、策略和回测结果的本地存储 |
| 回测引擎 | TypeScript 纯函数 | 信号、订单、成交、持仓、资金和指标计算 |
| 后台计算 | Web Worker | 隔离回测计算，支持进度和取消 |
| 图表 | Lightweight Charts | K 线信号标记、收益和回撤曲线 |
| 数据校验 | Zod | 策略参数、回测配置和持久化数据校验 |
| 测试 | Vitest | 策略、撮合、账户、指标和端到端流程测试 |

暂不引入 FastAPI、PostgreSQL、Redis。所有业务核心采用不依赖 React 和 IndexedDB 的接口，使后续可以将同一策略协议迁移到 Python 服务端；当进入多用户、多标的、海量数据或任意策略代码阶段时再建设后端。

### 3.2 运行流程

```text
Excel 导入与校验
      ↓
保存为本地行情数据集（IndexedDB）
      ↓
选择数据集 + 策略 + 回测参数
      ↓
Web Worker 顺序遍历 K 线
      ↓
指标上下文 → 策略信号 → 订单 → 下一交易日撮合
      ↓
账户、持仓、成交、每日权益快照
      ↓
绩效统计与回测结果持久化
      ↓
K 线买卖标记 + 收益/回撤曲线 + 交易明细
```

### 3.3 建议目录

```text
src/
  db/
    database.ts             # IndexedDB/Dexie 定义与版本迁移
    marketDataRepository.ts # 行情数据读写
    strategyRepository.ts   # 策略配置读写
    resultRepository.ts     # 回测结果读写
  features/
    dataLibrary/            # 本地数据集管理页面与组件
    strategies/
      builtins/             # 内置策略
      registry.ts           # 策略注册表
      types.ts              # 策略协议
    signals/                # 信号模型、去重和图表适配
    backtest/
      engine.ts             # 回测主循环
      broker.ts             # 订单撮合、手续费与滑点
      portfolio.ts          # 现金、持仓和权益
      metrics.ts            # 绩效指标
      validation.ts         # 回测前校验
    backtestResults/        # 结果概览、图表和交易列表
  models/
    MarketDataset.ts
    Strategy.ts
    Signal.ts
    Order.ts
    Trade.ts
    Backtest.ts
  stores/
    useDatasetStore.ts
    useStrategyStore.ts
    useBacktestStore.ts
  workers/
    backtest.worker.ts
    protocol.ts
```

## 4. 核心数据模型

以下模型用于约束模块边界，开发时可根据 IndexedDB 索引要求拆分实体和详情表。

### 4.1 行情数据集

```ts
interface MarketDataset {
  id: string;
  name: string;
  symbol: string;
  timeframe: '1d';
  startTime: string;
  endTime: string;
  count: number;
  sourceFileName?: string;
  checksum: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredCandle extends Candle {
  datasetId: string;
}
```

- `checksum` 用于识别重复导入和保障回测可复现；
- 行情唯一键为 `[datasetId+time]`；
- 保存前必须按时间升序排列，并拒绝同一数据集中的重复日期；
- 数据集元信息与 K 线记录分表保存，避免列表页加载全部行情。

### 4.2 策略协议

```ts
type SignalAction = 'buy' | 'sell' | 'hold';

interface StrategyDefinition<P extends Record<string, number | boolean | string>> {
  id: string;
  name: string;
  version: string;
  description: string;
  paramsSchema: unknown;
  defaultParams: P;
  warmupBars: (params: P) => number;
  evaluate: (context: StrategyContext, params: P) => StrategySignal;
}

interface StrategyContext {
  index: number;
  candles: readonly Candle[];
  indicators: Readonly<Record<string, readonly (number | null)[]>>;
  position: Readonly<PositionSnapshot>;
}

interface StrategySignal {
  time: string;
  action: SignalAction;
  reason: string;
  strength?: number;
}
```

策略函数必须是确定性的纯函数，不读取系统时间、DOM、网络或持久化状态。策略版本和参数快照必须写入回测结果。

### 4.3 订单、成交和账户

```ts
interface Order {
  id: string;
  signalTime: string;
  executeTime: string;
  side: 'buy' | 'sell';
  orderType: 'market';
  quantity: number;
  status: 'pending' | 'filled' | 'rejected' | 'cancelled';
  rejectReason?: string;
}

interface Trade {
  id: string;
  orderId: string;
  time: string;
  side: 'buy' | 'sell';
  quantity: number;
  rawPrice: number;
  fillPrice: number;
  commission: number;
  tax: number;
  slippageCost: number;
  amount: number;
}

interface EquityPoint {
  time: string;
  cash: number;
  marketValue: number;
  equity: number;
  drawdown: number;
  positionQuantity: number;
}
```

### 4.4 回测配置与结果

```ts
interface BacktestConfig {
  initialCapital: number;
  positionSizing: { type: 'percent'; value: number };
  commissionRate: number;
  minimumCommission: number;
  sellTaxRate: number;
  slippageBps: number;
  minimumTradeAmount: number;
  execution: 'next_open';
  forceCloseAtEnd: boolean;
}

interface BacktestResult {
  id: string;
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  datasetSnapshot: Pick<MarketDataset, 'id' | 'symbol' | 'startTime' | 'endTime' | 'checksum'>;
  strategyId: string;
  strategyVersion: string;
  strategyParams: Record<string, unknown>;
  config: BacktestConfig;
  startedAt: string;
  completedAt: string;
  metrics: BacktestMetrics;
  signals: StrategySignal[];
  trades: Trade[];
  equityCurve: EquityPoint[];
  error?: string;
}
```

## 5. 交易与回测规则

### 5.1 时间和未来函数约束

- 第 `T` 根 K 线只允许使用 `T` 及以前的数据生成信号；
- 第 `T` 日收盘后产生信号，第 `T+1` 个有效交易日开盘成交；
- 指标预热完成前只能返回 `hold`；
- 最后一根 K 线产生的信号因无下一根 K 线而取消；
- 禁止使用未来价格补齐指标空值；
- 输入行情必须升序，回测引擎不静默纠正重复或乱序数据。

### 5.2 撮合规则

- 买入成交价：`nextOpen * (1 + slippageBps / 10000)`；
- 卖出成交价：`nextOpen * (1 - slippageBps / 10000)`；
- 买入金额按资金比例计算，并向下取整到 `minimumTradeAmount`；指数 ETF 默认最小交易金额为 1 元；
- 买入成本包含成交额、滑点后的价格和手续费，不允许现金为负；
- 卖出成本包含手续费和印花税；
- 无持仓时的卖出信号、已有持仓时的重复买入信号默认忽略并记录原因；
- 开盘价缺失、非有限值或不大于零时订单拒绝；
- 停牌、涨跌停、成交量约束二期 MVP 暂不模拟，并在结果中注明模型限制；
- `forceCloseAtEnd=true` 时在最后一根 K 线收盘价强制平仓，并标记为强平交易。

### 5.3 收益口径

- 每日收盘后按收盘价计算持仓市值和账户权益；
- 总收益率：`期末权益 / 初始资金 - 1`；
- 年化收益率按实际回测天数折算；
- 最大回撤按每日权益历史峰值计算；
- 基准收益默认使用标的区间买入持有收益；
- 无风险利率作为配置项或统一常量，用于夏普比率计算，并明确年化口径。

## 6. 功能模块与验收标准

### 6.1 行情数据保存与读取

功能：

- 导入成功后提供“保存到数据库”；
- 数据集名称可编辑，展示标的、周期、日期范围、条数、来源和保存时间；
- 支持打开、删除、重复检测和覆盖确认；
- 支持按标的、名称和日期范围筛选；
- 启动应用后可恢复最近打开的数据集；
- IndexedDB 版本升级具备迁移入口。

验收：

- 样例 1211 条行情保存后刷新浏览器仍可完整读取；
- 读取数据与保存前逐字段一致，顺序一致；
- 重复文件可被 `checksum` 识别；
- 删除数据集时同步删除其行情，且不误删历史回测中的数据快照；
- 数据库异常、空间不足和版本不兼容有明确提示。

### 6.2 策略编写与管理

首批内置策略：

1. 双均线：短均线上穿长均线买入，下穿卖出；
2. RSI：进入超卖区后向上穿越阈值买入，进入超买区后向下穿越阈值卖出；
3. MACD：DIF 上穿 DEA 买入，下穿卖出；
4. BOLL：收盘价突破下轨后回归买入，达到中轨或上轨卖出。

功能：

- 策略注册表统一管理名称、版本、参数定义和计算函数；
- 参数表单由 schema 生成并即时校验；
- 支持保存为策略配置、复制、重命名和删除；
- 提供策略说明、信号规则和预热期提示；
- 策略计算复用一期指标纯函数，避免两套公式漂移。

验收：

- 每个内置策略具备固定输入和预期信号测试；
- 非法参数不能保存或运行；
- 同一行情、策略版本和参数产生完全一致的信号；
- 短周期必须小于长周期等跨字段约束有明确错误信息。

### 6.3 买卖信号

功能：

- 在 K 线图中显示买入、卖出标记；
- 点击标记显示信号时间、原因、计划执行时间及实际成交情况；
- 可切换“原始信号”和“实际成交”；
- 列表展示被忽略、取消或拒绝的信号及原因；
- 信号颜色、形状和成交标记保持一致的视觉语义。

验收：

- 图表信号时间与策略输出严格一致；
- 成交标记位于实际成交 K 线，不错误显示在信号 K 线；
- 缩放、切换数据集和重复运行后标记不残留；
- 无下一交易日、无持仓卖出、余额不足等情况可追溯。

### 6.4 回测引擎

功能：

- 回测前校验数据、策略参数和资金参数；
- Web Worker 接收序列化任务并返回进度、结果、错误或取消状态；
- 按时间顺序执行策略、订单、撮合和每日估值；
- 支持取消运行，防止过期任务结果覆盖新任务；
- 引擎不依赖 React、Zustand、图表和 IndexedDB。

验收：

- 手工构造的小样例可逐日核对现金、持仓、手续费和权益；
- 信号不得在同一根 K 线收盘价成交；
- 余额不足时自动缩减至合法交易金额或拒绝，账户现金不为负；
- 1 万条日线数据的单策略回测目标在 1 秒内完成，页面无明显冻结；
- 取消任务后不保存半成品为已完成结果。

### 6.5 回测结果与绩效分析

首批指标：

- 初始资金、期末权益、累计收益率、基准收益率、超额收益率；
- 年化收益率、年化波动率、夏普比率；
- 最大回撤、最大回撤起止日期；
- 交易次数、胜率、盈亏比、平均持仓天数；
- 总手续费、总印花税、总滑点成本。

展示：

- 概览指标卡；
- 策略权益、基准权益和回撤曲线；
- 完整交易明细及按笔交易汇总；
- 回测参数、策略版本、数据校验和模型限制说明；
- 历史结果列表，支持打开、重命名、删除和最多三组结果对比。

验收：

- 绩效指标可由权益曲线和交易明细重新计算验证；
- 无交易、只买未卖、零波动和亏损场景不出现 `NaN` 或无限值；
- 刷新后历史结果可恢复；
- 删除源行情后，历史结果的策略、参数、指标和交易记录仍可查看。

## 7. 页面与交互规划

### 7.1 顶部导航

- 行情分析：保留一期现有功能；
- 数据管理：本地行情数据集；
- 策略回测：策略和回测参数配置；
- 回测结果：历史结果与对比。

### 7.2 策略回测页面

```text
┌ 数据集选择 ─ 策略选择 ─ 日期范围 ─ 运行/取消 ┐
├───────────────┬────────────────────────────┤
│ 策略参数       │ K 线、指标、信号与成交标记 │
│ 初始资金       │                            │
│ 仓位规则       ├────────────────────────────┤
│ 费用与滑点     │ 运行日志/信号与订单状态     │
└───────────────┴────────────────────────────┘
```

运行完成后切换至结果视图，但保留返回修改参数并再次运行的入口。

## 8. 开发阶段与工作量

按 1 名前端开发人员估算，二期 MVP 约 20～26 个开发人日；如由两人并行开发，可按数据/引擎与页面/图表拆分，但核心协议应先冻结。

### 阶段 0：规则确认与技术设计（1～2 人日）

- 确认只做多、下一日开盘成交、费用和强平规则；
- 冻结策略、信号、订单、成交、账户和结果模型；
- 建立手工可核对的回测黄金样例。

交付：模型定义、回测规则说明、黄金样例和接口草案。

### 阶段 1：本地数据持久化（3～4 人日）

- 引入 IndexedDB/Dexie，设计数据库 schema 和迁移；
- 实现行情数据集的保存、查询、打开、删除和重复检测；
- 实现数据管理页面，并接入一期导入流程；
- 补充 Repository 单元测试和刷新恢复测试。

交付：可持久化的本地行情库。

### 阶段 2：策略与信号系统（4～5 人日）

- 建立策略协议、注册表和参数校验；
- 完成双均线、RSI、MACD、BOLL 四个策略；
- 实现策略配置的保存、复制和删除；
- 实现信号列表及 K 线标记。

交付：可配置、可测试、可视化的策略信号系统。

### 阶段 3：撮合、账户与回测引擎（5～6 人日）

- 实现回测主循环、下一日订单队列和指标上下文；
- 实现仓位计算、交易金额取整、费用、税费、滑点和订单拒绝；
- 实现每日账户估值、强制平仓和交易配对；
- 接入 Web Worker、进度、取消和错误协议；
- 使用黄金样例逐日验证。

交付：与 UI 解耦、可独立测试的回测核心。

### 阶段 4：结果分析与持久化（4～5 人日）

- 实现绩效指标、收益曲线、基准曲线和回撤曲线；
- 实现交易明细、信号/订单追溯和成本汇总；
- 保存和打开历史结果；
- 实现最多三组结果对比。

交付：完整回测报告和历史结果库。

### 阶段 5：联调、性能与验收（3～4 人日）

- 补全边界测试、集成测试和回归测试；
- 验证 1 万条数据性能，排查内存和 Worker 生命周期；
- 完善错误提示、空状态、取消和恢复流程；
- 更新运行说明、策略说明和模型限制文档。

交付：二期可发布版本。

## 9. 测试计划

### 9.1 数据持久化测试

- 新增、读取、覆盖、删除和级联删除；
- 重复数据集 checksum；
- 1211 条样例的完整性和顺序；
- 数据库升级、写入中断、空间不足和损坏数据；
- 多数据集同标的、不同日期范围。

### 9.2 策略与信号测试

- 上穿、下穿、连续相等、预热期和数据不足；
- 指标值为 `null` 时不产生信号；
- 参数边界与跨字段约束；
- 信号去重及重复买卖处理；
- 通过固定行情验证四个内置策略的精确输出。

### 9.3 撮合与账户测试

- 正常买入卖出、余额不足、非法价格和无持仓卖出；
- 最小交易金额取整、全仓和固定比例仓位；
- 最低手续费、卖出印花税和双向滑点；
- 最后一日信号取消和期末强制平仓；
- 现金、持仓、市值和总权益守恒；
- 同一日多信号和重复信号的确定性处理。

### 9.4 绩效指标测试

- 无交易、单笔盈利、单笔亏损、多笔交易；
- 创新高、连续回撤和完全不变的权益曲线；
- 最大回撤区间、年化折算、波动率和夏普比率；
- 胜率、盈亏比和平均持仓天数；
- 与手工表格或独立参考实现交叉核对。

### 9.5 集成与回归测试

- 导入 → 保存 → 选择数据 → 配置策略 → 运行 → 保存结果 → 刷新恢复；
- 运行中取消、连续快速运行和切换数据集；
- 一期行情图、指标和 Excel 导入功能无回归；
- 1 万条行情、多次运行后的内存占用和交互流畅度。

## 10. 质量门槛

二期发布前必须满足：

- `npm test` 和 `npm run build` 全部通过；
- 回测引擎、撮合、账户和绩效模块的语句/分支覆盖率目标不低于 90%；
- 黄金样例的现金、持仓、成交和权益逐日结果完全一致；
- 不存在同 K 线看收盘价并按该收盘价成交的未来函数；
- 所有回测结果包含数据 checksum、策略版本、参数和费用配置；
- 1 万条日线单策略回测目标小于 1 秒，页面不冻结；
- 所有失败和取消任务均有明确状态，不产生伪完成结果；
- 一期功能通过回归验收。

## 11. 主要风险与控制措施

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| 未来函数或信号/成交时间混淆 | 收益严重失真 | 固定下一交易日开盘成交，黄金样例逐日核对 |
| 指标实现与策略实现不一致 | 图表和回测信号漂移 | 复用一期指标纯函数，只保留一套计算源 |
| 浮点误差与费用口径不清 | 账户对不上 | 金额统一精度策略，逐笔记录费用及舍入规则 |
| IndexedDB 数据升级失败 | 本地数据不可用 | 显式 schema 版本、迁移测试和导出备份预留 |
| 大结果占用存储过多 | 写入失败或页面变慢 | 行情去重、结果摘要/明细拆表、保存前容量提示 |
| 浏览器执行用户代码 | 安全和稳定性风险 | 二期仅注册式内置策略，不执行任意脚本 |
| 策略过拟合 | 回测结果误导 | 展示基准和成本，注明模型限制，后续增加样本外分析 |

## 12. 二期交付物

- 本地行情数据库及数据管理页面；
- 策略协议、四个内置策略和策略配置管理；
- 买卖信号、订单和成交可视化；
- Web Worker 回测引擎、撮合模型和账户模型；
- 绩效指标、收益/回撤曲线、交易明细和结果对比；
- 历史回测结果保存与读取；
- 核心模块自动化测试和黄金样例；
- 二期运行说明、策略说明、回测规则及模型限制文档。

## 13. 后续演进建议

二期完成后再根据真实使用情况选择三期方向：

1. 多标的组合回测和资金分配；
2. 参数批量寻优、样本内/样本外和 Walk-forward；
3. CSV/Parquet 导入导出及数据更新合并；
4. FastAPI + Polars/Pandas 后端和任务队列；
5. Python 策略 SDK、隔离执行环境和服务端结果复核；
6. 分钟级行情、涨跌停、停牌、成交量约束和更精细的撮合模型。

不建议在二期同时引入任意策略代码、多标的和服务端架构；先让单标的回测规则正确、结果可解释、过程可复现，再扩展计算规模。
