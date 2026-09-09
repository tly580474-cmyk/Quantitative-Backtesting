# Ubuntu 小样本部署验收（2026-09-08）

## 环境和数据

- `root@192.168.171.140`；运行账户 `quant`；目录 `/opt/quant-backtest`。
- Ubuntu 26.04.1 x86_64、Node 22.22.1、Python 3.14.4、MySQL 8.4。
- 独立测试库 `quant_backtest_linux_test`：3 个合成证券、180 条日线、180 条日指标；分钟湖 30 条合成记录。
- 没有读取、导出或迁移 Windows 完整数据库。测试库占用约 9.9 MB（含完整表结构、少量智能体记录），应用数据文件约 308 KB；Python venv 779 MB，虚拟机剩余磁盘约 7.5 GB。

## 验收结果

| 项目 | 结果 |
|---|---|
| Linux 前台、管理台构建和后端类型检查 | 通过 |
| 全部数据库迁移 | 通过，错误列表为空 |
| Linux 后端测试 | 原有及 Provider 测试 538 项通过，新增调度测试 4 项通过，共 542 项；最终适配专项 25 项通过 |
| Windows 仓库回归 | 1123 项通过、1 项跳过；后端单独运行 536 项通过（新增 Linux 专项前） |
| Python 参考数据、分钟、资金流 | 50 + 31 + 4 = 85 项通过 |
| Python 依赖 | pip check 通过；版本保存于 requirements-lock.txt |
| MySQL→研究快照→DuckDB | 180 行，校验通过 |
| 分钟 ZIP→Parquet→DuckDB | 30 行，单证券查询返回 10 行 |
| Python 因子物化 | `(sub close open)` 输出 180 行、180 个有效值 |
| 同源 API | 健康检查、证券列表、快照、分钟目录通过 |
| 少量在线行情 | 000001 quote 接口返回 200 |
| 访问权限 | 网页入口无登录返回 401；管理 API 无 token 拒绝；前台入口禁止访问管理 API |
| 公网开关 | 关闭 8080 后 8081 管理台仍可用，重新开启成功 |
| 后台重启 | 管理 API 请求后，systemd 自动恢复且健康检查通过 |
| 调度配置 | 管理 API 保存时间后，真实 systemd job 读取新配置，无需后端重启；随后恢复原时间 |
| 调度逻辑 | 研究顺序、分钟依赖超时、TCP/在线/本地回退、测试模式禁止抓取通过 |
| Codex | 真实调用、会话续接、取消通过 |
| Claude | Linux Provider 真实调用通过 |
| 智能体端到端 | 两个 Provider 经 nginx 创建任务并完成 SSE 返回和事件持久化；Codex 文本附件上传通过 |
| 子进程清理 | Provider 和工具子进程的 Linux 进程组取消集成测试通过 |
| 备份恢复 | 样本 MySQL + 快照备份成功；临时恢复库 180 条日线和最大日期一致，临时库已清理 |

Claude CLI 一次探针出现会话标题模型 `unrecognized_model` 警告，正文和最终完成状态正常；没有修改 VM 既有 CLI 全局模型配置。

## 留存状态和边界

- `quant-backend`、`quant-public`、`nginx`、`mysql` 正常运行，配置开机启动。
- 四个 timer 已启用，`QUANT_TEST_MODE=true` 阻止自动外部采集；全市场、财务、新闻、龙虎榜、邮件自动任务保持关闭。
- 项目专用 AI/Codex 配置单独迁移，没有复制 Windows 数据库连接、SMTP 等其他凭据。
- 前台 `http://192.168.171.140:8080`，管理台 `http://192.168.171.140:8081`；访问凭据仅存 VM `/root/quant-test-access.txt`（0600）。
- 未迁移旧 FRP 公网隧道、未修改旧域名。内网测试使用 HTTP，公网部署另行设置 TLS。
- 本次不是全市场覆盖、全量性能或长期压力验收；未发送邮件、未重启整台虚拟机。旧 Windows 启动脚本保留。

复现见 [README.md](README.md)。主要脚本为 `smokeLinux.mjs`、`smokeLinuxAgent.mjs`、`smokeLinuxMinute.ts`、`verify-python.py`、`verify-backup.py`、`verify-schedule.py`。VM `/tmp/quant-*.log` 保留运行日志，系统服务日志由 journalctl 查看。
