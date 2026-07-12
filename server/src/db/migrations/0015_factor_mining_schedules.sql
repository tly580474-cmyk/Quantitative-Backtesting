-- Phase 6.5: create a new mining experiment only when a new snapshot is published.

CREATE TABLE IF NOT EXISTS factor_mining_schedules (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  enabled INT NOT NULL DEFAULT 1,
  config JSON NOT NULL,
  total_generations INT NOT NULL,
  last_snapshot_id VARCHAR(128),
  last_task_id VARCHAR(36),
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_fms_enabled_updated (enabled, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
