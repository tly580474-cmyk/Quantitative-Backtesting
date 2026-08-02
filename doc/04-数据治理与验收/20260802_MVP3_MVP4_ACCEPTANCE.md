# MVP 3 + MVP 4 收尾验收报告

> 验收日期：2026-08-02
> 验收范围：MVP 3（Backtrader 事件引擎、ML 模型）与 MVP 4（假设生成 Agent、智能报错映射）收尾，以及 N5 集成验收
> 总结论：**MVP 3 / MVP 4 收尾全量通过**

## 1. 结论摘要

| 工作包 | 结论 | 说明 |
| --- | --- | --- |
| N1 Backtrader 事件策略适配 | 通过 | 黄金样例一致性锁定 `dual_ma`，事件驱动撮合与 TS 口径对齐，结果仅作筛选层（ADR-05） |
| N2 自定义机器学习模型 | 通过 | sklearn ridge 白名单 worker 接入 E3 多因子桥，时点化训练、产物可复现、稳健性门禁落地 |
| N3 假设生成 Agent | 通过 | LLM 生成 + 能力边界校验 + 实验规格映射 + backtrader 批量评估 + 假设管理 UI |
| N4 智能报错映射与重提 | 通过 | 九类确定性错误码 + 中文解释 Agent + 建议点选重提闭环（ADR-11 口径，不改策略 JSON） |
| N5 集成验收 | 通过 | 端到端冒烟、黄金样例矩阵扩充、对抗与安全测试补齐、能力清单自动发布 |

因此，本次可签署的产品状态是：

> **MVP 3（高级 Python 实验室）与 MVP 4（研究 Agent 闭环）缺失的 4 项能力全部完成，并已通过集成验收。**

## 2. 验收环境

- 操作系统：Windows；
- 前端：React、TypeScript、Vite；
- 服务端：Fastify、TypeScript、MySQL；
- 计算平面：DuckDB、Backtrader Python worker、sklearn Python worker；
- 隔离平面：Docker Desktop + WSL2（`quant-sandbox:dev` 镜像）；
- AI 状态：OpenAI 兼容端点（DeepSeek）已配置；无 key 时使用确定性 Mock 替代；
- 能力接口：19 个可视指标、42 个已发布因子版本、事件引擎白名单 `dual_ma`（黄金样例锁定）。

## 3. 自动化总体验收

| 项目 | 结果 |
| --- | --- |
| 服务端全量测试（server 目录） | 122 个测试文件全部通过（含 Docker 沙箱 7 项、Chromium PDF 1 项） |
| 前端测试（根目录） | 前端全部通过（根目录全量下 server 目录依赖外部 worker 相对路径/Docker 的用例需在 server 目录运行，属运行方式约束） |
| 服务端类型检查 | `tsc --noEmit` 通过 |
| 前端类型检查 | `tsc -b --force` 通过 |
| 能力清单检查 | `capabilities:check` 通过；N5.4 起事件引擎策略按"已验收才发布"过滤 |
| N1–N5 专项测试 | 事件引擎 5、ML 稳健性 13、假设 15、错误分类 10、端到端冒烟 4、对抗沙箱 7 全部通过 |

## 4. N1 验收：Backtrader 事件策略适配

### 已验证

- 先行黄金样例一致性：`dual_ma` 在相同输入、相同信号、相同费用下与 TS 引擎订单/权益差异在容差内（`backtraderGoldenParity` + `eventEngineRuntime` 双处锁定）；
- 事件驱动订单生命周期覆盖 next_open 成交、佣金/印花税/滑点、整手等撮合口径；
- 白名单策略注册表（`EVENT_STRATEGY_REGISTRY`）参数经 Zod 校验，新增策略必须先注册并补充黄金样例；
- 事件引擎结果带 `authority: screening_only` 与 `publishable: false`，必须经权威复算后才能进入门禁（ADR-05）；
- 假设评估运行使用 `runtime: 'backend_event_engine'`，不改变现有浏览器执行语义。

