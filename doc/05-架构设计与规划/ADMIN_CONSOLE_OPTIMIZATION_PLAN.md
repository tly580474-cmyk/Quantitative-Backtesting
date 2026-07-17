# 运维管理台优化计划（优先级 ①②③⑦）

> 适用范围：`http://127.0.0.1:5559` 独立运维管理台（前端 `admin/` + 后端 `/api/admin/*`）。
> 本计划只覆盖优先级总览中的 **① 服务端 overview TTL 缓存、② health/full 端点拆分、③ 重写近 24h 失败任务查询、⑦ 趋势/sparkline + 告警 + 配置编辑体验**。其余 ④⑤⑥⑧⑨ 已有分析，留待后续计划。
> 约束：不改动现有安全边界（禁用任意命令执行 / SQL 控制台 / 文件浏览器，见 `ADMIN_CONSOLE_GUIDE.md §8`）。

## 0. 背景与目标

- 现状：前端每 15 秒轮询一次 `GET /api/admin/overview`，后端 `collectAdminOverview()`（`server/src/admin/diagnostics.ts:27-92`）并行跑 `inspectDatabase` / `inspectStorage` / `inspectTasks` / `inspectDataGovernance` 外加一次配置枚举；其中**仅覆盖率**有 15 分钟缓存（`loadAdminCoverage`，`:178-185`），其余每次重算。
- 目标：在保持安全边界的前提下，降低高频轮询对后端的压力、消除"看起来正常其实有盲区"的数据问题、补齐趋势与告警能力、改善配置编辑体验。
- 关联代码：`server/src/routes/admin.ts`、`server/src/admin/diagnostics.ts`、`server/src/admin/envConfig.ts`、`server/src/research/duckdbRuntime.ts`、`admin/src/App.tsx`、`admin/src/types.ts`、`admin/src/api.ts`。

---

## 1. 服务端 overview TTL 缓存（①，最高杠杆、最低成本）

### 1.1 现状

- 路由：`server/src/routes/admin.ts:49-59` 的 `GET /api/admin/overview` 每次请求都调用 `collectAdminOverview(options)`，无缓存。
- 采集器：`collectAdminOverview`（`diagnostics.ts:27-92`）并行四路 inspect；仅 `loadAdminCoverage` 有 15min 缓存，其余（DB ping 3 条顺序查询、磁盘 `statfs`、任务查询、物化扫描、配置枚举）每次重算。
- 前端：`admin/src/App.tsx:146-150` 每 15 秒 `setInterval(() => void refresh(true), 15_000)`。

### 1.2 改动方案

新增一个极简内存 TTL 缓存工具（建议 `server/src/admin/overviewCache.ts`）：

- 按 `dbOnline` 分桶（`online` / `offline`），因为 DB 在线/离线时诊断内容完全不同。
- TTL 默认 10s，建议做成可配置项 `ADMIN_OVERVIEW_CACHE_TTL_MS`（默认 `10000`），加在 `server/src/config.ts` 的 `envSchema` 内。
- 命中时直接返回缓存对象；失效时才重算 `collectAdminOverview`，并重算期间允许返回**上一帧成功结果**（stale-while-revalidate），避免重算抖动。
- 缓存只存**成功**结果；`collectAdminOverview` 抛错（路由现有 `catch` → 503）时**不写缓存**，且只有存在上一次成功帧时才返回陈旧帧。
- 触发主动失效（可选）：`PUT /api/admin/config` 成功后、快照发布、调度任务完成钩子里调用 `invalidateOverviewCache()`。

### 1.3 接口/签名

```ts
export interface OverviewCache {
  get(dbOnline: boolean): AdminOverview | null;
  set(dbOnline: boolean, value: AdminOverview): void;
  invalidate(): void;
}
export function createOverviewCache(ttlMs: number): OverviewCache;
```

在 `registerAdminRoutes`（`routes/admin.ts`）的 overview 处理器中套用：

```ts
const overviewCache = createOverviewCache(config.ADMIN_OVERVIEW_CACHE_TTL_MS);
// ...
app.get('/api/admin/overview', { preHandler: authorize }, async (_request, reply) => {
  const cached = overviewCache.get(options.dbOnline);
  if (cached) return reply.send(cached);
  try {
    const overview = await collectAdminOverview(options);
    overviewCache.set(options.dbOnline, overview);
    return reply.send(overview);
  } catch (error) {
    const stale = overviewCache.peek(options.dbOnline); // 仅读不刷新 TTL
    if (stale) return reply.send(stale);
    app.log.error({ err: error }, 'Admin overview collection failed');
    return reply.status(503).send({ error: 'DIAGNOSTICS_FAILED', message: ... });
  }
});
```

### 1.4 验收

- 后端日志/计时：连续 3 次 15s 轮询，overview 处理器耗时从"DB ping + fs + 任务查询"量级降到 <1ms（缓存命中）。
- 数据新鲜度：DB 延迟、磁盘% 等指标在 TTL 内允许最多 10s 延迟（可接受）；超过 TTL 立即反映。
- 覆盖率/物化扫描仍按各自 15min 缓存逻辑，互不冲突。

