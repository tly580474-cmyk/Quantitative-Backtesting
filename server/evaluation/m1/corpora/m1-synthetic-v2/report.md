# M1 A/B/C 合成标注集报告

- Run ID: `m1-synthetic-v2`
- Prompt: `m1-synthetic-abc-v1`
- 通过规则：模型 B 与 C 各维度均不低于 4 且无 violations，二者同时通过
- 标注性质：**合成双评审标注集，不等同于人工标注集**
- 模型独立性：**共享模型或供应商，仅实现调用与上下文隔离**
- A: `deepseek-v4-flash`
- B: `deepseek-v4-flash`
- C: `deepseek-v4-flash`

| 类别 | 目标通过数 | 实际通过数 | 淘汰数 |
| --- | ---: | ---: | ---: |
| complete | 70 | 70 | 30 |
| partial | 50 | 50 | 11 |
| short_colloquial | 25 | 25 | 1 |
| conflicting | 25 | 25 | 1 |
| unsupported | 30 | 30 | 5 |

总候选：248；总通过：200；总淘汰：48。

## 双评审质量统计

| 指标 | 数值 |
| --- | ---: |
| B 通过率 | 83.47% |
| C 通过率 | 88.31% |
| B/C 双通过率 | 80.65% |
| B/C 二元结论一致率 | 89.52% |

| 评分维度 | B 均分 | C 均分 |
| --- | ---: | ---: |
| accuracy | 4.31 | 4.38 |
| evidenceGrounding | 4.74 | 4.85 |
| ambiguityHandling | 4.42 | 4.34 |
| capabilityCompliance | 4.94 | 4.96 |
| diversityNaturalness | 4.65 | 4.65 |

> 以上统计衡量合成候选的双模型共识质量，不是被测 M1 解析器的字段级 Precision/Recall。
