# 量化回测项目总览与业务流程

## 1. 项目定位

本项目是面向日频、单标的、只做多研究场景的量化分析与策略回测平台。当前业务主线已经从早期的浏览器本地工具，演进为“React 前端 + Fastify 服务端 + MySQL 持久化 + Web Worker 计算”的本地全栈应用。

系统围绕以下闭环建设：

```text
获得并治理行情数据
        ↓
行情与技术指标分析
        ↓
创建或选择交易策略
        ↓
配置并运行回测
        ↓
分析、比较和保存结果
        ↓
参数研究与样本外验证
        ↓
形成可复现的策略研究结论
```

## 2. 完整业务流程图

图例：蓝色为当前仓库已实现能力，橙色为可选外部能力，紫色为后续规划能力。

```mermaid
flowchart TD
    U["用户"] --> ENTRY{"选择业务入口"}

    ENTRY --> DATA["数据获取与管理"]
    ENTRY --> ANALYSIS["行情分析"]
    ENTRY --> STRATEGY["策略创建与管理"]
    ENTRY --> BACKTEST["策略回测"]
    ENTRY --> RESULTS["回测结果"]

    subgraph DATA_FLOW["数据业务"]
        DATA --> IMPORT["批量导入 Excel 日线"]
        IMPORT --> PARSE["表头映射与类型转换"]
        PARSE --> VALIDATE["日期、重复、OHLC 与异常交易日校验"]
        VALIDATE --> VALID_DECISION{"数据是否可用"}
        VALID_DECISION -->|"严重错误"| IMPORT_ERROR["展示错误并终止导入"]
        VALID_DECISION -->|"通过或仅有警告"| PREVIEW["预览标的、日期范围与警告"]
        PREVIEW --> DEDUP["按 checksum 检查重复"]
        DEDUP --> PERSIST["保存数据集与 K 线"]

        MIGRATION["IndexedDB 历史数据"] --> MIGRATE["导出、导入与迁移校验"]
        MIGRATE --> PERSIST

        AUTO["第五阶段：自动数据源"] --> SYNC["历史回补与每日增量同步"]
        SYNC --> QUALITY["标准化、复权与数据质量检查"]
        QUALITY --> PERSIST
    end

    PERSIST --> MYSQL[("MySQL")]
    MYSQL --> LIBRARY["数据管理与数据集选择"]
    LIBRARY --> ANALYSIS
    LIBRARY --> BACKTEST

    subgraph ANALYSIS_FLOW["行情分析业务"]
        ANALYSIS --> CANDLE["K 线与成交量展示"]
        CANDLE --> INDICATOR["选择并配置技术指标"]
        INDICATOR --> CALC["SMA、EMA、BOLL、MACD、RSI 等计算"]
        CALC --> CHART["主图叠加或独立副图"]
        CANDLE --> CROSSHAIR["十字光标与行情详情"]
        CANDLE --> RANGE["开启区间选择"]
        RANGE --> RANGE_LINE["拖动两条蓝线"]
        RANGE_LINE --> RANGE_RESULT["计算起止价格、涨跌额和涨跌幅"]
    end

    subgraph STRATEGY_FLOW["策略业务"]
        STRATEGY --> STRATEGY_SOURCE{"策略来源"}
        STRATEGY_SOURCE --> BUILTIN["内置参数化策略"]
        STRATEGY_SOURCE --> VISUAL["可视化策略工作室"]
        STRATEGY_SOURCE --> AI["自然语言生成策略"]

        VISUAL --> DSL_EDIT["节点与规则编辑"]
        DSL_EDIT --> DSL["统一 Strategy DSL"]

        AI --> AI_STATUS{"AI 服务是否配置"}
        AI_STATUS -->|"未配置"| MOCK["Mock Provider 联调"]
        AI_STATUS -->|"已配置"| MODEL["OpenAI 兼容模型服务"]
        MOCK --> AI_DRAFT["生成策略草稿"]
        MODEL --> AI_DRAFT
        AI_DRAFT --> REVIEW["用户审查、修改与确认"]
        REVIEW --> DSL

        DSL --> DSL_VALIDATE["Schema、语义、引用与未来函数校验"]
        DSL_VALIDATE --> DSL_DECISION{"校验是否通过"}
        DSL_DECISION -->|"否"| DSL_EDIT
        DSL_DECISION -->|"是"| PREVIEW_SIGNAL["信号预览与解释"]
        PREVIEW_SIGNAL --> VERSION["保存草稿或发布不可变版本"]
        VERSION --> MYSQL
    end

    BUILTIN --> BACKTEST
    VERSION --> BACKTEST

    subgraph BACKTEST_FLOW["回测业务"]
        BACKTEST --> BT_DATA["选择数据集与日期范围"]
        BT_DATA --> BT_MODE{"选择回测模式"}
        BT_MODE --> NORMAL["策略回测"]
        BT_MODE --> DCA["定投回测"]

        NORMAL --> BT_STRATEGY["选择策略与参数"]
        BT_STRATEGY --> BT_CONFIG["配置资金、仓位、费用、税费与滑点"]
        DCA --> DCA_CONFIG["配置投入金额和定投频率"]

        BT_CONFIG --> WORKER["Web Worker 执行"]
        DCA_CONFIG --> WORKER
        WORKER --> SIGNAL["收盘后生成信号"]
        SIGNAL --> MATCH["下一交易日开盘撮合"]
        MATCH --> ACCOUNT["更新现金、持仓、成本与权益"]
        ACCOUNT --> LOOP{"是否还有交易日"}
        LOOP -->|"是"| SIGNAL
        LOOP -->|"否"| LIQUIDATE["期末强制平仓"]
        LIQUIDATE --> METRICS["计算收益、夏普、回撤、胜率与盈亏比"]
        METRICS --> SAVE_RESULT["保存配置快照、交易、信号和权益曲线"]
        SAVE_RESULT --> MYSQL
    end

    subgraph RESULT_FLOW["结果分析业务"]
        RESULTS --> RESULT_LIST["查询、排序、选择和批量删除"]
        RESULT_LIST --> RESULT_DETAIL["查看单次回测详情"]
        RESULT_DETAIL --> OVERVIEW["绩效指标总览"]
        RESULT_DETAIL --> EQUITY["权益、基准与回撤曲线"]
        RESULT_DETAIL --> TRADES["交易记录与信号明细"]
        RESULT_LIST --> COMPARE["多结果对比"]
        COMPARE --> COMPARE_CHART["统一归一化曲线和指标比较"]
        RESULT_LIST --> EXPORT["Excel、CSV 或 JSON 导出"]
    end

    MYSQL --> RESULTS

    SAVE_RESULT --> EXPERIMENT["第四阶段规划：策略实验室"]
    EXPERIMENT --> PARAM_SPACE["网格或随机参数空间"]
    PARAM_SPACE --> BATCH["批量回测调度"]
    BATCH --> HOLDOUT["训练集与验证集隔离"]
    HOLDOUT --> WALK_FORWARD["Walk-forward 滚动验证"]
    WALK_FORWARD --> ROBUST["排行榜、热力图与稳健性分析"]
    ROBUST --> CANDIDATE["候选参数回填单次回测"]
    CANDIDATE --> BACKTEST

    classDef current fill:#e6f4ff,stroke:#1677ff,color:#102a43,stroke-width:1.5px;
    classDef optional fill:#fff7e6,stroke:#fa8c16,color:#613400,stroke-width:1.5px;
    classDef planned fill:#f9f0ff,stroke:#722ed1,color:#391085,stroke-width:1.5px,stroke-dasharray:5 4;
    classDef storage fill:#f6ffed,stroke:#52c41a,color:#135200,stroke-width:2px;

    class U,ENTRY,DATA,ANALYSIS,STRATEGY,BACKTEST,RESULTS,IMPORT,PARSE,VALIDATE,VALID_DECISION,IMPORT_ERROR,PREVIEW,DEDUP,PERSIST,MIGRATION,MIGRATE,LIBRARY,CANDLE,INDICATOR,CALC,CHART,CROSSHAIR,RANGE,RANGE_LINE,RANGE_RESULT,STRATEGY_SOURCE,BUILTIN,VISUAL,DSL_EDIT,DSL,AI_STATUS,MOCK,AI_DRAFT,REVIEW,DSL_VALIDATE,DSL_DECISION,PREVIEW_SIGNAL,VERSION,BT_DATA,BT_MODE,NORMAL,DCA,BT_STRATEGY,BT_CONFIG,DCA_CONFIG,WORKER,SIGNAL,MATCH,ACCOUNT,LOOP,LIQUIDATE,METRICS,SAVE_RESULT,RESULT_LIST,RESULT_DETAIL,OVERVIEW,EQUITY,TRADES,COMPARE,COMPARE_CHART,EXPORT current;
    class AI,MODEL optional;
    class AUTO,SYNC,QUALITY,EXPERIMENT,PARAM_SPACE,BATCH,HOLDOUT,WALK_FORWARD,ROBUST,CANDIDATE planned;
    class MYSQL storage;
```

