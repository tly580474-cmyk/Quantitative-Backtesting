# 独立运维管理台

## 1. 定位

`admin/` 是独立于业务前端的运维管理系统，默认运行在
`http://127.0.0.1:5559`。它复用现有 Fastify 后端，但使用单独的管理 API
和访问令牌，不会出现在量化业务前端的导航中。

当前能力：

- 后端进程运行时间、PID、Node.js 版本和内存状态；
- MySQL 连接、诊断延迟、版本、活动连接和最大连接数；
- DuckDB 活动会话、并发上限和排队数量；
- 研究快照、分钟数据湖、因子报告和因子挖掘运行时目录；
- 研究数据所在磁盘的容量与使用率；
- 行情同步和自动因子挖掘任务状态统计；
- MySQL、研究快照和分钟数据湖的日期血缘对账；
- 日线、估值、复权、分红、行业、指数和分钟数据覆盖率矩阵；
- 按快照识别过期或无效的 DuckDB/Parquet 持久研究结果；
- 常见配置缺失和失败任务诊断；
- 数据库、大模型、行情源和 DuckDB 常用配置维护；
- API Key、Token 和密码脱敏展示。

## 2. 启用管理 API

在 `server/.env` 中设置长随机令牌：

```dotenv
ADMIN_API_TOKEN=replace-with-a-long-random-token
```

留空时，除状态探针外的 `/api/admin/*` 接口全部返回 `503`。修改令牌后必须
重启后端。

建议使用 PowerShell 生成随机令牌：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

## 3. 启动

先启动现有后端：

```powershell
cd server
npm run dev
```

再在仓库根目录启动管理台：

```powershell
npm run admin:dev
```

访问：

```text
http://127.0.0.1:5559
```

管理台令牌只保存在浏览器 `sessionStorage`，关闭当前浏览器会话后失效。

公网访问开关会把管理员最后一次选择持久化到本机运行时目录。后端启动时会主动校正
SSH 隧道和 frpc 计划任务；最后一次选择为“关闭”时，即使任务在重启过程中被其他流程
重新启用，也会再次停止并禁用。首次升级到该机制时以两项计划任务的当前真实状态作为
初始值。

## 4. Windows 开机自启

注册一个登录时触发的计划任务，同时启动后端、业务前端和运维管理台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-autostart.ps1
```

任务名：`QuantBacktest-AutoStart`。脚本幂等，会自动清理历史任务（`QuantBacktestServer`、`QuantBacktest`）和旧的启动文件夹快捷方式。

**运行模式**：
- 后端用 `tsx src/app.ts`（与开发模式一致）
- 前端和管理台用 `vite preview`（服务预构建的 `dist/`），**不走 `vite dev`**

> 为什么不用 `vite dev`？vite 8 的依赖预构建（dep optimization）在自启动场景下不稳定：`ready` 日志出现在预构建完成之前，浏览器在优化期间访问会因 chunk hash 不匹配而 `ERR_ABORTED` 白屏。`vite preview` 服务的是已构建好的静态产物，HTTP 一通页面即可用。

**首次使用 / 代码更新后**需先构建 dist（自启动脚本不会自动重建）：

```powershell
npm run build         # 前端 → dist/
npm run admin:build   # 管理台 → admin/dist/
```

构建产物存在后，自启动脚本会直接用 `vite preview` 启动，秒级就绪。

对应端口：

```text
后端 API     http://127.0.0.1:3001
业务前端     http://127.0.0.1:5558
运维管理台   http://127.0.0.1:5559
```

日志分别写入 `logs/backend.log`、`logs/frontend.log` 和 `logs/admin.log`（每次启动会清空旧日志，只保留本次启动后的内容）。启动脚本会先检查端口，若已被本项目进程占用则跳过启动；若被其他进程占用则发出警告并跳过该服务。

常用命令：

```powershell
# 立即触发一次启动（无需注销重登）
Start-ScheduledTask -TaskName 'QuantBacktest-AutoStart'

