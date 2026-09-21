# a-stock-data 技能按需加载

上游技能：[simonlin1212/a-stock-data](https://github.com/simonlin1212/a-stock-data)。
其 `SKILL.md` 包含版本历史、公共 helper、所有数据层代码和调研示例。
本项目提供标准库脚本 `scripts/split-a-stock-data-skill.py`，将安装版本拆成小入口和按需参考文件。
它不下载新版本、不改变接口实现、不更改 Agent 的技能发现配置。

## 本机安装结果（2026-09-20）

| 安装位置 | 保留版本 | 原入口字节数 | 新入口字节数 / 行数 | 参考文件数 |
| --- | --- | ---: | ---: | ---: |
| `~/.claude/skills/a-stock-data` | 3.9.0 | 415,837 | 6,807 / 82 | 33 |
| `~/.pi/agent/skills/a-stock-data` | 3.9.0 | 415,837 | 6,807 / 82 | 33 |
| 本项目 `AGENT_CODEX_HOME/skills/a-stock-data` | 3.7.1 | 208,064 | 6,076 / 76 | 27 |

入口字节数分别减少约 98.4% 和 97.1%；这不是实际 token 用量测量。
技能未触发时通常只暴露名称和描述，触发后读取小入口，再按任务读取数据层与依赖，
因此也缩短了 description。已载入旧内容的对话不会自动缩短，需要新建对话验证新入口。

项目 Pi Provider 使用 `--no-skills`，全局 Pi 安装的技能只影响允许加载技能的 CLI 会话，
不改变项目 Pi 的运行方式。项目 Codex 使用专用 `AGENT_CODEX_HOME`，不是全局 `.codex`。
上述表格记录本机安装，测试服务器部署结果见下一节。

## 测试服务器部署（2026-09-20 23:01，北京时间）

通过 `root@192.168.2.218` 部署，技能由后端运行用户 `quant` 读取：

| 工具 | 技能目录 | 结果 |
| --- | --- | --- |
| Claude | `/var/lib/quant-backtest/.claude/skills/a-stock-data` | 新安装 v3.9.0 拆分版 |
| Codex | `/var/lib/quant-backtest/codex-home/skills/a-stock-data` | 保留 v3.7.1，更新为拆分版 |
| Pi | `/var/lib/quant-backtest/pi-agent/skills/a-stock-data` | 新安装 v3.9.0 拆分版；项目仍使用 `--no-skills` |

后台 24 个发布文件及管理台 3 个构建文件与上一轮验收版本逐一匹配，故保留当前版本，
没有重复替换或重启。同步了 README、本文档和拆分/测试脚本，`server/.env` 摘要保持不变。

- Linux 上 9 项拆分测试通过，三个安装包完整性校验与 `quant` 读取权限检查通过。
- 3001 直连及 8081 Nginx 下 12 个管理接口返回 200；数据库健康，缓存、鉴权和四个定时器检查通过。
- 既有告警保持：1/8 个数据域覆盖不足、8 个研究结果引用旧快照；未修改业务数据。
- 未重跑模型取数或页面登录：服务器保存的网关口令仍不匹配，已验证接口和静态资源读取。
- 本次备份：`/opt/quant-backtest/.deploy-backups/skill-split-20260920T150111Z`。
- 部署清单与验收 JSON：`/opt/quant-skill-split-20260920T150111Z/deployment-result.json`、
  同目录 `live-verification.json`。后台上一轮回滚包继续保留。

## 文件结构与使用

```text
a-stock-data/
  SKILL.md                          # 简短说明、约束、带大小的参考目录
  references/quant-split-<源摘要>/
    00.md                           # 原始元信息、作者、版本记录；一般不读
    01.md ...                       # 路由、公共准备、各数据层、FAQ 等
    manifest.json                   # 原始全文及每个分片的 SHA-256
```

公共 helper 按前置准备的三级标题拆开；业务代码以数据层为边界，保留层内函数关系和示例。
所有原文字节（包括代码、注释、元信息和换行）均保留，可以按 manifest 顺序完整重建原文件。
新入口中的 `version` 和 `origin` 放入标准 `metadata`，旧 frontmatter 完整保留在 `00.md`。
技能名保持 `a-stock-data`。

调用方先读取所需数据层，再读取其市场代码归一化、东财限流或版本专属 helper。
不要扫描全部参考文件、批量执行所有代码块，或将示例当作可直接 import 的模块。
遵循项目本地行情优先、外部只补缺的约束。原文 `docs/...` 链接仍表示上游仓库根目录的文档；
仅安装了单个 SKILL 文件时，可到上游仓库查阅。

## 构建、校验、安装

Python 3.9+，脚本本身没有第三方依赖。在项目根目录运行，替换示例安装路径；
每次构建使用新的输出目录，避免覆盖已有文件：

```powershell
python scripts/split-a-stock-data-skill.py build "C:/Users/<user>/.claude/skills/a-stock-data/SKILL.md" tmp_output/a-stock-data-new
python scripts/split-a-stock-data-skill.py verify tmp_output/a-stock-data-new
python scripts/split-a-stock-data-skill.py install tmp_output/a-stock-data-new "C:/Users/<user>/.claude/skills/a-stock-data" --backup-dir tmp_output/a-stock-data-split-backups
python scripts/split-a-stock-data-skill.py verify "C:/Users/<user>/.claude/skills/a-stock-data"
python scripts/test_split_a_stock_data_skill.py
```

安装器先备份原入口到 `<backup-dir>/<完整源 SHA-256>.original.md`，再复制参考目录，
最后原子替换入口。原有 LICENSE、资产、配置和用户文件保持原样。
目标原文摘要必须匹配构建源，否则拒绝安装；同一包重复安装会校验并跳过。
未知 frontmatter 控制字段、缺少预期章节或未闭合代码围栏会要求先审查上游结构。
构建产物和备份位于忽略的 `tmp_output`，不随代码仓库提交；备份目录不能位于技能目录中。

如需回退，先停止使用该技能的会话，再将备份原文复制回对应 `SKILL.md`。
参考目录可以保留，旧入口不会主动读取它。上游安装器更新可能覆盖小入口；
升级后需从新原文重新生成，不能把已经拆分的入口作为源再次拆分。

验证包括原文逐字节重建、分片摘要、入口链接、安装漂移保护、重复安装、
不同换行格式及 Markdown 围栏边界。它验证文档拆分，不声称重新验证上游所有市场接口可用性。
