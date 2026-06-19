# 量化行情展示项目：三期可视化策略与 AI 生成开发计划

## 1. 三期目标

三期在现有行情、指标和回测引擎之上建设“可视化策略工作室”，让用户无需修改 TypeScript 源码即可完成策略设计、信号预览、回测和版本管理。

核心闭环：

```text
可视化规则编排 / 自然语言提示词
                ↓
        统一 Strategy DSL
                ↓
    Schema 校验 + 语义校验 + 风险检查
                ↓
      编译为现有 StrategyDefinition
                ↓
       信号预览 → 回测 → 保存版本
```

三期同时预留 OpenAI API 服务端接口。用户后续提供 API 密钥后，只需启用服务端配置即可使用“一键生成策略”，不需要改动前端策略协议和回测引擎。

## 2. 设计原则

1. **同一策略来源**：手工编排和 AI 生成必须产出相同的 Strategy DSL；
2. **DSL 是唯一事实来源**：画布节点、表单和自然语言说明都只是 DSL 的不同视图；
3. **禁止执行任意代码**：不使用 `eval`、`new Function`、动态脚本或模型生成的 JavaScript；
4. **禁止未来函数**：任何价格或指标引用只能使用当前及历史 K 线；
5. **先验证后执行**：AI 输出和用户编辑内容必须经过结构、语义和回测前校验；
6. **用户最终确认**：AI 生成结果只能进入草稿，不能自动保存、运行或覆盖现有策略；
7. **密钥只在服务端**：OpenAI API 密钥不得写入前端代码、IndexedDB、URL 或 `VITE_*` 环境变量；
8. **策略可复现**：回测结果记录 DSL 版本、策略版本、参数快照和数据 checksum。

## 3. 三期范围

### 3.1 MVP 范围

- 可视化创建买入规则、卖出规则和过滤条件；
- 支持 AND、OR、NOT 逻辑分组和嵌套；
- 支持行情字段、技术指标、常量和参数之间的比较；
- 支持大于、小于、等于、上穿、下穿和区间判断；
- 支持指标参数配置和历史偏移；
- 支持仓位状态、持仓天数和浮动盈亏等账户条件；
- 支持止盈、止损、最大持仓天数等退出规则；
- 策略实时校验、自然语言摘要和指定区间信号预览；
- 策略草稿、版本、复制、导入和导出；
- OpenAI 提示词生成、修改和解释策略；
- AI 未配置时保留入口并显示明确配置状态；
- 自定义策略接入现有 Web Worker 回测引擎。

### 3.2 暂不纳入三期

- 用户任意 Python、JavaScript 或 Pine Script 执行；
- 高频、Tick 级和事件驱动策略；
- 多标的组合、跨品种套利和动态选股；
- 自动参数寻优和自动循环调用模型；
- AI 自动运行回测、自动修改策略或自动交易；
- 将完整本地行情上传给 OpenAI；
- 云端策略市场和多人协作。

## 4. 可视化策略工作室

### 4.1 页面布局

桌面端采用四区布局：

```text
┌ 工具栏：策略名称 / 版本 / 撤销重做 / 校验 / 预览 / 保存 / AI 生成 ┐
├────────────┬─────────────────────────┬──────────────┤
│ 节点与模板  │       规则编排画布       │ 节点属性面板  │
│            │                         │              │
│ 行情字段    │  指标 → 条件 → 逻辑组    │ 参数/运算符   │
│ 技术指标    │       → 买入/卖出        │ 错误与说明    │
│ 条件节点    │                         │              │
│ 风控节点    │                         │              │
├────────────┴─────────────────────────┴──────────────┤
│ 信号预览：K 线、指标、买卖标记、当前规则计算过程      │
└────────────────────────────────────────────────────┘
```

响应式规则：

- `>= 1440px`：左侧 240px、右侧 320px，中间画布自适应；
- `1024～1439px`：节点库收窄，属性面板可折叠；
- `< 1024px`：节点库和属性面板改为抽屉，画布占满；
- `< 768px`：默认切换为“规则列表”视图，避免在手机上强行拖拽复杂节点；
- 所有按钮和节点具备键盘焦点、文本标签和不依赖颜色的状态提示。

### 4.2 交互模式

