# Pi Provider 与研究工具运行配置

本次对接的是服务器已安装的 `@earendil-works/pi-coding-agent` 0.85.1，入口 `/usr/local/bin/pi`。接口依据安装包的 `docs/json.md` 和 CLI help 核对。没有新增 npm SDK 依赖。

## 配置

```dotenv
AGENT_PI_ENABLED=true
AGENT_PI_PATH=/usr/local/bin/pi
AGENT_PI_WORKING_DIRECTORY=/opt/quant-backtest
AGENT_PI_AGENT_DIRECTORY=/var/lib/quant-backtest/pi-agent
AGENT_PI_MODEL_PROVIDER=self-relay
AGENT_PI_MODEL=deepseek-v4.1-flash
# 需要设为默认时才修改：
# AGENT_PROVIDER=pi
```

代码默认关闭，不改变原默认 Provider。2026-09-20 正式服务器已启用可选 Pi，默认仍为 Claude；管理台可查看 Pi 版本、模型和认证文件可读状态，并通过下拉选项修改默认 Provider。管理设置支持以上字段；配置应用需要按现有后端部署流程重启。已有对话保持原 Provider，新对话可在前端选择 Pi。

Pi 配置目录应由服务账户独享（目录 0700、认证文件 0600），包含该 Provider 必需的 `auth.json`、`models.json`、`settings.json`，只保留实际使用的认证项。不要把 root HOME 设为服务账户 HOME，不要提交认证文件或在命令行参数里传令牌。`sessions/` 由适配器创建。模型与认证配置遵循已安装 Pi 的格式。

健康状态仅检查启用、可执行文件和目录，不能证明认证或上游在线；上线前必须实际运行一次任务。此次隔离验证使用 `/var/lib/quant-backtest/pi-efficiency-next`，仅保留 `self-relay` 认证项。

## 运行边界

- 使用非交互 JSON 模式；通过标准输入传提示词，串行处理事件，保留真实模型及消息级用量。
- 支持工具事件、最终回答、报告决策、图片 read 输入、精确会话续接、进程组取消，以及编排器的总时限。`maxTurns` 超限会失败收尾。
- 不加载自动发现的扩展、技能、提示模板、主题和项目上下文文件。研究流程由统一提示词提供；没有虚报 skills、MCP、审批、沙箱能力。
- 内置工具限定为 read/bash/edit/write/grep/find/ls。Pi 与现有 Claude 一样没有操作系统级工作区沙箱，依赖服务用户权限及提示词约束；不要把它作为不可信代码的隔离容器。
- 子进程不继承数据库密码等后端环境变量；认证由 Pi 自己从专用目录读取。thinking 内容和原始 agent_end 消息不进入公开事件。
- 上游 API 报错即使进程退出码为 0，也标记运行失败；不把部分文本当作完整成功。

## 中文绘图环境

已实测 Python 3.14.4、Matplotlib 3.11.2 和文泉驿微米黑。运行：

```bash
.venv/bin/python server/scripts/researchPlot.py --help
.venv/bin/python server/scripts/testResearchPlot.py
```

使用现有 `.venv`；缺 Matplotlib 时在该环境中安装并先执行上面的集成测试。字体可以是系统字体，或放置在项目 `tmp_output/fonts/wqy-microhei.ttc`，也可显式传 `--font <路径>`。2026-09-20 上线时已将验证过的字体复制到正式项目的该路径，没有改动系统字体或 Python 依赖。

绘图输入包含 `type,title,source,yLabel`，普通图为 `series:[{label,x:[],y:[]}]`；热力图使用 `matrix,x,y`。支持 line、bar、histogram、heatmap、nav-drawdown、factor-layers。缺失值使用 null，单位写在轴名中。净值图的输入须已完成收益/现金流计算，工具只计算净值的峰值回撤。

输出必须为本任务 `tmp_output/agent-runs/<runId>/` 内 PNG。单次图最多8个序列、每序列5000点；图片不超过2MB。默认不覆盖文件；修正时使用 `--revision correctness`，装饰性改动使用 `--revision decoration`（同一图片最多一次）。产物旁的 `.plot.json` 保存字体、来源与指纹。

## 研究入口与产物

```bash
node server/scripts/researchData.mjs recipes
node server/scripts/researchData.mjs recipe candidate-screen --end 2026-09-17 --top 5 --dry-run
node server/scripts/researchData.mjs recipe candidate-screen --end 2026-09-17 --top 5 --save tmp_output/agent-runs/demo/screen.json
node server/scripts/researchData.mjs recipe factor-layer-14 --start 2026-08-01 --end 2026-09-18
node server/scripts/researchData.mjs reuse --file tmp_output/agent-runs/demo/screen.json
node server/scripts/researchData.mjs recipe pe-dca
```

PE JSON 可附 `strategy:{"highAction":"sell-fraction","sellFraction":0.25}`，在高80%分位的月度执行日卖出当时份额的25%；卖出款留在零息现金账户，后续买入仍是新增外部资金。默认 `half-buy` 在高分位仅投入半份。两策略与固定定投的现金流不同，不能把利润直接当成同本金收益比较；完整语义随结果返回。

数据入口的成功缓存为30秒，有效空结果/不可用结果15秒，确定性错误60秒，瞬时故障15秒，未支持来源300秒。瞬时故障最多自动重试一次；相同参数失败不盲目重试。参数、输入文件、实现指纹、快照指针、工作目录及服务账户目录参与隔离。条件确实变化可加 `--refresh`。缓存最多256项，每项512KB；备用源最多一个是智能体行为约束，不能阻止有 shell 权限的模型绕开统一入口自行调用。

所有统一 query 保存完整结果和 DuckDB manifest，模型只得到最多50行摘要（文件大于8MB时不给行预览）。`--save` 额外记录参数、快照、口径、假设限制、状态与结果路径，不覆盖已有产物。内置快照配方产物最多复用24小时；其他取数最多30秒，且仍须校验快照、输入、结果指纹与当前任务口径。`data-returned` 表示取数成功，不代表研究结论已审计。

产物过期不自动删除文件，便于追溯；部署时应将 `tmp_output/research-results` 和 `tmp_output/agent-runs` 纳入已有研究产物保留策略。不能删除仍被对话或报告引用的文件。最终 HTML 已内嵌图片，不依赖运行目录保留图片。

报告支持四种主题、六位十六进制强调色和宽版布局，由 `agent-report.presentation` 提交；正文组织仍为 Markdown。不开放任意 HTML/CSS。图片只读取本次任务真实路径内的 PNG/JPEG，最多12张、每张2MB、合计6MB，最终 HTML 上限10MB。
