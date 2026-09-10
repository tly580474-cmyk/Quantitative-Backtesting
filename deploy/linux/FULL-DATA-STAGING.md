# 全量副本部署与验收

目标主机：`root@192.168.2.218`，程序目录 `/opt/quant-backtest`。此次部署用于复制和验收；Windows 继续作为主机更新数据。正式切换需要另行安排增量同步和任务交接。

## 与小样本部署的区别

- 使用完整 `quant_backtest` 逻辑备份，不运行 `bootstrap-test.py`、样本 seed 或样本恢复脚本。
- `QUANT_TEST_MODE=false`，但 `BACKGROUND_JOBS_ENABLED=false`。该总开关禁止应用采集、模拟交易调度、因子任务恢复和调度；Linux 作业入口同样检查它，安装脚本保持四个更新 timer 停用。
- MySQL `event_scheduler=OFF`，数据库和 API 仅监听回环地址。邮件推送保持关闭。
- MySQL 使用约 1.5 GiB buffer pool；DuckDB 和智能体并发各限制为 1，适配目标机约 7 GiB 内存。

## 复制范围

完整 MySQL 库、2010—2026 年分钟 Parquet、研究快照、因子产物、智能体报告和附件，以及 `tmp_output`、`output`、`server/out`、`server/.logs`、`server/.cache`、`.codex-runtime`。源码通过 `package.py` 打包，Linux 单独安装 Node/Python 依赖，不复制 Windows 二进制虚拟环境。

原始数据库备份及验收证据保存在目标 `/var/lib/quant-migration`。源端数据库备份保存在仓库 `tmp_output/linux-migration-20260909`。

`dumpMigration.mjs` 使用 InnoDB 一致性事务导出，记录导出前后各表精确行数。压缩文件两端 SHA-256 相同后才导入。`verifyMigration.mjs` 在应用启动前核对全部表；导出期间发生更新的表单独记录上下界，不把它们描述为停机时点的全库冻结副本。

`copy-data.py` 按顶层目录分组，通过 SSH 发送文件，完成后写清单；断线重跑会跳过完整且未变化的组。`--groups=year=2018,year=2019` 可限制年份组；并行进程必须使用互不重叠的组。硬链接共享原文件的内容哈希。历史版本清单若遗漏硬链接哈希，可在复制结束后用 `repair-link-manifests.py` 修正，再用 `verify-data.py` 独立读取目标全部文件校验。

## 路径和智能体状态

`remapMigrationPaths.mjs` 仅修改目标数据库中的附件、报告、因子产物和实验报告路径，保留原始 dump。逐项确认源端存在的引用文件在目标也存在；源端已缺失的文件单独列出，避免将其误报为迁移丢失。

Codex 使用应用独立安装的 `0.147.0`，Claude 使用 `2.1.142`，位于 `.agent-cli/node_modules/.bin`，与源端会话版本一致。Codex 隔离目录 `/var/lib/quant-backtest/codex-home`；复制 sessions、skills 和一致性 SQLite 备份，不复制 Windows venv。线程工作目录和 rollout 路径转换到 Linux。

Windows 与 Linux 的 Codex SQLx 迁移校验值不同。先用同版本 Linux CLI 在 `codex-check` 初始化原生空库，再执行 `convert-codex-state.py`：要求规范化后的全部 schema 一致，保留 Linux 迁移元数据，逐表复制并比较所有业务记录，同时校验 SQLite 完整性与外键。转换前的库另行备份，禁止直接篡改迁移校验值。

Claude 仅复制本项目的历史会话到 `.claude/projects/-opt-quant-backtest`。源 Windows 使用 CC Switch 的回环代理，Linux 配置为原机当前 provider 的真实 Anthropic 兼容地址和模型，不能照搬 `127.0.0.1:15721`。凭据通过 SSH 传递，配置文件限制权限，不写入报告。

## 验收命令

应用启动前执行数据库记录数和路径检查；文件哈希校验应在对应传输完成后执行。

```bash
cd /opt/quant-backtest/server
node scripts/verifyMigration.mjs
node scripts/remapMigrationPaths.mjs
npm run typecheck
npx vitest run src/admin/linuxJob.test.ts
npm run snapshot:verify
cd ..
npm run build
npm run admin:build
bash deploy/linux/install.sh
cd server
node scripts/smokeLinuxStaging.mjs
```

完整验收还包括两种智能体的新会话和历史续聊、真实行情单日因子物化、分钟 Parquet 小范围读取、后台重启恢复及所有更新任务保持关闭。验收产物写入 `/var/lib/quant-migration`，不发布新研究快照。

访问凭据保存在 `/root/quant-staging-access.txt`（0600）：前台 8080、管理台 8081。原主机、域名和 FRP 隧道未切换。开始正式切换前，应重新核对源端新增数据库记录、快照及附件，并确保任一时刻只有一台主机运行更新和交易任务。
