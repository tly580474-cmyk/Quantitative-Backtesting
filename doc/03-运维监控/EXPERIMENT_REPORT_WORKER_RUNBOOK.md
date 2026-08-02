# M3 实验报告 Worker 运维手册

> 更新日期：2026-08-01  
> 范围：单标的实验报告的 HTML/PDF 异步制品和历史报告中心。

## 1. 进程边界

API 只写入 `strategy_experiment_artifact_jobs`，不在请求线程启动 Chromium。独立
`experiment:report-worker` 以单任务并发领取队列，生成制品并回写 MIME、字节数、
SHA-256、生成器版本和完成时间。PDF 失败不会修改 `strategy_experiment_runs`、权威回测
结果或 M3 门禁状态。

## 2. 启动

```powershell
cd server
npm run db:migrate

# 终端/进程 1：API
npm run start

# 终端/进程 2：独立低优先级报告 Worker
npm run experiment:report-worker
```

生产环境应由 Windows 服务、NSSM、PM2 或同等进程管理器监督 Worker。不要把该命令嵌入
API 进程；每个 Worker 当前串行渲染，扩容前需评估 Chromium 总内存。

## 3. 配置

| 环境变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `EXPERIMENT_REPORT_ARTIFACT_ROOT` | `./.cache/experiment-reports` | 受管制品根目录 |
| `EXPERIMENT_REPORT_CHROMIUM_EXECUTABLE` | 空 | 空时自动探测 Chrome/Edge/Chromium |
| `EXPERIMENT_REPORT_WORKER_POLL_MS` | `1000` | 队列轮询间隔 |
| `EXPERIMENT_REPORT_WORKER_STALE_MS` | `120000` | 运行任务失联恢复阈值 |
| `EXPERIMENT_REPORT_WORKER_MAX_ATTEMPTS` | `3` | 自动尝试上限 |
| `EXPERIMENT_REPORT_RENDER_TIMEOUT_MS` | `60000` | 单次浏览器墙钟限制 |
| `EXPERIMENT_REPORT_HTML_RETENTION_DAYS` | `7` | HTML 保留期 |
| `EXPERIMENT_REPORT_PDF_RETENTION_DAYS` | `30` | PDF 保留期 |

Chromium 使用独立临时 profile、关闭扩展和后台网络、限制 renderer 进程为 1；任务结束会
删除临时 HTML/profile。报告 CSP 禁止外部资源，不允许报告内容发起网络请求。

## 4. 监控与故障处理

```text
GET /api/experiments/report-worker/status
```

响应包含 Worker 心跳新鲜度、queued/running/completed/failed 数量和最老排队时长。回测
结果页的“实验报告中心”也显示 Worker 在线状态、排队数量和每份制品状态。

- Worker 离线：先启动独立进程；queued 任务会继续保留。
- Worker 异常退出：超过 stale 阈值后，新 Worker 将 running 恢复为 queued。
- 达到尝试上限：任务转 failed；修复 Chromium/权限/磁盘后在界面点击“重试 PDF”。
- 队列拥堵：检查最老排队时长并确认没有多个 Chromium 实例泄漏；按容量增加独立 Worker。
- 下载返回 404：制品可能过期或被外部删除，重新生成即可；结构化报告不会被清理。

## 5. 生命周期与验收

```powershell
# 删除过期的可重建 HTML/PDF，不删除结构化报告和门禁记录
npm run experiment:artifacts:prune

# 空库也可运行；临时夹具和 PDF 会在成功后清理
npm run experiment:report-worker:smoke
```

冒烟必须看到独立 Worker PID、任务 `completed`、`application/pdf`、非空字节数、SHA-256
和 `workerObserved: true`。前端构建、后端类型检查和全量测试仍是发布门禁。