### 结论

N1 通过。

## 5. N2 验收：自定义机器学习模型

### 已验证

- 训练数据导出为时点化（决策日已知数据），`shiftTrainedThroughDate` 锚定决策日并拒绝重叠；
- `MLModelSpec` 固定特征清单、预处理、训练/验证切分与种子，产物含依赖锁定；
- sklearn ridge 白名单 worker 接入，不走任意代码执行路径（M5 沙箱 C 档）；
- 模型输出经 `modelScoreBridge` 转为标准因子向量进入现有 multi-factor 协议（复用 E3）；
- N2.5 稳健性门禁：窗口/种子/特征扰动，排名翻转与不相关直接判失败，真实 worker 冒烟通过。

### 结论

N2 通过。

## 6. N3 验收：假设生成 Agent

### 已验证

- 假设协议 `protocolVersion 1.0` + 状态机 draft → evaluated/rejected；
- LLM 生成逐条校验：strategyType 必须在事件引擎白名单内、params 通过参数 Schema，非法条目拒绝并返回原因（防幻觉/防越界）；
- 假设不直接运行：全部经 `hypothesisToStrategyDocument` 映射为 StrategyDocument，构造 confirm 请求（五项假设自动确认）后才进入 M2 幂等流程；
- 批量评估编排：confirm（specHash 幂等）→ create run（idempotencyKey = `hypothesis:{id}:{datasetHash}`）→ backtrader 事件引擎 → 保存结果 → complete（结果哈希校验）→ M3 校验 → 状态更新；
- 假设管理 UI：生成/列表/评估/否决，状态 Tag 与实验版本关联追踪；
- `strategyHypotheses` 表迁移（0044）与 4 个 `HYPOTHESIS_*` 错误码落地。

### 结论

N3 通过。

## 7. N4 验收：智能报错映射与用户重提流程

### 已验证

- 九类确定性错误码（SCHEMA_INVALID/SEMANTIC_CONFLICT/UNSUPPORTED_CAPABILITY/COMPILE_FAILED/DATA_MISSING/DATA_QUALITY_FAILED/RESOURCE_EXCEEDED/RUNTIME_FAILED/VALIDATION_FAILED + INTERNAL_ERROR）由组件直接产生，不靠 LLM 猜测；
- 生成失败返回结构化载荷：类别、中文标签、字段路径、issue 列表、可重试标志；
- 中文解释 Agent（`errorInterpreter`）：基于结构化错误 + 能力清单生成可点选修正建议；SYSTEM_PROMPT 硬性约束只解释、不返回策略 JSON/补丁（ADR-11）；
- 确定性兜底：LLM 失败或未配置时回退 `fallbackInterpretation`（SCHEMA_INVALID 建议修正字段、VALIDATION_FAILED 说明不可重试等）；
- 前端重提闭环：错误 Alert 展示类别 Tag + 涉及字段 + "智能解释与修正建议"→ 点选建议预填 prompt → 自动重新生成；`handleModeChange` 清空旧解释；
- 提示词注入防御测试：要求输出代码/读取文件/忽略 Schema 的注入均被拒绝。

### 结论

N4 通过。

## 8. N5 验收：集成收尾

### 8.1 端到端全链路冒烟

固定自然语言输入 → 假设 Agent（能力边界校验）→ 实验规格（确认请求）→ 事件引擎（筛选层）→ M2 门禁（complete hash 校验）→ 报告摘要，全链路在单一确定性测试中串联验证（`hypothesisEndToEndSmoke.test.ts`，4 项）。

### 8.2 黄金样例矩阵扩充

- Backtrader：`dual_ma` 与 TS 引擎双处黄金样例锁定；
- ML 模型：真实 sklearn ridge worker 冒烟 + 稳健性扰动门禁；
- 假设驱动实验：固定输入（自然语言 prompt + 固定数据集）→ 固定 plan 参数（fast=5/slow=20）→ 固定幂等键与报告摘要的 golden sample 断言。

