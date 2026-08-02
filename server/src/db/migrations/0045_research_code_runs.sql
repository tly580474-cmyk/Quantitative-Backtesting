-- 阶段 C：受控开放"写代码研究"通道（AGENT_APPLICATION_ALIGNMENT_ASSESSMENT.md 阶段 C）。
-- 用户提交 Python 研究代码 → 强隔离沙箱执行（只读 MySQL + 只读 Parquet 挂载）。
-- 结果恒标记 authority=exploration_only / publishable=0（ADR-05）。
CREATE TABLE IF NOT EXISTS research_code_runs (
  id VARCHAR(36) PRIMARY KEY,
  status VARCHAR(20) NOT NULL,
  request JSON NOT NULL,
  code_hash VARCHAR(64) NOT NULL,
  result JSON NULL,
  result_hash VARCHAR(64) NULL,
  authority VARCHAR(32) NOT NULL DEFAULT 'exploration_only',
  publishable TINYINT(1) NOT NULL DEFAULT 0,
  captured_output MEDIUMTEXT NULL,
  error JSON NULL,
  max_seconds INT NULL,
  created_at VARCHAR(24) NOT NULL,
  completed_at VARCHAR(24) NULL,
  INDEX idx_rcr_status_created (status, created_at),
  INDEX idx_rcr_code_hash (code_hash),
  INDEX idx_rcr_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
