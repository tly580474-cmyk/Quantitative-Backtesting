# M1 A/B/C 合成标注流水线

## 定位

该流水线按以下规则建立可重复的 M1 合成语料：

1. 模型 A 批量生成自然语言输入和候选 Gold 标签；
2. 模型 B、C 在隔离上下文中独立盲审；
3. 两位评审的五项分数都不低于 4，且 `violations` 均为空时，样本才标记为
   `accepted`；
4. 任一评审未通过即进入 `rejected.jsonl`，不得写入通过集；
5. 原始候选、两份评分、模型版本、能力清单版本和通过决策写入 `audit.jsonl`。

它是**合成双评审标注集**，不是人工标注集。项目验收报告必须单独披露标注来源，不能
把它描述为“200 条人工标注语料”。建议后续由人工抽查高风险样本，并将真实用户确认
修改率作为独立线上指标。

## 配置

默认情况下 A/B/C 都复用 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和
`OPENAI_MODEL`。如需真正的异构模型评审，在 `server/.env` 中配置：

```dotenv
M1_MODEL_A=model-a
M1_MODEL_A_BASE_URL=https://provider-a.example/v1
M1_MODEL_A_API_KEY=...

M1_MODEL_B=model-b
M1_MODEL_B_BASE_URL=https://provider-b.example/v1
M1_MODEL_B_API_KEY=...

M1_MODEL_C=model-c
M1_MODEL_C_BASE_URL=https://provider-c.example/v1
M1_MODEL_C_API_KEY=...
```

如果三个角色复用同一模型，程序仍保证调用和上下文隔离，但报告会明确标注为“共享模型
或供应商”，不能声称模型独立。

## 运行

在 `server` 目录中先运行小批量冒烟测试：

```powershell
npm run m1:corpus:smoke
```

正式生成 200 条通过样本：

```powershell
npm run m1:corpus:generate -- --target=200 --batch-size=10 --run-id=m1-acceptance-v1
```

断点续跑时使用相同 `run-id`。程序会读取已有 `audit.jsonl`，仅补足各类别的缺口。

输出目录为：

```text
server/evaluation/m1/runs/<run-id>/
├── manifest.json
├── audit.jsonl
├── accepted.jsonl
├── rejected.jsonl
├── report.json
└── report.md
```

正式验收通过后，将需要版本化的运行复制到 `corpora/<corpus-version>/`。当前正式合成
标注制品为 `corpora/m1-synthetic-v2/`；`runs/` 只用于可恢复的本地执行并被 Git 忽略。

默认 200 条通过集的配额为：

| 类别 | 数量 |
| --- | ---: |
| 完整策略 | 70 |
| 部分缺失、需要澄清 | 50 |
| 极短或口语化输入 | 25 |
| 冲突输入 | 25 |
| 超出能力 | 30 |

## 质量限制

- B/C 只输出分数、违规项和理由，不能直接写 `pass`；最终状态由代码确定。
- 双评审之前先执行确定性门禁：类别与 disposition 必须匹配、完整策略必须同时包含
  买入和卖出条件、事实值不得为空。
- `evidenceQuote` 必须能在用户原文中找到；评审发现证据伪造必须拒绝。
- 缺失业务语义不能通过 assumptions 或默认值回填。
- 能力范围从运行时能力注册表自动注入，不维护第二份人工清单。
- 200 指 200 条唯一且双评审通过的样本，淘汰样本不计入目标数。
- 当前流水线建立的是 Gold 候选与双模型共识，字段级 Precision/Recall 仍需另行对被测
  M1 解析器运行并统计。