### 8.3 对抗与安全测试（设计文档 17.3 覆盖矩阵）

| 对抗场景 | 覆盖 |
| --- | --- |
| 提示词注入（要求代码/读文件/忽略 Schema） | `errorInterpreter.test.ts` ✓ |
| Repair 越权修改（新增条件/改字段/编造默认值） | `repairMiddleware.test.ts` ✓ |
| 超大 JSON、越界 count/prompt | 假设 schema 边界拒绝 ✓（新增） |
| Python 读宿主目录 | 沙箱 `can_read: false` ✓ |
| Python 读宿主环境变量 | 沙箱隔离验证 ✓（新增） |
| Python 网络访问 | `--network=none` DNS 失败 ✓（新增） |
| fork bomb | pids limit 拒绝 ✓ |
| 无限循环 | 墙钟超时 SIGKILL ✓（新增） |
| 伪造 Worker 完成清单/checksum/artifact | `artifactStore` ARTIFACT_HASH_MISMATCH、M5 SIGNAL_HASH_MISMATCH ✓ |
| 伪造 RebalancePlan（snapshot/universe/hash/权重） | `multiAsset` tampered plan 拒绝 ✓ |
| 并发锁定测试与并发审批 | `atomicGate` 唯一获胜者 ✓ |
| 伪造能力版本/越界策略 | 能力边界拒绝 + capabilityVersion 服务端固定 ✓（新增） |

### 8.4 能力清单自动发布（沿用 E7 模式）

- 事件引擎注册表新增"已发布目录"：只有 `goldenParityLocked === true` 的策略才向 Agent 与 UI 暴露（`listPublishedEventStrategyCatalog` / `PUBLISHED_EVENT_STRATEGY_IDS`）；
- 假设生成的 `capabilityVersion` 由服务端常量 `mvp4-event-engine-v1` 决定，LLM 伪造的 capabilityVersion 被忽略；
- 新增策略必须通过黄金样例验收后才能进入能力清单（未验收不发布）。

### 结论

N5 通过。完成定义最后一项已满足：MVP 3 / MVP 4 全链路集成验收通过，能力清单自动发布。

## 9. UI 验收

- 假设管理页（`/hypotheses`）：生成、列表、状态 Tag（draft/evaluated/rejected）、评估与否决操作可用；
- AI 生成抽屉：生成失败时展示错误类别 Tag、涉及字段与"智能解释与修正建议"，点选建议自动重提；
- 多资产 / 因子研究 / 结果页沿用既有验收结论，无新增渲染阻断。

## 10. 遗留项与放行条件

- 根目录 `npm test` 会把 `server/` 下依赖外部 worker 相对路径/Docker 的用例一并纳入（运行方式约束）；服务端测试应在 `server/` 目录运行，前后端测试命令口径以各自 `package.json` 为准。此约束不影响功能验收，建议后续在根目录 vitest 配置中排除 `server/**`；
- 超大 stdout / 压缩炸弹依赖沙箱内存上限（256m）与进程数上限（16）机制约束，未做 Docker 实弹用例（行为不可确定）；
- M1 实际解析器离线质量统计（precision/recall/F1 等）仍为 M0–M4 验收遗留，不在本次范围。

## 11. 最终签署意见

MVP 3（Backtrader 事件引擎、ML 模型）与 MVP 4（假设生成 Agent、智能报错映射）四项缺失能力
已全部完成，并通过集成验收：端到端冒烟、黄金样例矩阵、对抗与安全测试、能力清单自动发布
均达成。项目状态更新为 **MVP 1–MVP 4 全部完成**；后续新增资产、策略、模型或数据字段仍须
单独走能力清单生成、黄金样例与生产冒烟，不能沿用本次结论自动放行。
