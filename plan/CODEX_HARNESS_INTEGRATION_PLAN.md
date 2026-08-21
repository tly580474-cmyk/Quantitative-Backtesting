# Codex Harness 三阶段接入计划

> 状态：待实施  
> 编制日期：2026-08-21  
> 适用范围：后端 Agent 编排器、Agent API/SSE、智能体前端、运行配置与运维文档  
> 总体策略：短期先跑通，保留现有 Claude 链路；中期完成双 Provider 产品化；长期再建设安全、工具和平台能力。

> 实施前置项（2026-08-21）：已取消前端“生成 HTML 报告”硬开关，改为每轮由智能体输出 `agent-report` 自动决策；Codex Provider 必须复用这一公共语义，不得重新引入 Provider 专用的强制报告布尔值。

## 1. 背景

当前智能体系统已经具备运行记录、会话续接、SSE 事件、超时/取消、报告生成和前端历史展示，但执行层与 Claude CLI 强耦合：

- `AgentOrchestrator` 直接启动 WSL 中的 Claude CLI；
- `outputParser` 只理解 Claude `stream-json`；
- 配置项使用 `AGENT_CLAUDE_PATH`；
- 数据库和前端事件协议已相对通用，可以继续复用。

Codex 官方现已提供 TypeScript SDK、App Server、MCP Server 和 `codex exec`。本项目不直接 fork 或修改 Codex Rust 内核，先把 Codex 作为新的 Agent Provider 接入现有系统；只有 SDK/App Server 无法满足需求时，才考虑维护内核级补丁。

官方参考：