## 3. 当前系统架构与数据流

```mermaid
flowchart LR
    subgraph CLIENT["浏览器前端"]
        UI["React 与 Ant Design 页面"]
        STORE["Zustand 页面状态"]
        CHARTS["Lightweight Charts"]
        IMPORTER["SheetJS Excel 解析"]
        WORKERS["Web Worker 回测计算"]
        REPO["统一 IDataRepository"]
    end

    subgraph SERVER["Fastify 服务端"]
        API["数据集、策略、结果、迁移与导出 API"]
        AI_API["AI 策略生成 API"]
        SERVICE["数据服务与 Zod 校验"]
        ORM["Drizzle ORM"]
        PROVIDER["Mock 或 OpenAI Provider"]
    end

    DB[("MySQL")]
    LEGACY[("IndexedDB 兼容与迁移源")]
    MODEL["外部模型服务"]

    IMPORTER --> STORE
    STORE --> CHARTS
    STORE --> WORKERS
    WORKERS --> STORE
    UI <--> STORE
    UI --> REPO
    REPO -->|"API 模式"| API
    REPO -->|"兼容或迁移模式"| LEGACY
    API --> SERVICE --> ORM --> DB
    AI_API --> PROVIDER
    PROVIDER -->|"可选"| MODEL
    AI_API --> UI
```

