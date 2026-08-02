# M4 多资产 Agent 生产运维手册

> 适用范围：M4 v1（沪深 300、已发布 `momentum_20`、周/月调仓、等权/评分加权、TypeScript 权威撮合）  
> 不包含：多租户、外部消息中间件、任意 Python 策略或全市场扩容。

## 1. 生产部署建议

生产环境建议将 API 与 Worker 分进程部署，二者共享 MySQL、只读研究快照和多资产制品目录：

```text
Web/API (MULTI_ASSET_EMBEDDED_WORKER=false)
                 │ 写入持久队列
                 ▼
              MySQL
                 ▲ 租约领取、心跳、事件、制品清单
                 │
Standalone Worker (可按容量部署多个)
                 │
        只读快照 + 制品目录
```

单机开发可以保留 `MULTI_ASSET_EMBEDDED_WORKER=true`。生产环境切换为独立 Worker 后，不要同时让 API 内嵌 Worker 参与消费，除非容量规划明确要求混合模式。

启动顺序：

```powershell
cd server
npm run db:migrate
$env:MULTI_ASSET_EMBEDDED_WORKER='false'
npm run start

# 在另一个受进程管理器监督的进程中
npm run multi-asset:worker
```

## 2. 必备配置

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `MULTI_ASSET_EMBEDDED_WORKER` | `true` | API 是否内嵌消费任务 |
| `MULTI_ASSET_WORKER_CONCURRENCY` | `2` | 每个 Worker 最大并发 |
| `MULTI_ASSET_POLL_INTERVAL_MS` | `1000` | 持久队列轮询间隔 |
| `MULTI_ASSET_WORKER_HEARTBEAT_MS` | `10000` | Worker 注册心跳间隔 |
| `MULTI_ASSET_WORKER_STALE_MS` | `45000` | 超过该时间视为失联 |
| `MULTI_ASSET_SHUTDOWN_GRACE_MS` | `30000` | 优雅停机排空期限 |
| `MULTI_ASSET_ARTIFACT_RETENTION_DAYS` | `30` | 终态运行制品保留天数 |
| `MULTI_ASSET_QUEUE_WARNING_SECONDS` | `60` | 最老等待任务告警阈值 |
| `MULTI_ASSET_QUEUE_CRITICAL_SECONDS` | `300` | 最老等待任务严重告警阈值 |

配置由 `server/src/config.ts` 统一校验。改动并发、心跳、停机或内嵌模式后必须重启相应进程。

## 3. 健康检查与告警

公开健康接口只返回脱敏摘要：

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/health
```

详细状态必须使用管理令牌：

```powershell
$headers = @{ Authorization = "Bearer $env:ADMIN_API_TOKEN" }
Invoke-RestMethod http://127.0.0.1:3001/api/admin/multi-asset/status -Headers $headers
```

也可在服务器本地执行：

```powershell
cd server
npm run multi-asset:status
```

本地状态命令退出码：`0=healthy`、`1=warning`、`2=critical`，可直接接入任务计划或监控采集器。应对以下告警建立即时通知：

- `EXPIRED_RUNNING_LEASES`：运行任务租约已过期但尚未恢复；
- `STALE_WORKERS`：Worker 心跳超时；
- `NO_ACTIVE_WORKER`：队列有任务但没有存活 Worker；
- `QUEUE_WAIT_WARNING/CRITICAL`：排队时间超过阈值。

## 4. 优雅停机和故障恢复

收到 `SIGINT`/`SIGTERM` 后，API/Worker 会按顺序：停止轮询与接单 → 标记 `draining` → 等待在途任务 → 标记 `stopped` → 关闭数据库连接。宽限期耗尽不会强行伪造任务成功；原任务保留 `running` 租约，租约到期后由新实例恢复为 `queued`。

事故恢复步骤：

1. 查看 `/api/admin/multi-asset/status`，确认 Worker 和租约状态；
2. 启动至少一个 Worker；
3. 等待过期租约被 `recoverAndListQueuedMultiAssetRuns` 恢复；
4. 对 `dead_letter` 任务先查 `errorCode/errorMessage` 和事件流，再通过重试 API 人工重试；
5. 不要直接修改运行状态字段或删除事件审计记录。

## 5. 制品完整性与清理

制品采用临时文件写入后原子重命名，并在数据库保存路径、字节数和 SHA-256。下载时重新校验路径边界、大小与哈希；缺失或被篡改时返回 `410`，不会继续下发文件。

清理命令默认只预演：

```powershell
cd server
npm run multi-asset:artifacts:prune

