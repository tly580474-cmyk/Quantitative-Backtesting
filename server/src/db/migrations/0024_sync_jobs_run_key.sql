-- 0024_sync_jobs_run_key.sql
-- §3 中期优化：为 sync_jobs 增加派生列 run_key（从 request_snapshot->>'$.runKey' 抽取）
-- 并对 (status, run_key, created_at) 建索引，使近 24h 失败任务恢复判定查询走索引。
--
-- 使用 STORED 生成列，无需修改应用层写入逻辑——MySQL 在 INSERT/UPDATE 时自动计算。
-- 历史行在 ALTER TABLE 时自动回填。

-- 1. 增加生成列 run_key
ALTER TABLE sync_jobs
  ADD COLUMN run_key VARCHAR(191)
  GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(request_snapshot, '$.runKey'))) STORED;

-- 2. 建复合索引，覆盖失败任务恢复判定查询的 WHERE + NOT EXISTS 子查询
CREATE INDEX idx_sj_run_key ON sync_jobs (status, run_key, created_at);

-- 3. factor_mining_tasks 已有 idx_fmt_status_created(status, created_at)，无需额外索引。
