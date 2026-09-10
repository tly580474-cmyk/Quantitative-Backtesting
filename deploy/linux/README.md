# Ubuntu Linux 部署与小样本验收

全量数据副本（`192.168.2.218`）使用独立的 [全量部署说明](FULL-DATA-STAGING.md)，不要执行下列样本 seed。

部署目录固定为 `/opt/quant-backtest`。测试主机为 `192.168.171.140`；SSH 使用 root，应用和任务使用独立 `quant` 服务账户。默认只创建 `quant_backtest_linux_test`，不读取、导出或复制 Windows 的数据库。

## 首次安装

目标环境已验证 Ubuntu 26.04 x86_64、Node 22、MySQL 8.4。源代码运行使用 `node --import tsx`，因此后端安装必须保留开发依赖。不要只上传 `dist`：数据库迁移 SQL、Python 工具、研究 CLI 和智能体入口也需要源文件。

在仓库目录打包（只包含源码，排除数据库、行情文件、`.env`、依赖和视频）：

```powershell
python deploy/linux/package.py "$env:TEMP/quant-linux-source.tar.gz"
scp "$env:TEMP/quant-linux-source.tar.gz" root@192.168.171.140:/tmp/
```

在 Ubuntu root 会话中：

```bash
apt-get update
apt-get install -y mysql-server nginx python3-venv build-essential pkg-config apache2-utils sudo
mkdir -p /opt/quant-backtest
tar -xzf /tmp/quant-linux-source.tar.gz -C /opt/quant-backtest
cd /opt/quant-backtest
npm ci
npm --prefix server ci
python3 -m venv .venv
.venv/bin/pip install -r deploy/linux/requirements-lock.txt
npm run build
npm run admin:build
python3 deploy/linux/bootstrap-test.py
cd server
npm run db:migrate
node scripts/seedLinuxTest.mjs
cd ..
bash deploy/linux/install.sh
sudo -u quant sh -c 'cd /opt/quant-backtest/server && npm run snapshot:build && npm run snapshot:verify'
sudo -u quant /opt/quant-backtest/.venv/bin/python deploy/linux/seed-minute.py
```

如果 PyPI 下载不稳定，可为 pip 指定经过信任的镜像。安装完成后使用随验收记录保存的 Python 锁定清单重建同版本环境。`tinyshare` 为可选 SDK，默认安装并使用 `tushare`；如已有 Tinyshare 专用账户与安装来源，单独安装后设置 `MINUTE_TUSHARE_SDK=tinyshare`。这两个数据源的凭据和权限须分别核对，不会自动互换。

Node、Claude 和 Codex CLI 需提前安装到服务账户 PATH 中；本次 VM 已有这些运行时，安装脚本不会覆盖它们。

## 访问和权限

- 前台：`http://192.168.171.140:8080`，需 nginx Basic 登录。
- 管理台：`http://192.168.171.140:8081`，页面 Basic 登录，管理 API 另需 `ADMIN_API_TOKEN`。
- 首次安装生成的访问凭据仅写入 VM `/root/quant-test-access.txt`（0600），通过 SSH 查看。
- API 仅监听 `127.0.0.1:3001`；MySQL 保持本地连接。不要将这两个端口直接发布。
- 公网开关控制独立的 `quant-public.service`，关闭 8080 后，8081 管理入口保留。测试 VM 不配置原 Windows FRP 隧道，也不更改原公网域名。
- root 所有的 `/usr/local/sbin/quant-public-control` 仅允许三个固定动作、一个固定服务；应用没有通用 sudo 权限。
- 本配置面向内网测试。转公网前应为入口配置域名和 TLS，或放在已有 TLS 网关后。

管理台默认同源访问 `/api`；开发和预览服务器也提供 `/api` 代理。生产无需 Vite preview。跨域部署时才需设置 `CORS_ORIGINS`；不建议同时更改 Fastify 的代理信任与智能体回环限制。

## 配置、调度与重启

配置在 `server/.env`，由 `quant` 用户拥有。持久化目录为 `server/data`、`server/.logs`、`server/tmp_output` 和 `/var/lib/quant-backtest`。部署更新只替换源码，保留这些目录及 `.env`，不要重新运行首次 bootstrap。

