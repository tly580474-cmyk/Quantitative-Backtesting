# M4 运维与生产化补强验收记录

> 日期：2026-08-01  
> 范围：M4 v1 已冻结业务能力的生产运行，不扩展策略与资产覆盖范围。

## 1. 结论

**代码与本机集成验收通过；生产现场演练有待在正式进程管理器和备份介质上执行。**

本轮已完成配置集中化、Worker 注册心跳、队列健康分级、管理端状态接口、优雅停机排空、制品完整性校验、终态制品保留策略、分布式锁清理、列表分页和 SSE 生命周期收口。以下事项没有被虚假标记为已完成：

- 正式进程管理器下的多 Worker `SIGTERM` 滚动停机演练；
- 生产备份介质上的数据库、快照、制品三者联合恢复演练；
- 接入企业告警渠道后的通知送达与升级演练。

## 2. 验收证据

| 项目 | 结果 | 证据 |
|---|---|---|
| 数据库迁移 | 通过 | `_migrations` 已记录 `0041_multi_asset_operations.sql` |
| Worker 生命周期 | 通过 | 注册后 `fresh=1`、状态 `healthy`，随后正常标记 `stopped` |
| M4 定向测试 | 通过 | 5 个测试文件，19 个用例 |
| 前端/共享全仓测试 | 通过 | 158 个测试文件，891 个用例 |
| 服务端全仓测试 | 通过 | 102 个测试文件，444 个用例 |
| 服务端类型检查与构建 | 通过 | `tsc --noEmit`、`tsc` |
| 状态采集 | 通过 | `multi-asset:status` 返回 `healthy`，无过期租约 |
| 制品清理预演 | 通过 | dry-run，0 个过期候选，未执行删除 |
| 生产状态机 smoke | 通过 | 取消、重试、死信、完整执行路径；完整运行产生 462 个账本点、2 个制品、7 个事件 |

## 3. 首次失败与闭环

第一次执行生产 smoke 时，完整运行进入 `dead_letter`，错误为
`PYTHON_PLAN_OUTPUT_INVALID:REBALANCE_PLAN_HASH_MISMATCH`，继续诊断后定位到
`FEATURE_HASH_MISMATCH`。根因是 Python 与 ECMAScript 对数值等价的 `1.0/1` 使用不同 JSON
序列化，导致业务结构一致但跨语言传输哈希不一致。

修复方式遵循既定“TypeScript 权威执行平面”：Python 输出先经过严格 Schema 解析，随后由
TypeScript 对 source、universe、feature 和 envelope 的传输哈希统一归一化；成员、证据、目标、
权重约束、时点约束和 Python/DuckDB 决策 parity 仍全部校验。修复后同一生产 smoke 通过。

## 4. 新增故障与生命周期覆盖

- Dispatcher 去重、并发上限、异常后继续消费；
- 停止接单后拒绝新任务；
- 在途任务完成后 drain 成功；
- 宽限期耗尽返回超时但不伪造取消；
- 制品目录穿越与内容篡改被拒绝；
- 清理默认 dry-run，显式 apply 才先删文件后删清单；
- 队列老化、无 Worker、Worker 失联和租约过期告警分级；
- MySQL advisory lock 已有并发互斥与异常释放测试覆盖。

## 5. 上线前剩余人工门禁

1. 使用正式 supervisor 同时启动两个独立 Worker，确认两者心跳和容量均可见；
2. 向其中一个发送 `SIGTERM`，确认状态经历 `draining → stopped` 且任务无丢失；
3. 在任务执行中强制终止另一个 Worker，等待租约过期并确认任务恢复；
4. 复制生产备份到隔离环境，完成 MySQL + snapshot + artifact 联合恢复；
5. 将 `multi-asset:status` 退出码接入监控，验证 warning/critical 通知链路；
6. 审核清理 dry-run 后再安排 `--apply`，不得直接对生产目录手工删除。

操作方法见 [M4 多资产 Agent 生产运维手册](../03-运维监控/MULTI_ASSET_PRODUCTION_RUNBOOK.md)。
