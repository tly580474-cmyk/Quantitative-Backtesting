# 数据库与研究数据问题汇总

## 1. 文档目的

本文汇总本项目在 MySQL 权威事实层、Parquet 研究快照、DuckDB 查询层、分钟数据湖和
参考数据中已经确认的问题、实际影响、当前状态及建议处理顺序。

本文只讨论数据库、数据治理、查询和导出相关问题。策略本身没有产生正收益、因子效果
不稳定等纯模型问题，只有在其根因与数据覆盖或数据库口径直接相关时才列入。

统计和案例来自 2026-07-16 前后实际运行的以下研究：

- 全市场月度多因子选股；
- 沪深300指数增强与分钟贡献归因；
- 高流动性个股日内动量策略；
- 申万一级行业月度轮动。

相关说明：

- [项目总览](./PROJECT_OVERVIEW.md)
- [DuckDB 与研究快照](./DUCKDB_SNAPSHOT_USAGE.md)
- [DuckDB CLI](./LOCAL_DUCKDB_CLI_GUIDE.md)
- [参考数据](./REFERENCE_DATA_USAGE.md)
- [分钟数据](./MINUTE_DATA_USAGE.md)
- [DuckDB 临时目录与并发治理](./DUCKDB_TEMP_AND_CONCURRENCY_PLAN.md)

## 2. 当前数据架构

```text
在线数据源 / 本地历史文件
          ↓
标准化、去重、复权参数和质量校验
          ↓
MySQL 权威事实层
          ↓
Parquet 不可变研究快照 + current.json
          ↓
DuckDB 只读查询、因子研究和批量导出

独立分钟数据源
          ↓
按交易日 Parquet 分钟湖 + manifest.json
          ↓
DuckDB 显式 read_parquet(...) 查询
```

职责边界：

| 层级 | 职责 | 是否权威 |
| --- | --- | --- |
| MySQL | 数据集、日线、指标、策略、回测结果和参考数据持久化 | 是 |
| Parquet 研究快照 | 固定研究版本、分区扫描和跨截面分析 | 否，只读镜像 |
| DuckDB | 本地查询、聚合、流水线和导出 | 否，只读计算层 |
| 分钟 Parquet 湖 | 1 分钟行情明细和日内研究 | 独立发布数据集 |
| CSV/JSON/HTML 导出 | 静态研究产物 | 否，不自动更新 |

任何数据修正都应发生在上游数据源、MySQL 或快照发布流程中，不应直接修改 DuckDB
临时表、视图或导出的 CSV。

## 3. 问题总览

| 编号 | 问题 | 类型 | 影响 | 优先级 | 状态 |
| --- | --- | --- | --- | --- | --- |
| DB-01 | 指数历史成分权重缺失 | 数据覆盖 | 无法进行长期动态指数回测 | P0 | 已通过官方归档与双锚点验证补齐首批历史截面 |
| DB-02 | 分红历史覆盖不完整，缺失与零值难区分 | 数据语义 | 股息率和红利因子偏差 | P0 | 已完成状态化治理 |
| DB-03 | 复权收益与官方价格指数口径混用 | 口径 | 超额收益结论可能反向 | P0 | 已完成第一版标准化 |
| DB-04 | 行业归属历史仅从 2021-07-30 完整覆盖 | 数据覆盖 | 更早行业中性研究不可用 | P1 | 已增加完整支持边界硬门禁 |
| DB-05 | 新行业指数历史长度不一致 | 数据覆盖 | 滚动动量空值错误参与排序 | P1 | 已按实际窗口覆盖过滤资格 |
| DB-06 | 分钟湖与研究快照彼此独立 | 架构 | 路径、日期和版本难以统一复现 | P1 | 已通过统一门禁、manifest 和后台血缘收口 |
| DB-07 | DuckDB 大结果先进入 Node.js 内存 | 性能 | 百万级导出存在内存和耗时风险 | P0 | 已完成 CSV/Parquet 直接导出 |
| DB-08 | DuckDB 重型任务并发和临时空间风险 | 运维 | CPU、内存、磁盘争用 | P0 | 已完成统一运行时治理 |
| DB-09 | CSV 文件被 Excel 等程序占用时无法覆盖 | 文件系统 | 流水线末端失败 | P2 | 已完成 partial 原子落盘与时间戳改名 |
| DB-10 | 多线程浮点归约导致排序边界不稳定 | 可复现性 | 相同参数可能改变边界股票 | P1 | 已修复案例 |
| DB-11 | SQL 汇总连接可能放大行数 | 查询正确性 | 交易数、股票池数量统计错误 | P1 | 已修复案例 |
| DB-12 | 动态拆分导出能力原本缺失 | CLI 能力 | 无法按股票生成文件 | P2 | 已实现 `splitBy` |
| DB-13 | 持久 DuckDB 物化表不会自动刷新 | 使用风险 | 查询到过期研究结果 | P1 | 已按 snapshot 隔离、检测并归档 |
| DB-14 | 原始 SQL 通配符不受 manifest 发布范围约束 | 一致性 | 可能读入非预期文件 | P1 | 已默认阻断，要求显式授权 |
| DB-15 | MySQL 与快照存在短暂新鲜度差 | 一致性 | 因子研究可能基于旧数据 | P0 | 已纳入统一数据门禁 |
| DB-16 | MySQL 批量导入依赖 `LOCAL INFILE` 配置 | 性能 | 禁用时全量导入显著变慢 | P2 | 已完成预检、强制模式和降级审计 |
| DB-17 | 历史 IndexedDB 与 MySQL 双路径存在分叉风险 | 架构 | 页面和服务端数据不一致 | P1 | 已收口为 MySQL 单一写入，IndexedDB 仅只读迁移 |
| DB-18 | 行业市值加权结果可能高度集中 | 数据使用 | 少数大行业主导组合 | P2 | 已增加行业权重上限与参数门禁 |

