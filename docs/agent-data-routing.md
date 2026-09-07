# 智能体研究入口与工具详情

Claude 与 Codex 共用 `agentDataCatalog.ts` 中的数据目录与选择规则。单股报价、资讯走项目行情 API；全市场历史统计走 DuckDB；批量日内研究走分钟入口。外部补缺仍受各 Provider 已有配置约束。

项目根目录可以执行：

```text
node server/scripts/researchData.mjs catalog --task cross-sectional
node server/scripts/researchData.mjs describe daily_bars
node server/scripts/researchData.mjs coverage financials --start 2020-01-01 --end 2026-09-04
node server/scripts/researchData.mjs doctor daily_bars
```

`catalog` 只读静态目录，不联网或扫描行情。`describe` 为研究视图读取当前实际 schema。`coverage` 为快照数据读取该数据集 manifest；总体边界不证明逐股票覆盖、字段非空或连续性。估值视图由日线派生；财报与分红 manifest 的日期为报告期，事件日期覆盖返回 unknown。分钟覆盖由项目分钟目录返回；市场/新闻 doctor 的 health 只检查后端，不代表每个上游可用。执行查询继续复用原有 CLI，目录命令不发布或更新数据。

两个 Provider 的工具输入与输出经脱敏、截断后，保存到已有 `agent_events.tool_input/tool_result` 字段；无需数据库迁移。实时流和历史接口使用相同字段。前端按 runId + toolUseId 合并生命周期，点击“查看调用详情”展开命令、参数和输出。失败调用也合并并保留错误与耗时。详情最多每字段 12,000 字符，展开前不渲染正文，不提供未脱敏原始输出下载。旧记录没有保存的详情无法补回。

续接时从当前会话、父回合及之前的最近 80 条工具事件中，提取最多 4 次数据调用作为历史证据重新注入。它保留调用参数、结果摘要及失败状态；不代替完整实验产物或数据时效检查，不自动重跑失败研究。完整 Provider 会话续接仍保留。

验证包括两端类型检查、Provider 输入输出映射、凭据脱敏与大输出性能、存储、历史续接和前端展开/合并测试。本地快照入口另做只读 smoke test。实际模型端到端提速需在同样问题、模型和数据快照下比较首次有效取数、失败调用次数与总耗时，不能由单元测试推断。

应用变更需要重新构建并重启项目服务；新工具详情从更新后的调用开始保存。

## Codex 历史详情恢复

若旧回合的事件缺少详情，但项目独立 `AGENT_CODEX_HOME/sessions` 仍保留对应日志，可在 server 目录执行：

```text
npx tsx scripts/repairCodexToolDetails.ts <runId>
npx tsx scripts/repairCodexToolDetails.ts <runId> --apply
```

默认仅预检。恢复程序校验目标已结束、Provider 为 Codex、日志 sessionId 一致，并按调用 ID 匹配。只填充缺失字段，先脱敏，不复制推理或会话元数据，不修改已有详情或研究结论。没有日志的历史详情仍无法恢复。
