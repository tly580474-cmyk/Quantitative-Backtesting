-- Phase 6.5: offline mining tasks and gated factor candidates.

CREATE TABLE IF NOT EXISTS factor_mining_tasks (
  id VARCHAR(36) PRIMARY KEY,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  snapshot_id VARCHAR(128) NOT NULL,
  config JSON NOT NULL,
  lineage JSON NOT NULL,
  total_generations INT NOT NULL DEFAULT 0,
  completed_generations INT NOT NULL DEFAULT 0,
  artifact_uri VARCHAR(1024),
  error_message VARCHAR(1000),
  created_at VARCHAR(24) NOT NULL,
  started_at VARCHAR(24),
  finished_at VARCHAR(24),
  INDEX idx_fmt_status_created (status, created_at),
  INDEX idx_fmt_snapshot (snapshot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_candidates (
  id VARCHAR(36) PRIMARY KEY,
  task_id VARCHAR(36) NOT NULL,
  name VARCHAR(255) NOT NULL,
  formula VARCHAR(2000) NOT NULL,
  expression JSON NOT NULL,
  direction VARCHAR(24) NOT NULL,
  dependencies JSON NOT NULL,
  warmup_days INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'draft',
  validation_metrics JSON NOT NULL,
  locked_test_metrics JSON,
  source_lineage JSON NOT NULL,
  factor_run_id VARCHAR(36),
  rejection_reason VARCHAR(1000),
  approved_by VARCHAR(128),
  approved_at VARCHAR(24),
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_fc_task_status (task_id, status),
  INDEX idx_fc_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