## 4. 权威事实层与 MySQL

### 4.1 MySQL 与研究快照存在时间差

MySQL 是权威写入层，DuckDB 查询的是最近一次成功发布的 Parquet 快照。MySQL 完成当日
数据写入后，到 `snapshot:build`、`snapshot:verify` 和 `current.json` 切换完成前，二者
天然存在时间差。

风险：

- 页面查询 MySQL 已经能看到新交易日，但因子研究仍读取旧快照；
- MySQL 历史数据被修订，而快照只追加新日期时，历史分区可能未同步重建；
- 长时间运行的 DuckDB 连接仍保留旧视图定义。

现有控制：

```powershell
npm run snapshot:freshness
npm run snapshot:build
npm run snapshot:verify
```

建议：

1. 所有研究产物记录 `snapshotId`、MySQL `sourceVersion` 和生成时间；
2. `freshness != current` 时禁止正式研究任务启动；
3. 历史修订必须输出受影响年份并触发对应年份重建；
4. 后台管理系统增加 MySQL 最大交易日、快照最大交易日和分钟湖最大交易日对账。

### 4.2 MySQL 不可用时不能静默切换到其他写入源

项目保留 IndexedDB 历史迁移读取能力，但不再允许其成为写入路径。MySQL/API 是唯一
权威可写事实来源；MySQL 不可用时页面明确失败，不会自动降级写入浏览器本地库。

风险：

- 相同数据集在浏览器和 MySQL 中版本不同；
- 策略版本和回测结果引用不同数据；
- 迁移后出现重复数据集或孤立结果。

已落实：

- 默认 `VITE_DATA_SOURCE=api`；
- 只有同时设置 `VITE_DATA_SOURCE=indexeddb` 与
  `VITE_ALLOW_INDEXEDDB_MIGRATION=true` 才能进入迁移模式；
- 迁移模式在 UI 中显式警告，所有仓储新增、修改和删除方法统一拒绝；
- 导出工作簿首张“迁移清单”记录来源、表名、行数、日期范围、记录 ID 数量与样本、
  确定性 checksum；
- 完成导出后恢复 API 模式，并使用覆盖矩阵和自动对账验证 MySQL 目标库。

### 4.3 批量历史导入依赖 MySQL `LOCAL INFILE`

历史全量导入最快路径依赖 `LOAD DATA LOCAL INFILE`。服务端未启用时会降级为批量
`REPLACE`，功能可用但速度明显下降。

建议：

- 正式全量导入环境评估并启用受控 `local_infile`；
- 只允许读取导入器生成的临时目录；
- 导入前后记录主键数量、重复数、最大日期和 checksum；
- 禁止用 `REPLACE` 掩盖来源内部重复，应先在暂存区去重和报告。

### 4.4 数据库连接和恢复能力需要持续验证

后台管理系统已经监测 MySQL 连接、延迟和活动连接，但仍需关注：

- 连接池耗尽；
- 长事务或批量写入阻塞在线查询；
- 备份文件存在但无法恢复；
- 恢复库与 Parquet 快照不一致。

建议定期执行：

```powershell
npm run backup:create
npm run backup:verify -- --path ./data/backups/<backup-id>
npm run backup:restore-check -- --path ./data/backups/<backup-id> `
  --database quant_backtest_restore_check `
  --confirm-drop quant_backtest_restore_check `
  --cleanup true