- [Codex SDK](https://developers.openai.com/codex/sdk/)
- [Codex App Server](https://developers.openai.com/codex/app-server/)
- [Codex 非交互模式](https://developers.openai.com/codex/noninteractive/)
- [Codex 开源仓库](https://github.com/openai/codex)

## 2. 总体目标

1. 在不移除 Claude 能力的前提下，让用户可以选择 Codex 执行智能体任务。
2. 复用现有 Agent API、SSE、MySQL、历史记录和报告 UI，避免重做产品外壳。
3. 逐步把执行层从“Claude CLI 专用实现”改造成可扩展 Provider 架构。
4. 中长期接入 Codex 原生 thread、流式事件、审批、sandbox、Skills 和 MCP。
5. 最终让智能体通过受控工具访问行情、回测和研究能力，而不是依赖任意 Shell 与数据库凭据。

## 3. 基本决策

### 3.1 接入顺序

1. 短期使用 `@openai/codex-sdk`，验证启动、续接、结果返回和取消。
2. 中期评估并接入 `codex app-server` 的 stdio JSON-RPC，补齐细粒度流式事件与审批。
3. 长期将量化业务能力封装为 MCP/受控工具，并根据需要引入多智能体编排。

### 3.2 兼容策略

- Claude 继续作为默认或可回退 Provider，短期不删除现有代码。
- API 和前端优先保持兼容；新增字段必须提供默认值。
- Codex 故障不得影响普通行情、回测、数据更新和 Claude Agent。
- Provider 切换采用配置和功能开关，不采用不可逆数据库迁移。

### 3.3 短期安全边界

安全不是短期的主要建设目标，但 MVP 仍保留以下最低边界：

- 只允许服务端调用 SDK，不把认证信息发送到浏览器；
- 不向 Codex 子进程传递数据库、SMTP、管理后台或行情供应商密钥；
- 默认工作目录限定为项目目录；
- 新能力通过功能开关关闭和回退；
- 短期不开放公网远程 App Server、不接实盘交易、不自动执行不可恢复操作。

完整权限模型、审批策略、MCP 隔离和审计放在中长期重点设计。

## 4. 第一阶段：短期——先让 Codex 跑起来

> 建议周期：2～4 个开发日  
> 阶段目标：从现有智能体页面发起一次 Codex 任务，看到最终回答，能够续接和取消；Claude 链路不受影响。

### 4.1 范围

#### A. 建立最薄 Provider 边界

新增执行层接口，但不立即重构所有业务逻辑：

```ts
interface AgentProvider {
  readonly id: 'claude' | 'codex';
  start(params: ProviderStartParams, sink: AgentEventSink): Promise<ProviderRun>;
  cancel(runId: string): Promise<boolean>;
  shutdown(): Promise<void>;
}
```

实现：

- `ClaudeAgentProvider`：包装当前 `spawn + stream-json` 行为；
- `CodexAgentProvider`：使用 `@openai/codex-sdk` 启动或恢复 thread；
- `AgentOrchestrator`：只负责并发、状态机、持久化和事件发布，不再直接拼 Claude 命令。

短期允许 Claude Provider 只做轻量包装，避免一次性大改。

#### B. 接入 Codex SDK

- 在 `server` 安装 `@openai/codex-sdk`；
- 在服务端创建 Codex client；
- 启动新 thread 并保存 thread ID；
- 对已有 thread 调用 resume/continue；
- 将最终回答映射为 `assistant_final`；
- 将成功、失败、取消映射为现有 `terminal`；
- SDK 暂时无法稳定提供的细粒度事件统一映射为少量 `progress`，不在 MVP 阶段模拟虚假工具步骤。

#### C. 最小配置

建议新增：

```dotenv
AGENT_PROVIDER=claude
AGENT_CODEX_ENABLED=false
AGENT_CODEX_MODEL=
AGENT_CODEX_WORKING_DIRECTORY=
AGENT_CODEX_TIMEOUT_MINUTES=60
```

规则：

- `AGENT_PROVIDER` 控制默认 Provider；
- `AGENT_CODEX_ENABLED=false` 时不初始化 Codex；
- 模型为空时使用本机 Codex 配置的默认值，不在代码中写死“最新模型”；
- Codex 初始化失败时后端仍可启动，并在 Agent 健康状态中显示不可用原因。

#### D. API 与前端最小改动

- Agent 创建请求增加可选 `provider`；
- 历史记录显示 `Claude` 或 `Codex` 标签；
- 配置未开启时不显示 Codex 选项；
- 运行界面继续复用现有 SSE、取消按钮和最终回答区域；
- 不在短期重做审批卡片和工具详情。

#### E. 数据兼容

优先复用现有 `session_id` 字段保存 Provider 会话 ID，并为运行记录增加 `provider` 字段；如果现有字段语义无法安全复用，再增加可空的 `provider_thread_id`。

数据库迁移必须满足：

- 旧记录自动视为 `claude`；
- 不修改历史事件内容；
- 回滚应用版本后旧 Claude 路径仍能读取记录。

### 4.2 预计修改文件

```text
server/package.json
server/src/config.ts
server/src/app.ts
server/src/routes/agent.ts
server/src/services/agent/agentOrchestrator.ts
server/src/services/agent/providers/types.ts
server/src/services/agent/providers/claudeAgentProvider.ts
server/src/services/agent/providers/codexAgentProvider.ts
server/src/services/agent/agentRepository.ts
server/src/db/schema.ts
server/src/db/migrations/<next>_agent_provider.sql
src/features/agent/types.ts
src/features/agent/api.ts
src/features/agent/AgentRunner.tsx
```

### 4.3 短期非目标

- 不接入远程 WebSocket App Server；
- 不实现完整命令/文件/网络审批；
- 不实现 Skills、插件、MCP 或多智能体；
- 不让 Codex 直接访问生产数据库；
- 不替换现有报告渲染和校验体系；
- 不删除 Claude CLI、解析器或相关配置；
- 不追求 Claude 与 Codex 中间事件完全一致。

### 4.4 验收标准

- [ ] 后端在 Codex 未安装或未登录时仍能正常启动，Claude 功能不受影响。
- [ ] 开启 Codex 后，可从现有页面完成一次普通问答。
- [ ] 同一 Codex thread 可连续完成至少 3 轮对话。
- [ ] 页面刷新后可加载 Codex 历史，并继续原 thread。
- [ ] 用户取消后，运行进入唯一的 `canceled` 终态。
- [ ] 超时和 SDK 异常进入 `failed`，前端显示可理解原因。
- [ ] Claude 与 Codex 各完成至少一条真实端到端冒烟测试。
- [ ] 前端构建、后端类型检查和 Agent 专项测试通过。

### 4.5 短期完成定义

用户可以在页面选择 Codex，发送任务、收到回答、继续追问、刷新恢复和取消运行；出现问题时切回 Claude 只需修改配置或选择 Provider，不需要回滚数据库。

## 5. 第二阶段：中期——产品化与可靠运行

> 建议周期：1～3 周  
> 阶段目标：把 Codex 从“能运行的实验 Provider”提升为稳定的双 Provider 产品能力，重点补齐事件、审批、测试、可观测性和基础安全。

### 5.1 App Server 事件接入

- 采用本地 stdio 连接 `codex app-server`；
- 实现 JSON-RPC client、initialize、thread/start、turn/start、turn/interrupt；
- 生成并固定当前 Codex 版本对应的 TypeScript/JSON Schema；
- 将 Codex 通知映射到公共事件：

| Codex 事件 | 项目事件 |
| --- | --- |
| `turn/started` | `progress` |
| `item/started` command/tool | `tool_started` |
| `item/completed` command/tool | `tool_finished` |
| agent message delta/final | `assistant_text` / `assistant_final` |
| approval request | `confirmation_required` |
| turn failure/completion | `error` / `terminal` |

- Provider 原始事件只进入受限诊断日志，前端和数据库继续保存脱敏后的公共事件。

### 5.2 Provider 能力模型

增加能力声明，避免用大量 `provider ===` 分支：

```ts
interface AgentProviderCapabilities {
  streaming: boolean;
  resume: boolean;
  approvals: boolean;
  sandbox: boolean;
  skills: boolean;
  mcp: boolean;
}
```

前端根据能力决定是否展示审批、工具详情、模型和沙箱选择。

### 5.3 基础安全与审批

- 默认使用只读或 workspace-write 沙箱，不使用 full-access 作为普通默认值；
- 对命令执行、文件修改和网络访问实现确认流程；
- 审批绑定 `runId + threadId + turnId + itemId`，防止串单；
- 页面刷新后仍能恢复待审批状态；
- 超时审批自动拒绝或取消，策略明确可测试；
- 将 Agent 工作目录与报告输出目录显式列入允许范围；
- 保留现有公共内容脱敏、长度限制与报告静态校验。

### 5.4 可靠性

- App Server 进程崩溃检测与按上限重启；
- 服务重启后回收孤立运行，并恢复可恢复 thread；
- 明确 SDK/App Server/CLI 版本兼容矩阵；
- 启动健康检查：安装、登录、模型可用性、工作目录、协议版本；
- Provider 分别配置并发、超时和熔断；
- 记录首 token 时间、总耗时、工具次数、失败分类和取消原因；
- 不记录内部推理全文、认证令牌或未经清洗的命令输出。

### 5.5 产品能力

- 管理台增加 Provider 健康、版本、并发和最近失败；
- 对话级选择 Provider，新对话默认继承系统配置；
- 禁止在同一原生 thread 中途更换 Provider；需要切换时创建分支对话并复制安全摘要；
- 展示模型、沙箱和 Provider，但不向普通用户暴露底层命令参数；
- 报告继续采用项目现有静态渲染与校验，不直接执行模型生成的脚本。

### 5.6 测试

- Provider 合同测试，同一套用例运行在 Claude/Codex fake provider 上；
- App Server JSON-RPC fixture 与协议升级测试；
- 启动、续接、取消、超时、审批、拒绝、崩溃恢复测试；
- SSE 重连、历史重放和事件去重测试；
- 两个 Provider 的真实环境 smoke test，但不要求在普通单元测试中联网；
- 前端 Provider 切换和审批卡片 UI 测试。

### 5.7 中期验收标准

- [ ] Codex 工具开始/完成、文本和终态可以实时展示。
- [ ] 命令和文件修改审批可在现有页面完成。
- [ ] 服务或 App Server 异常不会产生永久 `running` 记录。
- [ ] 两个 Provider 均通过统一合同测试和连续 20 轮稳定性测试。
- [ ] 管理台可以区分认证、协议、模型、超时和执行错误。
- [ ] Codex 默认权限不高于完成任务所需范围。
- [ ] 版本升级时 Schema 漂移能被 CI 检测。

### 5.8 中期完成定义

Codex 可以作为正式功能开启，拥有可靠的流式体验、审批、恢复、监控和测试；Claude 与 Codex 共用产品协议，但各自保留独立实现和故障边界。

## 6. 第三阶段：长期——量化智能体平台化

> 建议周期：1～3 个月，按业务价值拆分迭代  
> 阶段目标：从“通用代码智能体接入”升级为有明确权限、工具协议、审计和评测的量化研究智能体平台。

### 6.1 受控量化工具层

优先把以下能力封装为 MCP Server 或项目内部结构化工具：

- 查询证券主表与交易日历；
- 查询日 K、分钟湖、财务、资金流和研究快照；
- 运行数据覆盖率与健康检查；
- 创建并运行回测；
- 查询因子目录、启动因子研究、读取研究结果；
- 生成静态研究报告；
- 查看数据更新任务；
- 在显式审批后触发限定的数据更新或修复任务。

原则：

- 工具参数使用 Zod/JSON Schema 校验；
- 查询默认只读并限制行数、日期跨度和超时；
- 写操作幂等、可审计、可取消；
- Agent 不直接读取 `.env`，也不持有数据库管理员凭据；
- 工具返回业务摘要和资源引用，不返回无限量原始数据。

### 6.2 权限与隔离体系

- 区分只读研究、代码修改、数据维护和模拟交易四类角色；
- 每个工具定义风险等级、审批要求和允许环境；
- 使用专用只读数据库账号和独立 Agent 工作目录；
- 长任务使用隔离 worktree 或临时工作区；
- 网络按目标域名和协议授权；
- 高风险文件修改必须提供 diff 并经确认；
- 实盘交易继续作为非目标，除非未来单独立项和审计。

### 6.3 多智能体与任务编排

在单 Agent 和工具体系稳定后，再考虑：

- 数据质量 Agent；
- 因子研究 Agent；
- 回测审查 Agent；
- 报告生成 Agent；
- 代码审查/维护 Agent；
- 主编排器负责拆分任务、预算、并发和汇总。

若 Codex 只是更大工作流中的代码专家，可按官方建议将 Codex MCP Server 交给 Agents SDK 编排；不要在项目内重复实现一套无边界的递归 Agent 系统。

### 6.4 审计、成本与治理

- 记录谁在何时请求了什么任务、使用了哪些工具和产生了哪些变更；
- 保留结构化工具输入、结果摘要、审批与产物指纹；
- 统计 token/用量、执行时间、失败率和每类任务成本；
- 设置线程、轮次、工具调用、网络、查询行数和总时长预算；
- 支持按 Provider、模型、任务类别和版本回放评测；
- 建立数据泄露、提示词注入、越权工具和错误投资结论专项测试。

### 6.5 评测体系

建立量化项目专用离线评测集：

- 行情与财务事实准确性；
- 时间点约束与未来函数识别；
- 回测参数和结果复现；
- 数据缺失时是否明确降级；
- 是否把相关性误报为因果关系；
- 是否遵守只读/写入权限；
- 报告引用的数据版本和快照是否正确；
- Claude/Codex/模型版本之间的质量、延迟和成本对比。

模型或 Harness 升级必须先通过回归评测，再逐步放量。

### 6.6 长期验收标准

- [ ] Agent 的主要量化操作通过结构化工具完成，而不是任意 Shell/SQL。
- [ ] 所有写操作均有身份、审批、参数、结果和产物审计。
- [ ] 研究结论可追溯到数据日期、快照、工具调用和代码版本。
- [ ] Provider 或模型升级有离线评测、灰度和回滚流程。
- [ ] 单个 Agent 或工具故障不会影响主站和数据管线。
- [ ] 多智能体只在可量化收益明确时启用，并有预算与递归深度限制。

### 6.7 长期完成定义

Codex 不再只是嵌入页面的通用聊天执行器，而是量化研究平台中的受控代码与分析专家；业务数据、工具、权限、审计和评测由本项目掌控，模型与 Harness 可以替换或升级。

## 7. 阶段门禁与推进规则

| 阶段 | 进入条件 | 退出条件 | 回退方式 |
| --- | --- | --- | --- |
| 短期 | Codex CLI/SDK 可安装并完成登录 | 真实三轮对话、恢复、取消通过 | 关闭 `AGENT_CODEX_ENABLED`，继续使用 Claude |
| 中期 | 短期 MVP 稳定，公共事件协议不需大改 | 流式、审批、恢复、监控和合同测试通过 | Provider 级熔断并回退 Claude |
| 长期 | 工具需求和权限边界已明确 | 工具、审计、评测和治理门禁通过 | 禁用对应 MCP/写工具，不影响普通 Agent |

推进规则：

1. 不因长期架构尚未完成而阻塞短期 MVP。
2. 不以“先跑起来”为由删除现有脱敏、凭据隔离和终态可靠性措施。
3. 短期产生的临时代码必须集中在 Provider 适配层，不把 Codex 分支散布到业务代码。
4. 每阶段结束后更新本计划、`CLAUDE.md`、系统设计和运维手册。
5. 下一阶段开始前，用真实运行数据复核上一阶段的主要假设。

## 8. 建议实施顺序

短期首个迭代按以下顺序执行：

1. 新增配置和 Codex SDK 依赖；
2. 写 Codex 本地连通性/登录探针；
3. 建立 Provider 接口和 Codex Provider；
4. 让 Orchestrator 支持选择 Provider；
5. 持久化 Provider 与 thread ID；
6. 接通现有 API/SSE；
7. 前端增加 Provider 选择和标签；
8. 补单元测试与 fake provider 集成测试；
9. 完成 Claude/Codex 双链路真实冒烟；
10. 更新 `CLAUDE.md` 和 Agent 运维文档。

短期不应先做 App Server WebSocket、MCP、多智能体、复杂审批 UI 或完整安全重构；这些工作不能阻塞第一条 Codex 端到端链路。
