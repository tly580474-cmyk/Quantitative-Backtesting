# 2026-08-02 M4 生产运维演练与 M5 进入验收

## 1. 结论

- M4 六项生产运维演练全部在本地生产等价环境跑通；演练中发现并修复 Worker 关闭
  竞态、联合备份遗漏制品、监控任务进程不退出三个问题。
- 项目已进入 M5；完成了快筛运行时评估、权威复算门禁、默认关闭的 Linux/OCI 沙箱
  和供应链基础门禁。
- 本文不宣布 M5 完成。专用生产 Linux 节点、企业 registry/KMS 密钥、正式告警地址
  仍属于部署工作，未部署前不得标记为生产完成。

## 2. M4 六项演练

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| systemd 双 Worker + SIGTERM 滚停 | 通过 | 两个瞬态服务分别 `draining -> stopped`；容量 4；终态任务 52 前后不变；队列 0 |
| MySQL + 快照 + 制品联合恢复 | 通过 | 4,717,725,643 字节 dump；17,147,801 行；31 个快照文件；49 个制品及数据库绑定全部校验 |
| warning/critical 告警投递 | 通过 | 回环 HTTP 接收器两次返回 204；生产实现默认要求 HTTPS |
| 制品清理 dry-run + apply | 通过 | 两次执行均无错误；当前无过期候选，因此删除数为 0 |
| 双 Worker 独立注册/心跳/容量 | 通过 | WSL2 Ubuntu systemd 两个真实 Node Worker 独立注册并正常心跳 |
| 监控采集器接入 | 通过 | Windows 任务 `QuantBacktest-MultiAsset-Monitor` 每 5 分钟执行；实跑结果 0 |

正式备份保留于 `.codex-runtime/m4-drill-backups/m4-prod-drill-20260802`；隔离恢复库和
恢复副本已由 `--cleanup true` 清除。Worker 演练报告位于
`.codex-runtime/m4-production-drill/linux-supervisor.json`，告警报告位于同目录
`alert-delivery.json`。

## 3. 演练中发现并修复的问题

1. Worker 收到 SIGTERM 后，未结束的 heartbeat/poll 可能在连接池关闭后访问数据库。
   现在关闭流程会停止定时器并等待两个 in-flight Promise 收敛后再关闭连接池。
2. 旧备份只覆盖 MySQL 与快照，不能保证制品清单可恢复。manifest 已升级为 v2，并将
   制品路径、大小、哈希和恢复后的数据库绑定纳入验证。
3. systemd 外层 `ProcSubset=pid` 与 Bubblewrap 建立命名空间冲突；改由 Bubblewrap
   提供隔离 `/proc`。seccomp 另补充容器入口必需的 `execve/execveat`。
4. Task Scheduler 的隐藏 PowerShell 承载进程不退出。现改用独立 cmd 启动器和日志
   重定向，任务最终状态为 Ready，`LastTaskResult=0`。
5. 初选 Python 3.12.10 基础镜像存在已修复的 Critical/High 漏洞，扫描门禁拒绝放行；
   换为固定 digest 后重建并扫描到 High/Critical 为 0，再完成签名。

## 4. M5 前置实施状态

### 4.1 VectorBT 仅作快筛

隔离 Python 3.12 环境固定 `vectorbt==1.1.0`。在 2,000 个行情点、200 组均线参数上：

- VectorBT 与 NumPy 参考实现信号哈希 200/200 一致；
- 候选排序完全一致；
- 冷启动耗时约 4.36 秒，NumPy 参考实现约 0.21 秒。

因此 VectorBT 保持 feature flag 默认关闭，只输出 `screening_only` 候选，不输出订单、
现金或可发布绩效。它当前没有性能优势，不替代默认实现和 TypeScript 权威撮合。

### 4.2 权威复算门禁

快筛候选绑定 `candidateId/specHash/datasetHash/signalHash`。TypeScript 复算工作流只有在
四项绑定一致、结果/订单生成确定性哈希且存在 `humanApprovalId` 时才允许进入治理；
任一不一致均生成明确拒绝码。相关单元测试覆盖通过、信号不一致和缺少批准。

### 4.3 任意 Python 默认关闭与沙箱

- 未启用时返回退出码 78 和 `ARBITRARY_PYTHON_DISABLED`；
- systemd + Bubblewrap：动态用户、空宿主目录、无网络、只读系统、内存/PID/CPU/墙钟
  限制；读取 `/etc/passwd` 失败，外网连接为 unreachable，环境仅保留白名单，死循环
  在 3 秒终止；
- OCI：非 root、只读、无网络、capability 全删、seccomp、资源上限；运行前强制验证
  镜像 digest 和 Cosign 签名；
- 所有结果固定 `authority=exploration_only`、`publishable=false`。

### 4.4 依赖、签名与安全审计

- Node lockfile 已更新，`npm audit` 为 0（187 个依赖，High/Critical 均为 0）；
- VectorBT 隔离依赖已写入 `tools/vector-screen/requirements.lock`；
- 基础镜像固定为
  `python@sha256:d50fb7611f86d04a3b0471b46d7557818d88983fc3136726336b2a4c657aa30b`；
- Trivy 0.70.0 发布包先校验 SHA-256 和 Sigstore bundle，再用于扫描；
- 扫描通过的本地演练镜像 digest 为
  `sha256:ceadac4ced2af2516c257549f5fd94d5160f549d38afbce875782069722a1c29`；
- Cosign 公钥 SHA-256 为
  `eedb8eadee95873a0e85e66a09fde03f1ef850432c48a93e964040d4eb39de92`，本地签名与验证通过。

本地私钥和 registry 仅用于演练，不属于生产凭据或正式镜像仓库。

## 5. 自动测试与放行边界

- 服务端最终完整回归通过 110 个测试文件、476 项测试；类型检查与生产构建通过；
- 前端 TypeScript 与 Vite 生产构建通过；Node 依赖审计为 0 漏洞；
- M4 状态机生产冒烟通过，最终队列无等待和过期租约；
- 生产部署前仍需把同一签名/扫描脚本接到 CI，并将 Cosign key 迁移至 KMS/HSM；
- 正式 warning/critical webhook 需由运维提供企业端点后再做一次外部送达演练；
- 专用 Linux Worker 必须在实际服务器按本手册重复沙箱对抗测试。