架构原则：

- 页面通过统一 Repository 访问数据，不直接依赖 MySQL；
- 回测核心仍在浏览器 Web Worker 中运行，服务端负责持久化与 AI 接口；
- MySQL 不可用时服务端数据接口返回明确错误，不应静默产生数据分叉；
- AI 只生成受限 Strategy DSL 草稿，不能直接执行任意代码或自动运行回测；
- 数据集、策略版本、回测配置和结果快照共同保证研究可复现。

## 4. 当前业务模块总览

| 业务域 | 当前能力 | 主要输入 | 主要输出 | 状态 |
| --- | --- | --- | --- | --- |
| 数据导入 | Excel 批量导入、字段映射、校验、去重 | `.xlsx` 日线文件 | 标准化 `Candle[]` | 已实现 |
| 数据管理 | 保存、查询、打开、删除、导出与迁移 | 数据集和 K 线 | MySQL 数据集 | 已实现 |
| 行情分析 | K 线、成交量、指标、十字光标、区间涨跌幅 | 行情数据 | 图表与区间结果 | 已实现 |
| 技术指标 | 11 类常用指标及参数编辑 | `Candle[]`、指标参数 | 指标序列 | 已实现 |
| 内置策略 | 双均线、RSI、MACD、BOLL | 行情和策略参数 | 买卖信号 | 已实现 |
| 可视化策略 | DSL、节点编辑、校验、草稿和版本 | 用户规则 | Strategy DSL 版本 | 已实现 |
| AI 策略 | 生成、修改和解释策略草稿 | 自然语言提示词 | 受限 DSL 草稿 | 可选配置 |
| 策略回测 | 信号、撮合、仓位、费用、滑点和强平 | 数据集、策略、配置 | 交易和权益曲线 | 已实现 |
| 定投回测 | 周期投入、现金流净值和定投绩效 | 数据集、金额、频率 | 定投结果 | 已实现 |
| 结果分析 | 指标、明细、权益曲线、基准和多结果比较 | 历史回测结果 | 分析报告 | 已实现 |
| 数据迁移 | IndexedDB 导出、MySQL 导入和核对 | 浏览器历史数据 | MySQL 数据 | 初步实现 |
| 参数实验 | 网格/随机搜索、Holdout、Walk-forward | 策略参数空间 | 稳健候选参数 | 规划目标，当前代码未见完整入口 |
| 自动数据 | 历史回补、增量同步、复权和质量治理 | 外部行情源 | 版本化行情数据 | 第五阶段规划 |
| 因子研究 | IC、分层、中性化和多因子合成 | 截面行情和财务数据 | 因子报告 | 第六阶段候选 |