# 审核 JSON 报告后才执行
npm run multi-asset:artifacts:prune -- --apply
```

清理只选择已完成、失败、死信或取消且超过保留期的任务制品；运行记录与事件审计仍保留。命令使用 MySQL advisory lock，多个实例同时执行时只有一个能够进入清理临界区。

## 6. 容量与分页

- 并发按 `Worker 数 × MULTI_ASSET_WORKER_CONCURRENCY` 计算；先观察 CPU、DuckDB 临时空间和快照读取吞吐，再扩容。
- 计划和运行列表支持 `limit`、`offset`；响应体继续保持数组兼容现有 UI，总量位于 `X-Total-Count`，窗口位于 `X-Limit/X-Offset`。
- 运行事件 SSE 支持断点 `afterId`，服务端发送 `retry: 3000`；任务进入终态或连接达到 30 分钟后主动结束，客户端按最后事件 ID 重连。

## 7. 备份与恢复边界

灾备必须同时覆盖：

1. MySQL：计划、运行、租约、事件、Worker 注册和制品清单；
2. 研究快照目录：保证计划绑定的 `snapshotId` 可重放；
3. 多资产制品目录：保证清单中的哈希文件可读取。

恢复后先执行数据库迁移，再抽样下载制品校验哈希，最后启动 Worker。数据库与制品目录应来自同一备份时间窗；仅恢复其中一侧会产生 `410` 完整性错误。

## 8. 发布验收清单

```powershell
cd server
npm run typecheck
npx vitest run src/multiAsset
npm run build
npm run db:migrate
npm run multi-asset:status
npm run multi-asset:production-smoke
npm run multi-asset:artifacts:prune
```

发布前还必须人工确认：管理接口需要令牌；API 与 Worker 的内嵌模式符合部署拓扑；dry-run 未命中保留期内制品；停止一个 Worker 后在宽限期或租约恢复窗口内任务没有丢失。故障注入未实际跑通前，不得把对应生产演练标记为完成。

## 9. 2026-08-02 生产演练命令

### 双 Worker 与滚动停机

```powershell
./scripts/m4-linux-supervisor-drill.ps1
```

脚本在 WSL2/systemd 中启动两个独立 Worker，验证注册、心跳和总容量，再分别发送
SIGTERM。验收条件是两个 Worker 均经历 `draining -> stopped`，终态任务数不变且队列
没有遗留等待任务。Worker 的轮询和心跳在关闭连接池前必须全部收敛。

### 数据库、快照和制品联合备份

```powershell
cd server
npm run backup:create -- --root <backup-root> --id <backup-id>
npm run backup:verify -- --path <backup-path>
npm run backup:restore-check -- --path <backup-path> `
  --database <isolated-test-db> --confirm-drop <isolated-test-db> --cleanup true
```

备份 manifest v2 同时记录 MySQL dump、研究快照和多资产制品的相对路径、字节数与
SHA-256。`restore-check` 只允许隔离测试库，恢复时重绑定测试库中的制品根目录并逐个
校验；`--cleanup true` 在验证后删除测试库和隔离副本，不删除正式备份。

### 告警与监控任务

`MULTI_ASSET_ALERT_WEBHOOK_URL` 配置 HTTPS webhook；仅回环地址允许 HTTP 演练。
可选 `MULTI_ASSET_ALERT_WEBHOOK_BEARER_TOKEN`，超时由
`MULTI_ASSET_ALERT_TIMEOUT_MS` 控制。warning/critical 会投递，healthy 默认不投递。

```powershell
cd server
npm run multi-asset:monitor
npm run multi-asset:alert-drill -- --level warning
npm run multi-asset:alert-drill -- --level critical

cd ..
./scripts/register-multi-asset-monitor.ps1 -IntervalMinutes 5
```

任务计划名默认为 `QuantBacktest-MultiAsset-Monitor`，运行日志写入
`.codex-runtime/multi-asset-monitor/scheduled-task.log`，最后结果保持
`0=healthy / 1=warning / 2=critical`。