```

## 5. Parquet 研究快照

### 5.1 快照是不可变读模型，不是第二个可写数据库

常见误区是直接在 DuckDB 中修正视图或创建长期使用的物化表。这会绕过 MySQL 权威层和
快照校验。

正确处理：

- 数据错误：修正 MySQL、采集器或标准化流程；
- 查询逻辑错误：修正 SQL；
- 临时中间结果：使用 DuckDB 临时表；
- 固定研究结果：记录来源 `snapshotId`，但不要冒充权威事实。

### 5.2 旧快照不会自动清理

每次成功发布会产生新的不可变目录。长期运行后会累积大量 Parquet、manifest 和硬链接。

风险：

- 磁盘空间逐步增长；
- 人工清理误删 `current.json` 指向版本；
- 正在运行的研究任务读取到被删除目录。

建议：

- 保留当前版本、最近可回滚版本和重要研究版本；
- 增加快照引用计数或运行任务锁；
- 清理前验证 `current.json`、任务状态和备份；
- 后台管理系统展示各快照大小、创建时间和引用状态。

### 5.3 原始 DuckDB SQL 不读取分钟 manifest

应用层分钟接口会使用 manifest 控制正式发布日期，原始 `read_parquet(...)` 只按路径或
通配符扫描。

风险：

- 通配符范围过宽，扫描不需要的年份和日期；
- 路径错误时查不到文件；
- 未来出现其他正式扩展文件时被意外匹配；
- 查询结果未记录使用了哪些具体文件。

建议：

1. CLI 根据 manifest 解析精确文件列表；
2. 查询产物记录分钟 manifest 的 `preparedAt` 和文件日期；
3. 禁止默认扫描 `year=*/*.parquet`；
4. 只匹配正式 `.parquet`，继续排除 `.partial` 和 `.tdx-partial`。

## 6. DuckDB 查询和导出层

### 6.1 大结果集先进入 Node.js 内存

当前 CLI 使用 DuckDB 完成计算后，通过 `getRowObjectsJson()` 把最终结果全部读入
Node.js，再格式化成 CSV 或 JSON。

实测：

- 沪深300分钟贡献明细为 862,080 行；
- 导出 CSV 约 180MB；
- 更长时间范围或全市场分钟明细会快速接近 Node.js 内存上限。

风险：

- 查询本身在 DuckDB 内可以完成，但 Node.js 在取回结果时内存不足；
- JSON 比 CSV 占用更多内存；
- 分股票拆分需要在 Node.js 中再次分组；
- 大文件被占用时，全部计算完成后仍可能在写盘阶段失败。

建议优先实现：

```sql
COPY (
  SELECT ...
) TO 'output.parquet' (
  FORMAT PARQUET,
  COMPRESSION ZSTD,
  PARTITION_BY (tradeDate)
);
```

以及：

- CSV 流式读取和写入；
- DuckDB `COPY` 直接导出；
- Parquet 分区输出；
- 输出前检测目标文件是否可写；
- 大结果默认拒绝 JSON；
- CLI 增加最大返回行数和预计输出大小提示。

### 6.2 DuckDB 并发和临时空间尚需统一治理

多个 `:memory:` DuckDB 实例同时运行全市场窗口查询时，会竞争 CPU、内存和磁盘临时
空间。相关治理方案已记录在
[DuckDB 临时目录与并发治理计划](./DUCKDB_TEMP_AND_CONCURRENCY_PLAN.md)。

需要落地的重点：

- 每个实例使用独立临时目录；
- 显式设置 `temp_directory` 和 `max_temp_directory_size`；
- 服务进程内共享 FIFO 并发限制；
- 暴露活动任务、等待任务、内存上限和临时目录占用；
- 进程异常退出后安全清理孤立临时目录。

### 6.3 持久 DuckDB 物化表不会自动更新

```sql
CREATE TABLE result AS SELECT ...;
```

创建的是静态副本。Parquet 或 `current.json` 更新后，物化表不会变化。视图会在下次
查询时重新读取路径，但如果数据湖目录移动，视图也会失效。

建议：

- 持久结果表必须记录生成时间、来源快照和刷新命令；
- 默认优先使用视图；
- 对外展示时区分“实时视图”和“固定物化结果”；
- 为物化研究结果增加过期检查。

### 6.4 文件锁导致导出末端失败

Windows 上 CSV 被 Excel 打开后，CLI 无法覆盖该文件。沪深300分钟明细实跑中出现过：
前七个步骤成功，最后一个 180MB 文件因被占用而失败。

建议：

- 输出前先创建临时文件并测试目标目录可写；
- 写入 `<name>.partial`，成功后原子重命名；
- 目标被占用时自动生成带时间戳的新文件名；
- pipeline 报告应区分“计算失败”和“落盘失败”；
- 不应强制关闭用户的 Excel 进程。

### 6.5 动态分文件能力原本缺失

原 pipeline 只能把固定步骤输出到固定文件，不能按结果中的股票代码拆分。日内策略和
全市场收益明细需要生成数百至数千个股票文件。

已实现：

```json
{
  "out": "by-symbol/${symbol}.csv",
  "splitBy": "symbol",
  "format": "csv"
}
```

剩余问题：

- 仍然先把全部结果读入 Node.js；
- 数千个小文件会带来文件系统和备份压力；
- 应支持 Parquet `PARTITION_BY`，并提供文件数量上限。

## 7. 参考数据覆盖与时点问题

### 7.1 沪深300历史动态权重缺失

实测当前快照：

- 沪深300成分日期只有 `2026-06-30` 和 `2026-07-15`；
- 只有 `2026-06-30` 带完整权重；
- `2026-07-15` 只有成员名单，权重为 `NULL`；
- 两个日期的成员名单当时一致。

影响：

- 无法进行多年动态指数增强回测；
- 无法研究历史调入、调出和真实权重变化；
- 只能使用 2026-06-30 权重做 2026 年 7 月月内验证；
- 用当前权重回填历史会产生严重前视偏差。

根因：

当前成分接口不支持任意历史日期，系统只能从功能上线后持续留存批次。

建议：

1. 从官方历史文件回补季度或月度权重；
2. 保存原始文件、来源 URL、校验和、成分日期和权重日期；
3. 成分和权重必须按同一批次关联，不能静默混合；
4. 增加日度漂移权重表作为可重建派生数据；
5. 长期回测开始前检查每个调仓日是否存在有效权重。

### 7.2 分红覆盖不完整

实测快照中分红记录覆盖的证券数少于全市场证券数。没有记录可能表示：

- 股票确实没有分红；
- 尚未完成历史回补；
- 上游接口失败或终态无数据；
- 事件缺少除权日；
- 证券已退市且接口不可用。

如果统一 `COALESCE(..., 0)`，会把“未知”错误解释为“零分红”。

影响：

- 股息率因子偏低；
- 行业加权股息率偏低；
- 高分红策略的截面排名失真；
- 不同月份覆盖率变化会伪装成因子变化。

建议新增状态字段或覆盖表：

| 状态 | 含义 |
| --- | --- |
| `complete` | 目标历史范围已完成 |
| `partial` | 有记录但回补未完成 |
| `no_data` | 上游明确返回无数据 |
| `retryable_error` | 临时失败，可重试 |
| `never_checked` | 尚未处理 |

所有股息率研究应同时导出 `dividendCoverageRatio`。

### 7.3 申万行业归属历史从 2021-07-30 起完整覆盖

影响：

- 更早月份不能做可靠的行业中性因子研究；
- 不能用当前行业归属回填历史；
- 股票行业变更必须按 `effectiveFrom/effectiveTo` 时点连接。

当前处理：

- 全市场行业中性多因子从 2022 年开始；
- 申万行业轮动从 2022-07 开始，保证新增行业具备完整 6 个月行情。

### 7.4 新行业指数历史长度不一致

多数行业指数可追溯到 1999 或 2014 年，但石油石化、环保、美容护理从 2021-12 才开始。
若直接执行 `PERCENT_RANK`，空动量可能因 NULL 排序规则被放到高分位置。

已修复案例：

- 正式轮动起点调整为 2022-07；
- 空动量明确使用中性分数，而不是依赖默认 NULL 排序。

建议：

- 所有滚动指标先输出 `historyCount`；
- 未达到最小窗口时标记 `insufficient_history`；
- 禁止让 NULL 直接参与排名和分层。

## 8. 价格、复权和收益口径

### 8.1 复权不是简单乘法

本项目复权公式为：

```text
adjusted_price = raw_price × factor + priceOffset
```

现金分红可能产生非零 `priceOffset`。只使用 `factor` 会重建错误价格。

要求：

- OHLC 必须同时应用 `factor` 和 `priceOffset`；
- 研究产物记录 `factorVersion`；
- 调仓日停牌时使用最近可用特征，但不能使用未来行情；
- 价格前向填充只能表示停牌持仓价值不变，不能伪造成交。

### 8.2 复权成分收益与官方价格指数不可直接比较

沪深300实跑中：

- 增强组合相对“成分复权收益重建基准”约为正超额；
- 相对官方沪深300价格指数却为负超额。

原因是：

- 股票复权收益更接近总收益口径；
- 官方指数是价格指数口径；
- 指数编制、除数调整和成分权重更新也无法仅靠当前权重完全复现。

建议统一命名：

| 字段 | 口径 |
| --- | --- |
| `constituentTotalReturnBenchmark` | 成分复权收益重建基准 |
| `officialPriceIndexReturn` | 官方价格指数收益 |
| `totalReturnExcess` | 相对复权成分基准超额 |
| `priceIndexTrackingGap` | 与官方价格指数差异 |

不得使用一个含糊的 `benchmarkReturn` 同时表示两种口径。

### 8.3 PE、PB 和市值聚合不能简单平均

问题：

- 负 PE 具有亏损语义，不能改成 0；
- PE/PB 的算术平均容易被极端值扭曲；
- 行业估值应考虑公司规模；
- 市值字段缺失时不能自动补 0。

行业估值实际采用：

```text
行业盈利收益率 = Σ(市值 / PE) / Σ市值
行业隐含 PE   = 1 / 行业盈利收益率

行业账面收益率 = Σ(市值 / PB) / Σ市值
行业隐含 PB   = 1 / 行业账面收益率
```

建议：

- 只对正 PE/PB 样本计算对应指标；
- 同时输出有效样本数和覆盖率；
- 市值加权结果增加单行业/单股票权重上限；
- 不同研究明确使用总市值还是流通市值。

## 9. 分钟数据湖

### 9.1 分钟数据与日线快照是两个独立版本

分钟湖不属于研究快照，默认路径为：

```text
../../所有股票的历史数据/1m_price_parquet
```

影响：

- 日线快照可能更新到某日，而分钟湖仍停留在前一日；
- 研究产物只有 `snapshotId` 仍不足以复现分钟研究；
- CLI SQL 中绝对路径降低可移植性。

建议分钟研究产物同时记录：

- 日线 `snapshotId`；
- 分钟 manifest `preparedAt`；
- 使用的具体日期文件；
- 分钟根目录或数据集 ID；
- 240/241 根时间轴处理规则。

### 9.2 停牌导致分钟覆盖不是固定 300 或固定全市场数量

沪深300分钟归因中，每分钟覆盖 299–300 只成分。拓荆科技等停牌案例说明：

- 日线成分表存在不代表当日有分钟记录；
- 缺失分钟不能直接删除其基准权重；
- 停牌期间贡献应为 0，权重和价格应按明确规则处理。

建议：

- 每个交易日输出预期证券数、实际分钟证券数和停牌证券清单；
- 分钟归因与权重表使用左连接；
- 不用缺失分钟行重新归一化组合权重。

### 9.3 240/241 根历史时间轴差异

旧数据可能包含 09:30 集合竞价分钟，新数据通常为 09:31–15:00 的 240 根。

要求：

- 以时间戳而非固定行号识别分钟；
- 聚合 K 线时明确是否包含 09:30；
- 上午和下午分别编号，不能跨午休聚合；
- 信号持有期使用实际时间差校验，避免 11:xx 的 15 行跨越午休。

## 10. 查询正确性与可复现性

### 10.1 多线程浮点归约会影响边界排序

行业内均值、标准差、分位点和复合得分使用浮点聚合时，多线程执行顺序的微小差异可能
改变第 100 名附近股票。

实际问题：

- 相同参数两次运行，选股池边界曾出现变化；
- 少量股票变化会显著影响短样本累计收益。

已采用：

- 行业内确定性分位排名替代部分 Z-Score；
- 排序增加 `instrumentKey` 等稳定次级键；
- 最终统计按固定精度输出。

建议：

- 关键候选集保存排序键和原始分数；
- 对选股池、汇总文件计算 SHA-256；
- 回归测试执行两次多线程查询并比较候选集；
- 对财务和权重字段考虑 `DECIMAL`，减少二进制浮点噪声。

### 10.2 汇总连接会放大统计

日内策略首轮汇总将每日统计表与逐笔信号表直接连接后再聚合，导致：

- `tradingDays` 被放大为信号行数；
- `totalTrades` 被重复累计；
- 股票池数量被每只股票的多条信号重复计算。

底层信号没有错误，但汇总报告错误。

已修复：

- 每日统计和逐笔统计分别聚合后 `CROSS JOIN`；
- 股票池数量使用 `COUNT(DISTINCT instrumentKey)`；
- 增加重复股票日检查。

通用建议：

- 先确定每张中间表的主键和粒度；
- 汇总 SQL 注释标明 grain，例如 `(tradeDate)`、`(tradeDate, symbol)`；
- 连接后检查行数变化；
- 关键统计增加独立对账查询。

### 10.3 换仓全连接曾遗漏被移出行业

行业轮动首轮换仓表只输出当前入选行业，未保留上一期存在、当期移出的行业，导致换手率
偏低。

已修复：

- 当前组合左连上期组合；
- 另行补充上期存在但当期不存在的记录；
- 明确输出 `ADD`、`REMOVE`、`REWEIGHT`；
- 用 `0.5 × Σ|w_t - w_{t-1}|` 计算单边换手率。

## 11. 文件、目录和配置问题

### 11.1 分钟路径可移植性不足

分钟湖默认位于仓库外部中文绝对路径。示例 SQL 如果硬编码路径，会在其他机器失效。

建议：

- pipeline 只保存 `${MINUTE_DATA_ROOT}` 或逻辑数据集 ID；
- CLI 根据配置和 manifest 生成文件列表；
- 输出报告记录解析后的实际绝对路径，但代码和模板不硬编码；
- Windows 路径传给 DuckDB 时统一转换为正斜杠。

### 11.2 输出目录会积累大量中间结果

复杂测试生成：

- 数千个分股票 CSV；
- 多个 baseline、strict、final 目录；
- 体积较大的分钟明细；
- HTML 报告和预览文件。

建议：

- 区分 `scratch`、`final` 和 `archived`；
- 临时运行使用任务 ID 目录；
- 正式产物包含 manifest、参数和 checksum；
- 提供按任务清理命令，不使用模糊递归删除；
- Git 默认忽略运行结果，只提交示例 SQL 和小型基准文件。

### 11.3 环境变量职责需保持一致

重要配置：

```dotenv
RESEARCH_SNAPSHOT_ROOT=./data/research-snapshots
MINUTE_DATA_ROOT=../../所有股票的历史数据/1m_price_parquet
```

问题是部分早期 DuckDB SQL 示例绕过配置，直接写绝对路径。

建议统一解析顺序：

```text
命令行参数
  → 环境变量
  → config.ts 默认值
```

所有命令在 `--dry-run` 中应输出最终解析的数据集路径和日期文件数量。

## 12. 已修复问题

| 问题 | 修复 |
| --- | --- |
| CLI 只支持简单 SQL | 支持参数化、多语句、pipeline、batch 和 recipe |
| 复杂分钟查询过长且容易被 PowerShell 截断 | 新增 `minute` 快捷命令 |
| 无法按股票动态拆分输出 | pipeline 新增 `splitBy` |
| 分钟聚合跨午休 | 上午、下午分别编号 |
| 09:30 时间轴不一致 | 默认排除集合竞价分钟，可显式包含 |
| 价格导出浮点尾差 | 关键价格和金额使用固定精度 |
| 多线程选股边界不稳定 | 采用确定性分位排名和次级排序键 |
| 日内汇总连接放大 | 分粒度聚合后再合并 |
| 行业换仓遗漏移出项 | 补充上一期独有行业并重算换手 |
| 停牌成分被静默删除 | 使用最近可用特征和价格前向填充，分钟贡献记 0 |
| 基准收益口径含糊 | 分离成分复权基准与官方价格指数 |

## 13. 分级治理清单

### P0：已完成

1. **历史指数成分和权重回补**
   - 没有该数据就不能进行长期指数增强和成分归因。

2. **大结果流式导出**
   - 使用 DuckDB `COPY`、Parquet 分区和流式 CSV，避免 Node.js 全量内存化。

3. **DuckDB 并发与临时空间治理**
   - 落地统一运行时、信号量、独立临时目录和容量上限。

4. **分红覆盖状态化**
   - 区分零分红、未处理、部分覆盖、明确无数据和临时失败。

5. **收益口径标准化**
   - 统一复权、原始价格、总收益和官方指数的字段命名与对账规则。

6. **MySQL—快照—分钟湖三方新鲜度检查**
   - 正式研究开始前必须通过统一门禁。

### P1：已完成

1. query、recipe、minute、pipeline、batch 的正式输出全部生成研究产物 manifest；
2. `npm run data:coverage` 覆盖行情、估值、复权、分红、行业、指数和分钟湖；
3. DuckDB 公共视图统一交易日、复权 ASOF、行业有效期和指数权重有效期；
4. `npm run data:reconcile` 自动检查主键、成员数、权重和、派生权重误差、行业有效期、
   复权发布状态和分红终态覆盖；
5. MySQL/API 成为唯一可写事实源，IndexedDB 仅保留显式只读迁移能力。

### P2：已完成

1. 输出文件占用时自动改名：已完成；
2. 输出目录生命周期管理：已完成 `.partial` 安全清理命令；
3. 小文件合并和 Parquet 分区：已完成压实命令、分区导出和文件数门禁；
4. CLI 输出预计扫描文件、行数和大小：已完成；
5. 持久 DuckDB 物化结果过期提醒：已完成；
6. 后台管理页面增加数据血缘与覆盖率展示：已完成。

## 14. 建议的数据质量门禁

正式研究任务开始前建议统一执行以下检查：

```text
1. MySQL 可连接
2. 日线最终交易日已终态
3. research snapshot freshness = current
4. snapshot verify = passed
5. 分钟 manifest 覆盖目标交易日
6. 参考数据覆盖满足策略要求
7. 复权参数版本已锁定
8. 输出目录可写
9. DuckDB 并发槽位可用
10. 预计扫描量和输出量未超过限制
```

研究完成后检查：

```text
1. 输出行数符合预期
2. 主键重复数为 0
3. 权重合计误差在容忍范围内
4. 空收益和异常收益已报告
5. 分层、分股票、分分钟汇总可对账
6. 结果 manifest 与 SHA-256 已生成
7. 临时文件和临时 DuckDB 目录已清理
```

## 15. 推荐执行路线

```text
第一阶段
  历史指数权重回补
  + 分红覆盖状态化
  + 三方 freshness 门禁

第二阶段
  DuckDB COPY / Parquet 流式导出
  + 并发与临时目录治理
  + 研究产物 manifest

第三阶段
  公共时点连接模板
  + 数据覆盖矩阵
  + 自动对账测试

第四阶段
  IndexedDB 收口
  + 输出目录治理
  + 后台数据血缘与质量面板
```

完成上述工作后，数据库层的主要瓶颈将从“数据缺失和口径不明确”转为可控的性能优化和
研究模型迭代。

## 16. P0 治理进展（2026-07-16）

| P0 项 | 当前状态 | 已落地内容 |
| --- | --- | --- |
| DuckDB 并发与临时空间 | 已完成 | CLI、研究查询、快照、分钟和因子入口统一使用托管运行时；独立临时目录、全局并发槽位和容量上限统一生效 |
| 大结果流式导出 | 已完成单文件与分区导出 | query、minute、recipe、pipeline、batch 的 CSV/Parquet 文件使用 DuckDB `COPY`；pipeline 支持 `partitionBy` 原生 Parquet 分区 |
| 三方 freshness 门禁 | 已完成 | 新增 `npm run data:gate`，统一检查 MySQL/快照、分钟湖、分红、指数成分权重和申万行业 |
| 收益口径标准化 | 已完成第一版 | 新增固定 return-basis 标识，并挂载 `stock_prices_qfq` 与 `official_index_prices`，明确隔离股票前复权收益和官方价格指数收益 |
| 分红覆盖状态化 | 已完成 | 5,825/5,825 只股票均形成明确状态：5,418 只 `completed`、407 只 `no_data`、失败和未尝试均为 0；`no_data` 仍可周期刷新 |
| 历史指数成分权重 | 已完成首批治理 | 从中证官方文件的互联网归档回补完整权重，并在相邻官方锚点之间使用价格漂移生成经误差验证的派生截面；门禁只接受官方权重或双锚点 half-L1 不超过 1.5% 的派生权重 |

真实门禁首次运行结果：

```text
mysql_snapshot      pass
reference_snapshot  pass
minute_lake         pass
dividend_coverage   pass
index_constituents  pass
sw_industry         pass
```

门禁命令：

```powershell
cd server
npm run data:gate
```

该命令返回 JSON；存在硬失败项时进程退出码为 `1`，可直接接入开机任务、调度器或正式
研究任务的前置检查。

历史指数归档导入命令：

```powershell
cd server
npm run index:constituents:archive -- --archive-root D:\authorized-index-archives
```

归档文件名需要包含 6 位指数代码；包含 `closeweight`、`weight` 或“权重”的文件按
权重快照导入，其余按成分快照导入。导入仍执行成员唯一性、权重范围、日期、校验和与
确定性快照 ID 校验，不允许用当前文件伪造历史日期。

互联网档案中的中证官方文件回补命令：

```powershell
cd server
npm run index:constituents:wayback
```

官方锚点之间的月度权重只能在双锚点验证通过后派生：

```powershell
npm run index:constituents:derive -- `
  --index-code 000300 `
  --anchor-date 2024-12-31 `
  --validation-date 2025-05-30 `
  --targets 2025-01-31,2025-02-28
```

派生权重记录 `weightMethod`、锚点快照、验证快照和 `validationHalfL1Pct`；研究快照
同时导出这些字段，不能将派生权重冒充官方文件。

当前统一门禁结果：

```text
status: pass
index constituent snapshots: 24
valid distinct weighted dates: 12
valid weighted snapshots: 18
```

## 17. P1 治理进展

所有输出型 CLI 命令（query、recipe、minute、pipeline、batch）均自动生成研究产物
manifest，记录：

- SQL 文件及内容 SHA-256；
- 合并后的运行参数；
- 日线研究 `snapshotId`、`sourceVersion` 和发布时间；
- 分钟湖 manifest 的 `preparedAt`、日期范围和 SHA-256；
- 每个 CSV、JSON 或 Parquet 输出的行数、字节数和 SHA-256；
- 运行状态及失败原因。

query、recipe、minute 的单文件 manifest 默认写为 `<输出文件>.manifest.json`；
pipeline、batch 和拆分输出默认写入 `--out-dir`。

数据覆盖矩阵：

```powershell
cd server
npm run data:coverage
```

2026-07-16 实际运行 7 项全部通过：日线行情、估值和复权均覆盖 5,486/5,486 个目标，
分红覆盖 5,825/5,825 个证券，申万行业覆盖 5,486/5,486 个目标，6/6 个指数具备成分，
有效权重日期 12 个；分钟湖覆盖 4,014 个交易日并更新至 2026-07-16。

公共时点视图：

- `trading_calendar`：前一/后一交易日；
- `stock_prices_qfq`：按发布日期 ASOF 连接复权参数；
- `sw_industry_current`：当前行业归属；
- `index_membership_snapshots`、`index_constituents_effective`：成分有效期；
- `index_weight_snapshots`、`index_weights_scd`：仅暴露官方或已验证派生权重。

数据库自动对账：

```powershell
cd server
npm run data:reconcile
```

实际运行 9 项全部通过，问题数均为 0：日线/估值主键、指数成员数、权重合计、派生权重
双锚点误差、行业有效期重叠、当前行业唯一性、复权发布状态和分红终态覆盖。

IndexedDB 架构收口：

- 前端默认并强制使用 MySQL/API；
- IndexedDB 必须通过双环境变量显式启用，且仅可读取和导出；
- 所有 IndexedDB 仓储写操作统一抛出只读迁移错误；
- 迁移导出增加“迁移清单”sheet，用于按表核对行数、日期范围、记录 ID 和 checksum。

## 18. P2 治理进展

### 18.1 导出安全与生命周期

- CSV、JSON、Parquet 和研究 manifest 均先写随机 `.partial`，成功后原子重命名；
- 目标存在、被占用或发生并发竞争时保留原文件，自动写入 UTC 时间戳文件；
- `npm run research:artifacts:prune -- --root .\out --partial-hours 24 --dry-run`
  可预览并清理过期半成品，拒绝对文件系统根目录执行；
- pipeline `splitBy`、minute 拆分和 batch 输出受 `--max-output-files` 门禁约束。

真实占用文件测试：

```text
requested: occupied.csv
existing content preserved: true
actual output: occupied-20260716T150552Z.csv
rows: 2
```

### 18.2 小文件与扫描预估

- `npm run parquet:compact` 支持多输入 glob 合并为单个 Parquet；
- 压实输出可继续使用 `--partition-by`；
- CLI 对已知快照视图输出 manifest 候选文件数、行数上界和字节数；
- 分钟查询按目标月份实际枚举 Parquet 文件和字节数。

真实日线查询预估：

```text
scope=bars
files=33
rows=17,085,354
bytes=958 MB
```

### 18.3 持久结果过期检测与后台展示

- 因子物化结果继续按 `snapshot=<snapshotId>` 隔离；
- 后台统计 current、stale、invalid 和 staleBytes，不会把旧快照物化结果显示为当前；
- `factor:materializations:archive` 将旧快照目录安全移出活动区，不直接删除；
- 管理台展示 MySQL 权威日期、当前快照 ID/版本/日期和分钟湖发布时间/日期；
- 后台覆盖率矩阵与 `data:coverage` 共用实现，覆盖七个数据域。

实际治理时归档了 1 个旧快照目录、2 个因子物化结果，共 556,621 字节；归档后活动区
`stale=0`、`invalid=0`。覆盖矩阵使用 15 分钟缓存，后台真实诊断耗时由 35,517ms
降至 15ms。

### 18.4 `LOCAL INFILE` 降级治理

历史行情导入启动时读取 `@@GLOBAL.local_infile`：

- `--require-local-infile`：正式全量导入要求高速路径，不可用时立即失败；
- 默认模式：允许批量 `REPLACE` 降级，并在最终结果记录
  `importMode=local_infile|batched_replace|mixed`；
- `--fallback-batch-rows` 显式控制降级批大小；
- 导入文件仍在进入写入路径前完成代码、日期严格递增、主键重复和 SHA-256 检查。

### 18.5 行业权重集中度约束

行业轮动 pipeline 新增 `maxIndustryWeight`，默认 35%。市值权重通过“等权—原始市值权重”
之间的线性收缩保持总和为 1，同时保证最大行业权重不超过上限。参数低于
`1/topIndustries` 或高于 1 时 SQL 直接阻断。

2026-01 至 2026-03 真实回归：

```text
每月行业数: 5
每月权重合计: 1
每月最大行业权重: 0.35
```

## 19. 阶段完成审计

截至 2026-07-16，问题表中的 P0、P1、P2 均已有代码控制、数据门禁或明确的受支持边界，
不存在仅靠口头约定或待办描述维持的条目。

最终验证证据：

```text
前端 Vitest:              77 files / 453 tests passed
服务端 Vitest:            46 files / 158 tests passed
参考数据 Python unittest: 25 tests passed
分钟数据 Python unittest: 19 tests passed
前端生产构建:             passed
独立后台生产构建:         passed
服务端 TypeScript:        passed
snapshot:verify:           validated / 17,085,354 rows
data:gate:                 6/6 checks passed
data:coverage:             7/7 domains passed
data:reconcile:            9/9 checks passed, issues=0
admin:diagnostics:         healthy / warning=0 / critical=0 / 15ms
```

当前权威日期：

```text
MySQL daily maxDate:       2026-07-16
research snapshot maxDate: 2026-07-16
minute lake lastDate:      2026-07-16
```

后续如果继续开发，应作为新的功能阶段或性能迭代立项；本阶段列出的数据库突出问题不再
以未闭环状态带入下一阶段。
