# Codex Agent Runtime

Codex 是可选 Provider。默认 Provider 保持 `AGENT_PROVIDER=claude`；Codex Provider
可以独立开启或关闭，因此 Codex 安装、登录或运行故障不会影响现有 Claude
智能体以及行情、回测和数据任务。

## 认证隔离原则

- 项目 Harness 只使用 `AGENT_CODEX_API_KEY`，不复用全局 Codex/ChatGPT 登录。
- 不读取、复制或修改 `C:/Users/<you>/.codex/auth.json`。
- `AGENT_CODEX_HOME` 是项目 Harness 的独立状态目录，只保存该 Harness 的 API
  认证状态与 thread 数据；不要指向全局 `.codex`。
- 直连 OpenAI 时，App Server 初始化后通过本地 stdio 调用 `account/login/start`，
  明确指定 `type: apiKey`，随后通过 `account/read` 校验认证类型。
- 使用 OpenRouter 等自定义 Responses Provider 时，按 Codex 官方自定义 Provider
  机制把密钥放入专用的 `CODEX_PROVIDER_API_KEY` 环境变量；该变量只存在于 App
  Server 进程，Shell 环境策略会过滤名称包含 `KEY`、`SECRET` 或 `TOKEN` 的变量。
- API key 不发送给浏览器，也不读取全局 Codex 登录。

## 首次配置

1. 创建一个不位于仓库、用户主目录或磁盘根目录的专用状态目录，例如
   `C:/Users/<you>/AppData/Local/QuantBacktest/codex-home`。
2. 为本项目创建独立的 OpenAI API key，并将它只配置在 `server/.env` 的
   `AGENT_CODEX_API_KEY` 中。不要使用全局 Codex 的 `auth.json`。

3. 在 `server/.env` 设置：

   ```dotenv
   AGENT_PROVIDER=claude
   AGENT_CODEX_ENABLED=true
   AGENT_CODEX_PATH=codex
   AGENT_CODEX_MODEL=
   AGENT_CODEX_WORKING_DIRECTORY=D:/github_public_repo/量化回测
   AGENT_CODEX_HOME=C:/Users/<you>/AppData/Local/QuantBacktest/codex-home
   AGENT_CODEX_API_KEY=<project-specific-api-key>
   AGENT_CODEX_MODEL_PROVIDER=
   AGENT_CODEX_BASE_URL=
   AGENT_CODEX_MODEL_CATALOG=
   AGENT_CODEX_APPROVALS_ENABLED=false
   AGENT_CODEX_APPROVAL_TIMEOUT_SECONDS=300
   AGENT_CODEX_TOOLS_ENABLED=true
   AGENT_CODEX_SANDBOX_MODE=workspace-write
   AGENT_CODEX_WINDOWS_SANDBOX=unelevated
   AGENT_CODEX_NETWORK_ENABLED=true
   AGENT_CODEX_MARKET_DATA_CLI=D:/github_public_repo/量化回测/server/scripts/agentMarketData.mjs
   AGENT_CODEX_EXTERNAL_DATA_SKILL_ENABLED=true
   AGENT_CODEX_PYTHON_PATH=C:/Users/<you>/AppData/Local/QuantBacktest/codex-home/a-stock-data-venv/Scripts/python.exe
   ```

   OpenRouter 隔离探针可额外设置：

   ```dotenv
   AGENT_CODEX_MODEL=stealth/ox-alpha
   AGENT_CODEX_MODEL_PROVIDER=openrouter
   AGENT_CODEX_BASE_URL=https://openrouter.ai/api/v1
   AGENT_CODEX_MODEL_CATALOG=config/codex-openrouter-models.json
   ```

   当前 Ox Alpha 目录启用 Codex 的结构化 `shell_command`，用于对话、续接、取消、
   工作区命令和文件修改 smoke test；OpenRouter Responses 路径不暴露 Codex 的
   `apply_patch` 自定义工具，因此文件修改通过工作区内 Shell 完成。

4. 在 `server` 目录运行连通性探针：

   ```powershell
   npm run agent:codex:probe
   ```

探针输出的 `threadId` 可以作为参数再次运行，以验证跨进程恢复：

```powershell
npm run agent:codex:probe -- <threadId>
```

取消探针会启动一个长 turn，并在 1 秒后通过 `turn/interrupt` 中断：

```powershell
npm run agent:codex:probe -- --cancel
```

## 行情数据与网络边界

- Codex 必须先通过 `server/scripts/agentMarketData.mjs` 查询项目现有行情。该入口只接受
  本机回环地址、只发 GET 请求，并复用现有报价、K 线、分钟湖、研报、七层数据、新闻、
  龙虎榜和研究快照接口，不接触数据库凭据。
- 运行 `node server/scripts/agentMarketData.mjs catalog` 可查看完整命令。K 线命令固定携带
  `localFirst=true&fullHistory=true`，优先使用数据库历史，项目本地为空时才由既有接口降级。
- `a-stock-data` 安装在项目专属 `AGENT_CODEX_HOME/skills`，依赖安装在同目录的独立 venv。
  它仅用于项目接口缺失、为空、不支持或已过期的数据，不替代本地数据。
- `workspace-write` 沙箱允许访问网络，项目本机接口和外部 HTTP/TCP 可自主调用；外部补缺
  仍需在回答中记录数据源、时间点和降级原因，不允许把外部数据直接回写权威数据库或数据湖。
- Ox Alpha 模型目录启用结构化 `shell_command` 并注入 skill 使用说明；文件修改由工作区内
  Shell 完成，因为 OpenRouter Responses 路径未暴露 Codex 的 `apply_patch` 自定义工具。
  常规工作区命令、修改、测试和只读取数不走逐步人工审批。

## 安全与故障边界

- 后端只把系统路径、临时目录、`CODEX_HOME` 和自定义 Provider 必需的专用密钥变量
  传给 App Server；数据库、SMTP、普通 OpenAI API、行情供应商等服务端凭据不会被
  继承。Codex 工具子进程通过 Shell 环境过滤策略排除密钥变量。
- Codex 使用项目根目录的 `workspace-write` 沙箱，允许工作区内自主读写、执行测试和网络取数；
  默认 `approvalPolicy=never`，不为常规步骤生成审批卡片。工作区外写入仍由沙箱阻止。
- Windows 必须显式配置 `AGENT_CODEX_WINDOWS_SANDBOX=unelevated`（或完成官方初始化后使用
  `elevated`）；缺少该配置时，本机 Codex CLI 会把 `workspace-write` 退化为只读。
- 审批基础设施仍保留，可由管理员重新开启；开启后公共 `approvalId` 与 App Server JSON-RPC
  request ID 分离，审批超时、运行取消或服务重启均按拒绝/取消处理。
- 管理台的 “Agent 运维” 页面展示 Provider 健康、CLI 版本、并发、隔离配置、待审批
  数和脱敏后的近期失败分类。配置与密钥页可以维护项目专用 Codex 配置。
- 工作目录必须是存在的 Windows 绝对路径，不能填写 WSL 路径。
- 新对话可以选择 Provider；已有对话固定继承创建时的 Provider。
- `AGENT_CODEX_ENABLED=false` 可立即从产品入口隐藏 Codex，不需要回滚数据库。
- 全局 Codex CLI 的登录、thread、模型配置和使用配额不会被项目 Harness 读取或修改。
