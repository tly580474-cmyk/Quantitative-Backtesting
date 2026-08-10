# 智能体系统运维手册

> 版本：v2
> 更新日期：2026-08-10

> 当前执行策略：默认工作目录为项目的 `tmp_output`，Claude Code 使用 `--dangerously-skip-permissions`。该参数允许工具免确认执行，但不会在操作系统层面阻止绝对路径或 `..` 越界；需要硬隔离时应使用容器、专用 WSL 用户或挂载命名空间。

## 1. 快速健康检查

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/agent/metrics
Invoke-RestMethod 'http://127.0.0.1:3001/api/agent/conversations?limit=5'
```

重点检查：`runtime.active <= runtime.capacity`；数据库中没有长期停留的 `starting/running`；最新 run 的 seq 连续且只有一个 terminal。

若普通 API 可用但界面一直显示“连接中”，检查 SSE 响应是否同时包含 `X-Agent-Event-Protocol: agent-events-v2` 和与页面来源一致的 `Access-Control-Allow-Origin`。本地页面使用 `127.0.0.1`、API 使用 `localhost` 时仍属于跨域，原始 SSE 响应必须显式返回 loopback CORS 头。

```sql
SELECT id, conversation_id, turn_index, status, error_code, created_at, finished_at
FROM agent_runs ORDER BY created_at DESC LIMIT 20;

SELECT run_id, MIN(seq), MAX(seq), COUNT(*), COUNT(DISTINCT seq)
FROM agent_events GROUP BY run_id
HAVING COUNT(*) <> COUNT(DISTINCT seq);
```

## 2. 暂停智能体

1. 在管理配置中把 `AGENT_ENABLED=false`。
2. 通过受监督的管理端重启后端；不要直接终止单个 node 子进程。
3. 确认 `/api/agent/metrics` 的 `runtime.active` 为 0。

服务优雅关闭会把活动任务转为 canceled 并终止 WSL 包装进程树。非计划故障重启后，初始化流程会把遗留状态写为 `failed/SERVER_RESTART`。

## 3. 诊断常见故障

### 历史对话加载失败

- 检查 `0039_agent_reliability_v2.sql` 是否存在于 `_migrations`。
- 检查 `idx_ar_conversation_turn`、`idx_ae_run_seq`。
- 直接请求 conversations 和 turns 接口；500 时查看后端日志中的 MySQL 错误码。
- 确认调用来自本机；非回环地址会返回 403。

### SSE 不更新或重复

- 浏览器网络面板确认响应头 `X-Agent-Event-Protocol: agent-events-v2`。
- 重连 URL 应带 `lastEventId`；服务端只返回更大 seq。
- 对照数据库 `MAX(seq)` 与页面最后 seq。
- terminal 后连接必须结束；若仍重连，检查前端是否收到 terminal payload。

### 无法继续对话

- 最新 run 必须已终态且具有 `session_id`。
- 核对同一对话 `turn_index` 是否从 0 连续递增。
- failed run 可以继续；缺失 session 时返回 409，不应创建伪续接。

### Agent 启动失败

- 查看 run 的 `error_code`：`STARTUP_ERROR`、`SPAWN_ERROR`、`PROCESS_EXIT`、`TIMEOUT`。
- 在 WSL 中确认配置的 Claude CLI 路径可执行。
- 不要恢复 `--dangerously-skip-permissions`。
- 若权限规则阻止合法数据查询，应增加受控数据命令，不要开放 `.env` 或把后端环境传给子进程。

### 报告未出现

- 普通对话默认不生成报告，先确认本轮显式启用了报告。
- 检查 HTML 是否超过 10 MiB，或包含 script、外链、表单、iframe、事件属性等主动内容。
- 校验数据库 `html_path` 必须等于报告根目录下的 `${runId}.html`。

## 4. 清理孤立进程与状态

优先重启受监督后端，让 `shutdown()` 和启动恢复流程自动处理。只有确认后端已停止且某个 PID 属于目标 run 后，才手动终止：

```powershell
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'wsl.exe' } |
  Select-Object ProcessId, ParentProcessId, CommandLine
```

不要按名称批量结束所有 WSL 或 node 进程。手工修复数据库前先备份；终态必须配套一条 terminal 事件，不能只改 status。

## 5. 备份与恢复

创建并验证备份：

```powershell
Set-Location server
npm run backup:create
npm run backup:verify -- --backup-id <backup-id>
```

本次迁移前备份：`backup-20260810071008`。恢复前停止后端和写入任务，先执行项目的 restore-check，再按备份工具输出的明确目标恢复；不要直接覆盖正在使用的数据库。

旧 `thought` 数据只在备份和旧表中保留，API 默认隐藏。未经单独审核，不得批量删除旧推理事件。

## 6. 发布检查清单

- 服务端 typecheck、服务端全量测试、前端全量测试、前端 build 全部通过。
- 完成、失败、取消、超时和启动失败都有唯一 terminal。
- 五轮续接、刷新恢复、Last-Event-ID 重放和取消竞态通过。
- API/DOM 不出现 `thought`、原始工具输入结果、测试凭据或绝对路径。
- 恶意报告测试被拒绝或在 sandbox/CSP 下失效。
- `runtime.active` 归零，数据库没有孤立状态或重复 seq。