### 1.5 风险

- 低。注意缓存的是整包对象；若某 inspect 抛错导致整次 collect 失败，缓存层应只缓存成功结果，失败不写缓存，且陈旧帧仅在"有上一次成功帧"时返回。

---

## 2. health / full 端点拆分（②）

### 2.1 现状

- 单端点返回所有内容；前端 15s 轮询必带昂贵分支（任务近 24h 失败查询、物化扫描、存储全扫、配置枚举）。

### 2.2 改动方案

新增 `GET /api/admin/health`（便宜、供高频轮询）：

- 只返回：`service`（pid / uptime / memory / rssBytes）、`database`（status / latencyMs，复用一次轻量 `SELECT VERSION()` 或 `SELECT 1`）、`duckdb`（`getDuckDBRuntimeStats()`）、`overall` 快照、`counts` 快照。
- **不跑** storage 全扫、**不跑** tasks 的近 24h 失败查询、**不跑** materialized 扫描、**不枚举** config。
- 同样走缓存思路（可独立更短 TTL，如 5s），或复用 ① 的 `overviewCache` 的 cheap 分桶。
- 现状 `GET /api/health`（`app.ts:98-102`）与 admin 无关，保留不动；新的 `/api/admin/health` 受 `authorize` 保护。

现有 `GET /api/admin/overview` 保留为"全量"，TTL 拉长到 30–60s，仅在进入页面或手动刷新时拉取。

前端：`admin/src/App.tsx` 的 15s 轮询改调 `/api/admin/health`；overview 标签页首次进入或点"刷新"时才调 `/overview`。`types.ts` 已有 `service` / `database` / `duckdb` / `overall` / `counts` 字段，可直接复用。

### 2.3 接口

```
GET /api/admin/health -> { service, database, duckdb, overall, counts, generatedAt }
GET /api/admin/overview -> (现有全量，TTL 拉长)
```

### 2.4 验收

- 15s 高频轮询只触发 `/health`（毫秒级）；`/overview` 调用频率下降 1–2 个数量级。
- 全量诊断仍可在"运行总览"页手动刷新获得。

### 2.5 风险

- 需同步改前端轮询逻辑与类型，但字段已存在，改动小。

---

## 3. 重写近 24h 失败任务查询（③，真实热点）

### 3.1 现状

`inspectTasks` 的 `recentSyncFailures`（`diagnostics.ts:380-403`）：

```sql
SELECT COUNT(*) AS count
FROM sync_jobs AS failed
WHERE failed.status='failed'
  AND STR_TO_DATE(LEFT(failed.created_at, 19), '%Y-%m-%dT%H:%i:%s')
      >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
  AND NOT EXISTS (
    SELECT 1 FROM sync_jobs AS recovered
    WHERE recovered.status='completed'
      AND recovered.job_type=failed.job_type
      AND recovered.created_at > failed.created_at
      AND JSON_UNQUOTE(JSON_EXTRACT(recovered.request_snapshot, '$.runKey'))
          = JSON_UNQUOTE(JSON_EXTRACT(failed.request_snapshot, '$.runKey'))
  )
```

问题：

- `created_at` 被 `STR_TO_DATE(LEFT(...))` 包裹 → **无法走索引**，每次轮询全表扫描。
- 相关子查询 `NOT EXISTS (... JSON_EXTRACT(request_snapshot,'$.runKey') ...)` 每行重算，且 `JSON_EXTRACT` 比较无法走索引。
- 随 `sync_jobs` 表增长持续恶化；且仅在 DB 在线时每 15s 跑一次。

### 3.2 改动方案（两步走，先 cheap 后 thorough）

**A. 短期（不改表结构）：**

- 若 `created_at` 实际已是规范 ISO DATETIME 文本（`YYYY-MM-DDTHH:MM:SS`），直接比较 `created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR`（MySQL 对规范 DATETIME 文本可直接比较，若该列有索引即可用上），去掉 `STR_TO_DATE(LEFT(...))` 包裹。
- 把 `JSON_EXTRACT` 比较下推到应用层：先 `SELECT job_type, request_snapshot, created_at FROM sync_jobs WHERE status='failed' AND created_at >= ...`，在 JS 侧解析 `runKey` 并做"是否存在更晚的 completed 同 runKey"判定（数据量可控时比相关子查询快）。
- 因子挖掘侧 `recentMiningFailures`（`:396-402`）已用 `created_at >= ...` 规范比较，主要补索引即可（见 B 步）。

**B. 中期（改表，推荐）：**

- `sync_jobs` 增加派生列：
  - `run_key VARCHAR(191)`：从 `request_snapshot->>'$.runKey'` 抽取，写入时维护或用生成列；
  - 可选 `failed_at DATETIME GENERATED ALWAYS AS (CASE WHEN status='failed' THEN created_at END) STORED`。
  - 对 `(status, run_key, created_at)` 建索引。
- 查询简化为：

```sql
SELECT COUNT(*) AS count
FROM sync_jobs f
WHERE f.status='failed'
  AND f.created_at >= UTC_TIMESTAMP() - INTERVAL 24 HOUR
  AND NOT EXISTS (
    SELECT 1 FROM sync_jobs r
    WHERE r.status='completed'
      AND r.run_key = f.run_key
      AND r.created_at > f.created_at
  );
```

