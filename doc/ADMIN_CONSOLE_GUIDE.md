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

## 4. Windows 开机自启

现有统一启动任务会同时启动后端、业务前端和运维管理台：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-startup.ps1
```

对应端口：

```text
后端 API     http://127.0.0.1:3001
业务前端     http://127.0.0.1:5558
运维管理台   http://127.0.0.1:5559
```

日志分别写入 `logs/backend.log`、`logs/frontend.log` 和 `logs/admin.log`。
启动脚本会先检查已运行的服务，不会重复创建进程。

## 5. 生产构建

```powershell
npm run admin:build
npm run admin:preview
```

构建产物位于 `admin/dist/`，与业务前端的 `dist/` 相互独立。

## 6. 配置修改规则

- 管理 API 永远不会返回密钥明文；
- 密钥仅显示“是否已配置”和末四位脱敏值；
- 只允许修改代码内声明的白名单配置；
- `ADMIN_API_TOKEN` 只能直接修改 `server/.env`，防止当前会话意外失效；
- 更新写入 `server/.env`，数据库连接、AI Provider 和调度器需要重启后端；
- 每次配置更新会在服务端日志记录被修改的键名，但不会记录配置值。

当前可修改项包括：

- MySQL 地址、端口、用户名、密码和数据库；
- AI 功能开关、API Key、Base URL 和模型；
- 行情数据源 API Key；
- Tushare Token；
- DuckDB 并发与临时空间上限。

## 7. 安全边界

- CORS 只允许本机 `localhost` 和 `127.0.0.1` 来源；
- 所有受保护接口要求 `Authorization: Bearer <token>`；
- 令牌使用恒定时间比较；
- 不支持读取任意环境变量；
- 不支持写入白名单外的环境变量；
- 管理台不提供任意命令执行、SQL 控制台或文件浏览器。

如果未来需要从其他主机访问，应先增加 HTTPS、反向代理、网络访问控制和更完整的
身份认证，不应直接把当前本地管理端口暴露到公网。