`quant-backend.service` 使用 `Restart=on-failure`，管理台重启请求以退出码 75 退出后自动拉起。systemd 使用 control-group 清理整个服务进程组。不要启动多个后端实例，否则进程内调度器会重复运行。

四个 `quant-job@*.timer` 每分钟检查北京时间，并由同名 oneshot service 执行业务任务。服务运行期间同一个 systemd unit 不会并发启动。保存调度时间后，下一次检查读取新的 `.env`，无需重启后端或赋予其编辑 systemd 的权限。

```bash
systemctl status quant-backend quant-public
systemctl list-timers 'quant-job@*'
journalctl -u quant-backend -n 100
journalctl -u quant-job@research.service -n 100
```

研究任务保留指数、成分股、行业、分红、快照构建及校验顺序。分钟任务保留退出码 3 的日线依赖等待，以及 TCP→在线→本地文件回退。超过依赖等待期限后不走回退发布。所有自动任务先检查交易日。

`QUANT_TEST_MODE=true` 时四个外部采集任务均不执行，避免全市场下载。测试 `.env` 也关闭进程内全市场自动更新开关。正式使用需分别启用相关功能、配置数据源和交易日历；仅关闭 `QUANT_TEST_MODE` 不会自动打开全部其他开关。

## 智能体

Linux Provider 使用 POSIX 工作目录、HOME、PATH 和进程组。Claude Git Bash 配置仅作用于 Windows。Codex Python 路径使用 `.venv/bin/python`，隔离状态目录使用 `/var/lib/quant-backtest/codex-home`，不复制 Windows 虚拟环境。

首次安装模板禁用 AI。配置项目专用 AI/Codex API key、模型和 Provider 地址后，按需启用 `AI_STRATEGY_ENABLED`、`AGENT_ENABLED`、`AGENT_CODEX_ENABLED`。Claude 使用服务账户可用的 CLI 认证环境；后端不会将数据库、SMTP 等凭据传给它。

```bash
sudo -u quant env HOME=/var/lib/quant-backtest sh -c \
  'cd /opt/quant-backtest/server && npm run agent:codex:probe'
sudo -u quant env HOME=/var/lib/quant-backtest sh -c \
  'cd /opt/quant-backtest/server && npm run agent:claude:probe'
```

真实模型调用可能收费；验收仅使用短探针，不执行全市场研究。邮件发送不属于迁移验收，不向真实收件人发送测试邮件。

## 验收与恢复

合成样本明确命名 `LINUX_TEST_SYNTHETIC_*`：3 个证券，60 个工作日，共 180 条日线；分钟样本为 3 个证券各 10 条，共 30 条。这些不是实际行情，不用于投资或策略结论。样本 seed 仅允许本机指定测试库，重复执行日线 seed 不追加重复记录。

```bash
cd /opt/quant-backtest/server
npm run typecheck
npm test -- --maxWorkers=2
node scripts/smokeLinux.mjs
node scripts/smokeLinuxAgent.mjs  # 已配置 AI 时执行，使用短真实模型调用
```

`smokeLinux.mjs` 会短暂关闭并恢复前台入口、重启后端，需在测试环境运行。脚本作为 root 读取 `/root/quant-test-access.txt`，不会打印凭据。

```bash
sudo -u quant sh -c 'cd /opt/quant-backtest/server && npm run backup:create'
python3 /opt/quant-backtest/deploy/linux/verify-backup.py
```

恢复验收只操作 `quant_backtest_linux_test_restore_check`，若它已存在则停止，避免覆盖其他验收数据；校验成功后清理临时库。备份包含样本 MySQL 和研究快照，不包含原 Windows 数据库。首次部署失败时可修复配置后重启服务；升级回滚应保留 `.env`、数据目录和服务账户状态，再恢复旧源码版本。

原仓库中的历史研究输出、跨仓库因子生成工具与旧 Windows 启动脚本不是 Linux 后台服务；需要重跑历史实验时应显式配置其输入输出路径，不要把旧绝对路径当作可迁移数据。