此时 `status` / `run_key` / `created_at` 均有索引，`EXISTS` 走索引。
- `factor_mining_tasks` 同理对 `(status, created_at)` 建索引（查询已用规范比较）。

### 3.3 验收

- `EXPLAIN` 显示该查询 `type=range/ref` 且 `rows` 远小于全表；`sync_jobs` 数十万行时单次 <100ms。
- 语义不变：仍是"近 24h 失败且没有被同 runKey 的更晚 completed 恢复"。

### 3.4 风险

- B 步涉及迁移（新增 `migrations/0024_*.sql`），需 backfill 历史行的 `run_key` / `failed_at`；建议在迁移脚本里 `UPDATE` 回填。
- A 步为纯查询改写，零迁移风险，可先行上线观察。

---

## 4. 趋势 / sparkline + 告警 + 配置编辑体验（⑦）

### 4.1 趋势与 sparkline

#### 4.1.1 服务端环形缓冲

新增 `server/src/admin/metricsHistory.ts`：

- 进程内维护最近 1 小时、每 15s 的采样**环形缓冲**（固定容量 240 点）。
- 采样字段：`service.memory.rssBytes` / `heapUsedBytes`、`database.latencyMs`、`duckdb.active` / `queued`、`storage.disk.usedPercent`、tasks 失败计数。
- 由 `collectAdminOverview` 成功时顺带 `push`，或从 `/health` 处理器里采样（避免污染全量）。
- 新增 `GET /api/admin/metrics/history`（可带 `?since=ISO` 参数）返回该缓冲。

#### 4.1.2 前端

- 在 `MetricCard` / 关键 `Panel` 上加**迷你 sparkline**（用轻量内联 SVG，无需引第三方库）。
- "运行总览"顶部增加"最近 1 小时"走势小图（RSS / 堆 / 磁盘% / 队列长度尤其有用）。

### 4.2 主动告警

- 转 `critical` 时：
  - 浏览器 Notification API（需用户授权一次）。
  - 顶部常驻红色横幅（复用现有 `InlineMessage level="critical"`，改为"只要 `overall==='critical'` 就常驻"，而非仅错误时出现）。
- 远期（需先做 `ADMIN_CONSOLE_GUIDE.md §8` 要求的 HTTPS / 反代 / 网络管控）：增加 webhook 投递（`POST` JSON 到可配置 URL），建议作为独立端点 `/api/admin/alerts/webhook` 配置，受同一 Bearer 保护，且**默认关闭**。

### 4.3 配置编辑体验

- **搜索/筛选**：`ConfigurationSection`（`App.tsx`）顶部加搜索框，按 `label` / `key` 过滤（纯前端，不改后端）。
- **按 key 显示"重启影响"**：在 `ADMIN_CONFIG_DEFINITIONS`（`envConfig.ts:15-151`）补充 `restartScope` 字段：
  - `db`（DB_*：需后端全量重启）、`ai`（OPENAI_*：需重启 AI Provider + 后端）、`runtime`（DUCKDB_*：需重启后端）、`market`（行情 key：部分即时、部分重启）。
  - UI 在配置项旁显示对应标签，保存后给出"请重启后端以生效"等**精确**提示（替换当前笼统文案 `ConfigurationSection` 内的警告）。
- **密码字段**：编辑对话框增加"显示/隐藏"切换（仅本地内存，不写回）。
- **校验提示**：对话框内按 `envConfig.validateEnvValue` 的同名规则，在输入时实时给出红字提示（前后端规则保持一致）。

### 4.4 验收

- 趋势：sparkline 随刷新累积，肉眼可见 RSS / 磁盘% 走势。
- 告警：手动制造一个 critical（如临时调低磁盘阈值）→ 出现常驻横幅 + 浏览器通知。
- 配置：搜索可用；保存 `DB_HOST` 后提示"需重启后端"；密码可显隐。

### 4.5 风险

- 环形缓冲是进程内内存，多实例 / 重启会清零（对本机单进程运维台可接受）。
- webhook 属安全敏感，默认关闭且需显式配置，遵循现有安全边界。

---

## 5. 落地顺序建议

1. **① 服务端 overview TTL 缓存**——最低成本、最高杠杆，先做。
2. **② health/full 拆分**——与 ① 共用缓存思路，紧接其后。
3. **③ 近 24h 失败查询**——A 步短期 cheap 修复先行，B 步迁移随后。
4. **⑦ 趋势 + 告警 + 配置体验**——独立模块可并行；sparkline 最先、webhook 最后且默认关。

---

## 6. 不在本次范围

④ 前端配置懒加载 + 静默失败降级 + 轮询可暂停；⑤ inspect 内部并行化 + 物化扫描缓存；⑥ 数据盲点（CPU 死字段、磁盘只看一挂载、配置校验加厚）；⑧ 安全收紧（限流、哈希 token、CORS 收紧）；⑨ 部署一体化。这些已有分析，留待后续计划。