- 从节点库拖入行情字段、指标、条件、逻辑组和动作节点；
- 连线建立数据和逻辑依赖；
- 点击节点在右侧修改指标周期、比较方式、阈值和历史偏移；
- AND/OR 分组同时支持画布表达和结构化规则树；
- 节点删除、移动、连接和参数修改全部进入撤销/重做历史；
- 画布自动布局、缩放、框选、复制粘贴和错误节点定位；
- 保存前展示自然语言摘要，例如“5 日均线上穿 20 日均线且 RSI 小于 70 时买入”；
- 预览模式可选择某个日期，逐层展示操作数、条件结果和最终动作。

### 4.3 建议前端技术

| 能力 | 建议技术 |
| --- | --- |
| 节点画布 | `@xyflow/react`（React Flow） |
| 拖拽与排序 | React Flow 内置交互，列表视图可用 `dnd-kit` |
| 表单和抽屉 | 现有 Ant Design |
| DSL 校验 | Zod discriminated union |
| 编辑状态 | Zustand + Immer |
| 撤销重做 | Command/patch history，限制历史长度 |
| 自动布局 | Dagre 或 ELK，按需加载 |
| 信号预览 | 复用 Lightweight Charts |

视觉上延续现有浅色金融分析界面，不单独引入暗色玻璃拟态，优先保证高信息密度、对比度和图表可读性。

## 5. Strategy DSL

### 5.1 顶层模型

```ts
interface VisualStrategyDocument {
  schemaVersion: '1.0';
  id: string;
  name: string;
  description: string;
  strategyVersion: number;
  parameters: StrategyParameter[];
  indicators: IndicatorNode[];
  entry: RuleGroup;
  exit: RuleGroup;
  risk: RiskRule[];
  metadata: {
    source: 'visual' | 'ai' | 'imported';
    createdAt: string;
    updatedAt: string;
    aiGenerationId?: string;
  };
}
```

### 5.2 操作数

```ts
type Operand =
  | { type: 'market'; field: 'open' | 'high' | 'low' | 'close' | 'volume'; offset: number }
  | { type: 'indicator'; nodeId: string; output: string; offset: number }
  | { type: 'account'; field: 'hasPosition' | 'holdingDays' | 'unrealizedPnlPercent' }
  | { type: 'parameter'; name: string }
  | { type: 'literal'; value: number | boolean };
```

- `offset=0` 表示当前 K 线，负数表示历史 K 线；
- `offset>0` 一律拒绝，防止未来函数；
- 指标输出必须引用已经声明且能拓扑排序的指标节点；
- 数值、布尔和序列类型必须在编译前完成类型检查。

### 5.3 条件和逻辑组

```ts
type CompareOperator =
  | 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  | 'crossesAbove' | 'crossesBelow'
  | 'between';

interface ConditionRule {
  type: 'condition';
  id: string;
  left: Operand;
  operator: CompareOperator;
  right: Operand;
  upper?: Operand;
}

interface RuleGroup {
  type: 'group';
  id: string;
  operator: 'all' | 'any' | 'not';
  children: Array<ConditionRule | RuleGroup>;
}
```

### 5.4 风控规则

MVP 支持：

- 固定百分比止损；
- 固定百分比止盈；
- 最大持仓交易日；
- 入场后移动止损作为后续增强项；
- 风控退出优先级高于普通卖出规则，并在信号原因中标明来源。

## 6. DSL 编译与执行

新增 `visualStrategies` 模块：

```text
VisualStrategyDocument
  ↓ schemaValidator       结构和字段范围
  ↓ semanticValidator     类型、引用、循环、未来函数、空规则
  ↓ dependencyPlanner     指标依赖拓扑排序和预热期
  ↓ strategyCompiler      编译为纯函数执行计划
  ↓ StrategyDefinition    接入现有回测引擎
```

编译器要求：

- 输出继续实现现有 `StrategyDefinition`，避免重写回测引擎；
- 不生成源码字符串，不执行动态代码；
- 上穿/下穿必须同时读取当前值和前一值；
- 自动计算所有指标的最大预热期；
- 相同指标及参数复用计算结果；
- 每个条件生成可解释 trace，供预览和调试；
- 编译结果可序列化标识，但函数本身不写入 IndexedDB；
- Worker 收到 DSL 后在 Worker 内重新校验并编译，不能信任主线程结果。

## 7. OpenAI 策略生成接口

### 7.1 架构