# 卸载自启动任务
Unregister-ScheduledTask -TaskName 'QuantBacktest-AutoStart' -Confirm:$false
```

## 5. 生产构建

```powershell
npm run admin:build
npm run admin:preview
```

构建产物位于 `admin/dist/`，与业务前端的 `dist/` 相互独立。

## 6. 配置修改规则

- 管理 API 永远不会返回密钥明文；
- 密钥仅显示“是否已配置”和末四位脱敏值；
- 密钥编辑框始终为空，不会读取现有值，并会阻止浏览器把管理台访问令牌误填为业务密钥；
- 只允许修改代码内声明的白名单配置；
- `ADMIN_API_TOKEN` 只能直接修改 `server/.env`，防止当前会话意外失效；
- 更新写入 `server/.env`，数据库连接、AI Provider 和调度器需要重启后端；
- 每次配置更新会在服务端日志记录被修改的键名，但不会记录配置值。

当前可修改项包括：

- MySQL 地址、端口、用户名、密码和数据库；
- AI 功能开关、API Key、Base URL 和模型；
- 行情数据源 API Key；
- Tushare Token；
- 证券主表自动更新开关与更新时间；
- 财务报表自动更新开关、执行时间和公告回看天数；
- DuckDB 并发与临时空间上限。

## 7. 自动更新进度

管理台“运行总览”每 2 秒刷新以下后台更新项：

- 分钟湖数据；
- 个股日 K 线；
- 财务报表。

财务报表卡片读取 `market_data_collector_runs` 的最新任务，显示来源、成功/失败股票数、
标准化报告数和写入报告数。存在失败股票时，即使已有部分数据写入，卡片仍以警告状态
展示；首次调度前显示“等待财报更新”。开启“跳过非交易时段”后，周末和休市日不会
启动财务更新。

## 8. 数据血缘与覆盖率

管理台“运行总览”展示以下链路：

```text
MySQL 权威最大交易日
  → 当前研究快照 snapshotId / sourceVersion / maxDate
  → 分钟湖 preparedAt / lastDate
```

覆盖率矩阵与 `cd server; npm run data:coverage` 使用同一套检查逻辑。任何数据域出现
`warning` 或 `critical` 时，会同时进入管理台的“优先处理”和“问题诊断”区域。
覆盖结果写入 15 分钟缓存，避免每次刷新管理台都扫描千万级日线表；缓存过期后会自动
重算。

所有 `warning` 和 `critical` 诊断项都必须提供“查看详情”。详情至少包含检查标识和
检测结果；能够取得结构化证据时，还应列出当前值、阈值、影响范围或失败子项。数据覆盖
矩阵会默认展开未通过的数据域，逐项显示覆盖数量、覆盖率、日期区间及通过条件。处理建议
用于说明恢复步骤，不能替代具体失败原因。

持久因子物化结果按 `snapshot=<snapshotId>` 隔离。管理台不会把旧快照结果标记为当前
结果，会单独统计 `stale`、`invalid` 和可回收空间，避免过期物化表被误用。

确认旧物化结果不再使用后，可先预览再归档：

```powershell
cd server
npm run factor:materializations:archive -- --dry-run
npm run factor:materializations:archive
```

归档只把旧 `snapshot=<id>` 目录移出活动 `factor-values`，不会删除文件。

## 9. 安全边界

- CORS 只允许本机 `localhost` 和 `127.0.0.1` 来源；
- 所有受保护接口要求 `Authorization: Bearer <token>`；
- 令牌使用恒定时间比较；
- 不支持读取任意环境变量；
- 不支持写入白名单外的环境变量；
- 管理台不提供任意命令执行、SQL 控制台或文件浏览器。

如果未来需要从其他主机访问，应先增加 HTTPS、反向代理、网络访问控制和更完整的
身份认证，不应直接把当前本地管理端口暴露到公网。