## 5. 策略回测核心时序

```mermaid
sequenceDiagram
    actor User as 用户
    participant UI as 回测页面
    participant Repo as 数据 Repository
    participant Worker as 回测 Worker
    participant Engine as 回测引擎
    participant DB as MySQL

    User->>UI: 选择数据集、策略和费用参数
    UI->>Repo: 读取数据集与 K 线
    Repo->>DB: 查询数据
    DB-->>Repo: 返回行情
    Repo-->>UI: 标准化 Candle 数据
    User->>UI: 启动回测
    UI->>Worker: 发送行情、策略快照和回测配置
    Worker->>Engine: 逐交易日执行

    loop 每个交易日
        Engine->>Engine: 读取当前及历史数据
        Engine->>Engine: 收盘后生成信号
        Engine->>Engine: 下一交易日开盘撮合
        Engine->>Engine: 更新资金、持仓和权益
    end

    Engine-->>Worker: 指标、交易、信号和权益曲线
    Worker-->>UI: 返回完成结果
    UI->>Repo: 保存完整结果快照
    Repo->>DB: 写入结果与权益点
    DB-->>Repo: 保存成功
    Repo-->>UI: 返回结果 ID
    UI-->>User: 展示绩效与交易明细
```

## 6. 数据生命周期

```mermaid
stateDiagram-v2
    [*] --> 待获取
    待获取 --> 已解析: Excel 导入或自动同步
    已解析 --> 校验失败: 严重结构或数值错误
    已解析 --> 有警告: 可疑但可继续
    已解析 --> 已通过: 校验正常
    校验失败 --> 待获取: 修复来源后重试
    有警告 --> 已通过: 用户确认或重新校验
    有警告 --> 校验失败: 确认为不可用
    已通过 --> 已持久化: MySQL 原子写入
    已持久化 --> 使用中: 行情分析或回测
    使用中 --> 已快照: 保存回测引用版本
    已持久化 --> 新版本: 数据修订或复权因子变化
    新版本 --> 已通过: 重新执行质量检查
    已快照 --> [*]
```

## 7. 项目阶段演进

```mermaid
timeline
    title 量化回测平台阶段演进
    一期 : Excel 行情导入
         : K 线与技术指标
    二期 : 数据持久化
         : 策略回测与结果分析
    三期 : 可视化策略工作室
         : Strategy DSL 与 AI 草稿
    3.5 阶段 : 定投回测
             : 多结果比较与数据交换
    四期 : 参数实验与稳健性规划
         : Holdout 与 Walk-forward 目标
    4.5 阶段 : 区间涨跌幅与定投指标修复
             : MySQL 迁移与前后端一键启动
    五期 : 自动获取日线数据
         : 复权、调度和质量治理
    六期候选 : 因子研究与多因子评价
```

## 8. 当前边界与风险

- 当前主要面向日频、单标的、只做多研究，不等同于真实交易系统；
- 回测使用收盘信号、下一交易日开盘成交，未完整模拟涨跌停、停牌、流动性和冲击成本；
- AI 生成内容必须经过 DSL 校验、人工确认和本地回测，不能视为投资建议；
- 第四阶段文档描述的批量实验和 Walk-forward 尚需与当前代码入口重新核对并完成接入；
- README 仍包含“默认使用 IndexedDB”和旧结果数量限制等过时描述，应在 4.5 阶段收口时更新；
- 自动数据上线前必须明确数据授权、复权口径、交易日历和异常修订规则；
- 因子研究开始前，应先确保自动数据链路稳定并具备时点化、版本化能力。

## 9. 建议的用户主路径

1. 在“数据管理”中导入 Excel，或在第五阶段通过自动数据源同步行情；
2. 查看数据校验、来源、日期范围和质量状态；
3. 打开“行情分析”，添加指标并使用蓝线区间工具观察阶段表现；
4. 选择内置策略，或在“策略工作室”创建并发布可视化策略；
5. 在“策略回测”中设置资金、费用、滑点和运行区间；
6. 运行回测并在“回测结果”中检查收益、回撤、交易和权益曲线；
7. 将多个结果放在相同基准下比较，淘汰样本少、回撤大或表现不稳定的方案；
8. 待策略实验室完整接入后，再执行参数搜索、样本外验证和 Walk-forward；
9. 保存策略版本、数据版本和回测配置，形成可重复验证的研究记录。