三期增加最小 Node.js 服务端，建议采用 Fastify + OpenAI 官方 JavaScript SDK：

```text
浏览器 Strategy Studio
        ↓ POST /api/ai/strategies/generate
本地/部署后的 Fastify 服务
        ↓ Responses API + Structured Outputs
OpenAI API
        ↓ 符合 JSON Schema 的 Strategy DSL 草稿
服务端 Zod 校验与安全检查
        ↓
前端差异预览 → 用户确认 → 本地保存
```

OpenAI 官方文档将 Responses API 作为统一文本生成接口；结构化策略输出使用 JSON Schema 约束的 Structured Outputs。实现时以官方 [Text generation](https://developers.openai.com/api/docs/guides/text) 和 [Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs) 文档为准。

### 7.2 为什么必须有服务端

- 浏览器构建产物中的任何密钥都可以被用户查看；
- API 密钥只能从服务端 `OPENAI_API_KEY` 环境变量读取；
- 服务端负责超时、限流、请求大小、模型白名单和错误归一化；
- 服务端负责把内部 DSL JSON Schema 交给模型，并再次验证返回值；
- 前端只调用自己的 `/api/ai/*`，永远不接收或保存 API 密钥。

密钥管理遵循 OpenAI 官方 [API key safety best practices](https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety)。

### 7.3 配置约定

仓库保留 `.env.example`，真实 `.env` 已加入 `.gitignore`：

```dotenv
AI_STRATEGY_ENABLED=false
OPENAI_API_KEY=
OPENAI_MODEL=
OPENAI_TIMEOUT_MS=30000
```

- 未提供密钥时服务正常启动，但 AI 端点返回 `AI_NOT_CONFIGURED`；
- `AI_STRATEGY_ENABLED=false` 时前端显示“AI 未启用”，不发起请求；
- 模型通过 `OPENAI_MODEL` 配置，不在代码中写死，以便后续升级；
- 不提供允许前端修改 API Key、Base URL 或模型白名单的页面；
- `.env.example` 只保留空值，任何真实密钥不得进入 Git 历史。

### 7.4 服务端抽象

```ts
interface StrategyGenerationProvider {
  generate(request: GenerateStrategyRequest): Promise<GenerateStrategyResult>;
  refine(request: RefineStrategyRequest): Promise<GenerateStrategyResult>;
  explain(request: ExplainStrategyRequest): Promise<StrategyExplanation>;
}
```

实现：

- `MockStrategyGenerationProvider`：无密钥时用于前端联调和自动化测试；
- `OpenAIStrategyGenerationProvider`：后续提供密钥后启用；
- 路由和业务层只依赖接口，不直接依赖 OpenAI SDK。

### 7.5 API 草案

#### 获取 AI 状态

```http
GET /api/ai/status
```

```json
{
  "enabled": false,
  "configured": false,
  "provider": "openai"
}
```

不得返回密钥、密钥前缀、组织信息或服务端环境变量。

#### 根据提示词生成策略

```http
POST /api/ai/strategies/generate
Content-Type: application/json
```

```json
{
  "prompt": "5 日均线上穿 20 日均线且 RSI 小于 70 时买入，下穿时卖出，止损 8%",
  "datasetContext": {
    "timeframe": "1d",
    "availableFields": ["open", "high", "low", "close", "volume"]
  },
  "dslVersion": "1.0"
}
```

响应：

```json
{
  "generationId": "uuid",
  "strategy": {},
  "summary": "策略自然语言摘要",
  "warnings": [],
  "requiresConfirmation": true
}
```

#### 修改策略

```http
POST /api/ai/strategies/refine
```

请求包含当前 DSL、用户修改要求和 DSL 版本；响应必须返回完整的新草稿，不直接覆盖旧版本。

#### 解释策略

```http
POST /api/ai/strategies/explain
```

只返回解释、风险和参数说明，不修改策略。

### 7.6 模型请求约束

- 使用 Responses API；
- 使用 Structured Outputs，将 `VisualStrategyDocument` JSON Schema 作为输出格式；
- 系统指令明确禁止未来函数、未知指标、任意代码和自动交易行为；
- 服务端只发送 DSL schema、可用指标目录、用户提示词和必要的字段摘要；
- 默认不发送完整行情、交易明细、文件内容或其他本地数据；
- 返回后依次执行 JSON Schema、Zod、语义和未来函数校验；
- 校验失败可在服务端进行最多一次结构修复，仍失败则返回可解释错误；
- 模型拒绝、安全拦截、超时和限流必须映射为稳定的业务错误码；
- 不把模型输出写入日志；开发模式日志仅记录 generationId、耗时和错误类型。

## 8. AI 生成交互

1. 用户点击“AI 生成策略”；
2. 输入策略描述，可选择插入常用提示模板；
3. 页面显示会发送的上下文摘要，明确提示不会上传完整行情；
4. AI 返回后进入草稿对比页；
5. 左侧显示自然语言摘要，中间显示画布，右侧显示校验和风险提示；
6. 用户可以“应用草稿”“继续修改”或“放弃”；
7. 应用后仍需完成本地信号预览才能保存正式版本；
8. 运行回测前再次确认数据集、费用、执行时点和策略版本。

AI 按钮状态：

- 未启用：按钮可见但带“未配置”标记，点击展示配置说明；
- 请求中：禁止重复提交，显示可取消进度；
- 生成成功：显示草稿，不自动运行；
- 生成失败：保留用户提示词并展示可重试错误；
- 配额或限流：展示服务端返回的稳定错误，不暴露原始响应。

## 9. 数据持久化与版本

IndexedDB 增加版本并新增表：

```text
visualStrategies:  id, name, updatedAt, status
strategyVersions:  [strategyId+version], strategyId, createdAt
strategyDrafts:    id, strategyId, updatedAt
```

规则：

- 编辑中自动保存草稿；
- 正式保存产生不可变版本号；
- 回测结果保存完整 DSL 快照或内容哈希与不可变版本引用；
- 删除策略不删除历史回测中的策略快照；
- `schemaVersion` 与 `strategyVersion` 分开管理；
- DSL schema 升级必须提供迁移函数和迁移测试；
- AI 生成只记录 generationId 和来源，不持久化密钥或服务端请求头。

## 10. 建议目录

```text
src/
  features/
    strategyStudio/
      StrategyStudioPage.tsx
      canvas/
      nodeLibrary/
      propertyPanel/
      preview/
      history/
    visualStrategies/
      schema.ts
      types.ts
      validator.ts
      semanticValidator.ts
      compiler.ts
      evaluator.ts
      explainer.ts
      migrations/
    aiStrategy/
      api.ts
      types.ts
      GenerateStrategyDrawer.tsx
      StrategyDraftReview.tsx
  workers/
    strategyPreview.worker.ts

server/
  src/
    app.ts
    config.ts
    routes/aiStrategies.ts
    services/strategyGeneration/
      provider.ts
      mockProvider.ts
      openaiProvider.ts
      prompts.ts
      schema.ts
```

## 11. 开发阶段与工作量

按 1 名全栈开发人员估算，三期 MVP 约 28～36 个开发人日。

### 阶段 0：规则协议与原型（3～4 人日）

- 冻结 Strategy DSL v1；
- 设计未来函数、类型、引用和循环校验；
- 完成桌面、平板和移动端交互原型；
- 准备 10 个可人工核对的策略样例。

### 阶段 1：DSL 校验与编译器（5～6 人日）

- Zod schema、语义校验和迁移框架；
- 指标依赖、预热期和执行计划；
- 编译到现有 `StrategyDefinition`；
- 条件 trace 和信号原因；
- 核心单元测试。

### 阶段 2：可视化编辑器（7～9 人日）

- 节点库、画布、属性面板和规则列表；
- 连线、嵌套逻辑、撤销重做和自动布局；
- 实时校验和自然语言摘要；
- 响应式抽屉和键盘可访问性。

### 阶段 3：信号预览与回测集成（4～5 人日）

- Worker 中编译和预览策略；
- K 线信号标记及规则 trace；
- 接入现有回测、结果和策略版本快照；
- 性能优化与缓存。

### 阶段 4：OpenAI 接口预留与 Mock 联调（4～5 人日）

- Fastify 服务、配置和 Provider 接口；
- `/status`、`/generate`、`/refine` 和 `/explain`；
- Mock Provider 和前端完整交互；
- OpenAI Provider、Responses API 和 Structured Outputs；
- 无密钥、超时、拒绝、限流和错误处理。

阶段 4 可以在没有真实 API 密钥的情况下完成；OpenAI Provider 的契约测试使用 Mock Client，不向外网发请求。

### 阶段 5：版本管理与验收（5～7 人日）

- 草稿、版本、复制、导入导出和数据库迁移；
- AI 草稿差异审查；
- 安全、性能、响应式和端到端测试；
- 文档、示例策略和验收。

## 12. 测试计划

### 12.1 DSL 与编译器

- 每种操作数、比较运算符和逻辑组；
- 嵌套 AND/OR/NOT；
- 上穿和下穿边界；
- 未知指标、未知输出、类型不匹配和循环依赖；
- `offset>0` 未来函数拒绝；
- 预热期和空值传播；
- 同一 DSL 多次编译和运行结果一致；
- 可视化策略与等价内置策略信号完全一致。

### 12.2 可视化编辑器

- 节点创建、连接、断开、删除和复制；
- 属性修改、撤销重做和草稿恢复；
- 错误节点定位和自然语言摘要；
- 键盘操作、焦点顺序和屏幕阅读器标签；
- 375、768、1024 和 1440px 响应式布局；
- 复杂规则下画布性能和列表视图可用性。

### 12.3 AI 接口

- 未配置密钥和禁用状态；
- 合法 Structured Output；
- 非法 JSON、缺字段、未知指标和未来函数；
- 模型拒绝、超时、限流、网络错误和取消；
- 请求大小和提示词长度限制；
- 返回内容不会绕过本地校验；
- AI 草稿不会自动保存或运行；
- 日志、响应和前端状态中不存在 API 密钥。

### 12.4 集成验收

- 可视化创建 → 信号预览 → 保存版本 → 回测 → 查看历史；
- 提示词生成 → 草稿审查 → 修改节点 → 保存 → 回测；
- 导出 DSL → 清空数据库 → 导入 → 得到相同信号；
- 删除策略后历史回测仍可查看；
- 二期内置策略和历史结果无回归。

## 13. 验收标准

- 用户可以不写代码完成一个包含指标、买入、卖出和止损的策略；
- 四个现有内置策略都能用 DSL 等价表达并通过信号比对；
- 画布和规则列表始终映射到同一份 DSL；
- 所有非法引用、循环依赖和未来函数在运行前被阻止；
- 自定义策略能够在现有 Web Worker 中运行并生成可解释信号；
- 刷新浏览器后草稿和正式版本可以恢复；
- 无 OpenAI 密钥时除 AI 生成功能外，其余三期功能完全可用；
- 配置密钥后，提示词能够生成通过 schema 校验的策略草稿；
- AI 输出必须经用户确认，不自动保存、不自动回测；
- 前端构建产物、IndexedDB、日志和 Git 历史中不存在 API 密钥；
- 1 万根日线、30 个规则节点的信号预览目标在 1 秒内完成；
- 自动化测试和生产构建通过，一、二期功能无回归。

## 14. 主要风险

| 风险 | 影响 | 控制措施 |
| --- | --- | --- |
| 画布与执行逻辑不一致 | 策略结果不可解释 | DSL 单一事实来源，画布只编辑 DSL |
| AI 生成未来函数 | 回测失真 | Structured Outputs + offset 语义校验 |
| AI 生成未知指标 | 无法运行 | 将可用指标目录放入请求并在服务端复核 |
| 模型输出被直接执行 | 安全风险 | 禁止任意代码，只接受受限 DSL |
| API 密钥进入前端 | 密钥泄露 | 服务端代理、环境变量和 Git 忽略规则 |
| 复杂规则性能下降 | 页面和回测卡顿 | 依赖拓扑、指标缓存和 Worker 计算 |
| DSL 升级破坏历史策略 | 历史结果不可复现 | schemaVersion、迁移函数和结果快照 |
| AI 结果过度可信 | 用户误用 | 草稿审查、风险提示和强制本地预览 |

## 15. 三期交付物

- Strategy DSL v1、JSON Schema、Zod schema 和迁移框架；
- 可视化策略工作室和响应式规则列表；
- DSL 校验、编译、解释和信号 trace；
- 自定义策略的预览、保存、版本和回测集成；
- Fastify AI 服务接口和 Mock Provider；
- OpenAI Responses API Provider 及 Structured Outputs 接入；
- `.env.example` 和安全配置说明；
- 自动化测试、示例策略和三期用户文档。
