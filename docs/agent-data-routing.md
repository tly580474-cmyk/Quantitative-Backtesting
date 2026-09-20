# 智能体研究入口与工具详情

普通研究报告由主代理直接生成一次 Markdown 正文，聊天与下载附件共用，后端完成静态排版。Claude 的 report-designer 保留为用户明确要求深度编辑时的可选工具，不再因 generate=true 强制调用。

## 运行耗时与失败统计

新运行的终态事件在 `terminal.metrics` 保存去重工具数、失败分类、未完成调用数、工具区间并集、按工具参数归类的阶段耗时、报告渲染及保存耗时、实际模型和 Provider 上报用量。统计复用已有 `terminal_json`，无需数据库迁移。历史任务没有指标时保持缺失，不补造耗时。

`firstValidDataMs` 只接受 `kind=research-data, ok=true, usable=true` 的非空数据结果；这不保证覆盖完整或满足全部任务条件。该标记在显示截断前提取。普通退出码 0 仅记为 `firstSuccessfulDataToolMs`，不能证明取到了所需数据。`providerApiMs` 保存 Claude 终态上报的 API 累计耗时；不支持此字段的 Provider 保持 null，不推算逐请求耗时。`unattributedMs` 包含模型生成、请求等待和编排开销，不等于纯思考时间；阶段工具时间可能重叠。用量为 Provider 自报，`provider_total` 可能是续接会话累计值，`observed_messages` 仅覆盖当前观测到的消息，不可直接当作计费依据。

工具输出在截断前检查明确的运行时错误。被管道掩盖的失败保留原退出码，并在事件中标注 `output_signature`，而不是伪造非零退出码；读取源码和普通错误说明不作为执行失败。实际调用应直接使用项目入口，避免 `| head/tail` 掩盖退出状态。

Claude 与 Codex 共用 `agentDataCatalog.ts` 中的数据目录与选择规则。单股报价、资讯走项目行情 API；全市场历史统计走 DuckDB；批量日内研究走分钟入口。外部补缺仍受各 Provider 已有配置约束。

项目根目录可以执行：

```text
node server/scripts/researchData.mjs fund-flows --end 2026-09-18 --days 5 --top 5
node server/scripts/researchData.mjs fund-flows --end 2026-09-18 --days 5 --group industry
node server/scripts/researchData.mjs fund-flows --days 1 --symbol 600000
node server/scripts/researchData.mjs query --sql "SELECT symbol, tradeDate, adjustedClose FROM stock_prices_qfq LIMIT 5"
node server/scripts/researchData.mjs query --file tmp_output/query.sql
node server/scripts/researchData.mjs catalog --task cross-sectional
node server/scripts/researchData.mjs describe daily_bars
node server/scripts/researchData.mjs coverage financials --start 2020-01-01 --end 2026-09-04
node server/scripts/researchData.mjs doctor daily_bars
```

资金流由项目 CLI 内部的参数化 SELECT 读取 `stock_fund_flows`，事务为只读，不触发采集或更新。窗口按 SH 交易日历选取，缺失日期保留为 null 而非补零或向前凑齐；金额为亿元。逐日返回实际样本数、同期本地日线参照数、非最终记录数、来源，以及正流入和负流出排名。`available` 不保证全市场完整覆盖。行业聚合使用查询时 `instruments.industry`，并非历史时点分类或官方板块资金流。

统一 `query` 入口固定在 server 工作目录执行，`--file/--params-file` 路径相对项目根目录；返回总行数及最多50行样例，`truncated=true` 时不能将样例当全量。大结果用原 DuckDB CLI 的 `--out` 导出。`snapshotIdObservedAfterQuery` 仅为查询完成后观察到的快照指针，不作为查询使用快照的锁定证明；要求严格可追溯时使用带 manifest 的 DuckDB 导出。

目录中的 `index_valuations` 显式标记当前没有统一官方历史指数估值入口；个股估值不能默认替代官方指数估值。查询缺少 `--sql/--file` 时立即报错；原 DuckDB 的行情预览通过 `preview --view bars` 显式执行。

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
