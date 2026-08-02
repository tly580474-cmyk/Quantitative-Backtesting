CREATE TABLE IF NOT EXISTS strategy_hypotheses (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  status VARCHAR(20) NOT NULL,
  strategy_type VARCHAR(64) NOT NULL,
  params JSON NOT NULL,
  rationale TEXT NOT NULL,
  source_capability_version VARCHAR(64) NOT NULL,
  mapped_experiment_version_id VARCHAR(36) NULL,
  last_run_id VARCHAR(36) NULL,
  validation_status VARCHAR(20) NULL,
  evaluation_summary JSON NULL,
  rejection_reason VARCHAR(1000) NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_sh_status_created (status, created_at),
  INDEX idx_sh_strategy_type (strategy_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
