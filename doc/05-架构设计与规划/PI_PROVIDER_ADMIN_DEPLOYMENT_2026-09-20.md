# Pi Provider、管理台更新与上线验收

时间：2026-09-20，正式服务启动于北京时间 13:25:22。服务器：`root@192.168.2.218`，项目：`/opt/quant-backtest`，服务：`quant-backend`。

## 完成范围

- 管理台 Agent 运维页按实际默认 Provider 判断可用性，避免仅以 Codex 配置判定整个服务状态。
- 展示 Pi CLI 版本、模型来源与模型、独立配置目录就绪状态、认证文件可读性、最近 50 次运行中的 Pi 记录。只展示状态，不返回认证内容。配置就绪不等同于认证成功。
- 默认 Provider 使用 Claude / Codex / Pi 下拉选项；Pi 六项配置可通过现有配置接口维护，保存后需重启后端。
- 更新研究智能体及相关前端，包含前序 E01–E11 已完成项；E12 未实施。
- 正式环境启用可选 Pi，保留默认 Claude。Pi 0.85.1，`self-relay / deepseek-v4.1-flash`，独立目录 `/var/lib/quant-backtest/pi-agent`；目录 0700、配置文件 0600，归属 `quant:quant`。
- 正式环境补齐中文绘图字体 `tmp_output/fonts/wqy-microhei.ttc`，沿用已有 Python / Matplotlib 和 Node 依赖。

## 实测

验收脚本：`server/scripts/acceptPiProvider.mjs`。隔离模式仅启动 Agent HTTP 路由，不启动定时任务，不执行全库孤儿任务回收。正式模式连接正在运行的后端。两次均创建新的合成测试会话、附件和报告，保留记录便于追溯。

| 项目 | 隔离环境 | 正式环境 |
| --- | ---: | ---: |
| 附件识别码 + bash 工具调用 | 3.683 秒 | 3.921 秒 |
| 原会话精确续接，回忆附件识别码 | 2.152 秒 | 2.317 秒 |
| 中文折线图 + 绿色宽版 HTML 报告 | 13.314 秒 | 16.157 秒 |
| 取消请求到任务终止 | 42 毫秒 | 40 毫秒 |

两次均通过：Provider 发现、附件绑定、工具事件、SSE 单一终态、记录持久化、相同 session ID 续接、跨 Provider 续接拒绝、Last-Event-ID 重连、报告预览、PNG 内嵌、指定强调色、报告下载、取消及工具子进程终止、无效模型失败退出。取消用例以 canceled 收尾属于预期结果。

这些是单次合成验收耗时，不能据此推断复杂研究任务的平均提速或模型能力差异。

正式环境报告任务：`6df61f4c-915e-4c93-aec8-a68f6292a90a`。完整事件和 HTML 在 `/opt/quant-backtest/tmp_output/pi-acceptance-live-20260920/`；隔离证据在 `/opt/quant-backtest-efficiency-next-20260920/tmp_output/pi-acceptance-predeploy/`。脱敏摘要随本文保存于 `pi_admin_deployment_acceptance_20260920.json`。

自动验证：后端 603 项通过、6 项跳过；管理台目录 15 项通过；Agent 前端 25 项通过。后端类型检查、用户端生产构建、管理台生产构建均通过；保留生产热修复后，服务器类型检查再次通过。

## 发布与兼容性

代码提交：

1. `3d1d562`：管理台 Pi 状态、默认 Provider 下拉及回归测试。
2. `1ea07d7`：真实 Pi HTTP / SSE / 报告 / 续接 / 取消验收脚本；本次发布代码版本。

部署比对发现生产服务器存在本地分支尚未包含的纳斯达克腾讯 / 新浪数据源修复及 15 分钟失败退避。保留 `indexDatasetUpdater.ts`、`indexDatasetScheduler.ts` 和对应生产测试文件，没有以本地旧版本覆盖。其他不相关差异也保留，详见服务器发布 manifest。因此生产是上述发布版本的相关功能文件，加保留的既有热修复，而非整仓逐文件等同于该 Git 提交。

发布更新 64 个相关源码 / 文档文件及两套静态产物。新旧静态哈希资源并存，兼容浏览器尚未刷新的页面。Node 锁文件与生产一致，无需重新安装依赖。未执行建库、数据种子或数据库迁移；未覆盖行情、快照、已有会话和报告。

替换前确认没有活跃 Agent 和外部数据任务，临时暂停原本启用的 4 个数据定时器，发布后全部恢复。`quant-backend` 为 active/running，自动重启次数 0，验收结束活跃 Agent 数为 0。服务端配置的默认 Provider 仍为 `claude`，三个 Provider 均可用。

验证了 3001 与 8081 端口的管理 API Bearer 认证访问、Pi 配置选项、Nginx 用户读取静态文件权限、所有发布源码哈希和保留热修复哈希。

## 验收限制与既有问题

- **未完成浏览器网关登录验收**：`/root/quant-staging-access.txt` 保存的密码与现有 `/etc/nginx/quant.htpasswd` 不匹配，认证返回 401；使用 `htpasswd -vi` 核实不匹配。两个页面网关仍要求认证。此次未更换、重置或绕过现有密码；管理 API 与静态产物检查通过，管理台交互由自动化测试覆盖。
- 发布前已有一条 2026-08-14 的 `dataset-index-incremental` 历史 running 记录，并非实际活跃进程；没有改写该业务记录。财报更新状态在发布前即为“部分失败”，不属于本次 Pi 上线产生的问题。
- Pi 没有操作系统沙箱、MCP 或交互审批；模型运行使用服务账户权限，管理台明确标注能力。

## 回滚

源码、配置、旧前端备份和文件清单：`/opt/quant-backtest/.deploy-backups/20260920-pi-admin/`，目录 0700。配置备份含认证信息，仅由 root 读取，不入库。

已校验备份存在及旧源码哈希；未实际执行回滚，以保留已验收的新服务。

```bash
python3 /opt/quant-backtest/.deploy-backups/20260920-pi-admin/rollback.py --check
# 确需回滚时，在没有活跃研究和数据任务的维护窗口执行：
python3 /opt/quant-backtest/.deploy-backups/20260920-pi-admin/rollback.py --apply
```

回滚脚本恢复本次替换的源码、原配置与静态入口，并恢复先前启用的定时器；保留研究数据、Pi 会话和验收证据。恢复旧配置后 Pi 不再启用。执行前还应检查后台内部数据任务，不能仅依赖历史数据库 running 标记判断。

## 后续复测

以服务账户在服务端目录运行，输出目录必须未被之前验收使用。会消耗少量模型调用并留下 4 次合成任务记录：

```bash
cd /opt/quant-backtest/server
runuser -u quant -- env HOME=/var/lib/quant-backtest \
  node --import tsx scripts/acceptPiProvider.mjs \
  /opt/quant-backtest/tmp_output/pi-acceptance-新的时间戳
```
