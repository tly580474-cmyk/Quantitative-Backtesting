CREATE TABLE IF NOT EXISTS multi_asset_plan_versions (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'frozen',
  snapshot_id VARCHAR(128) NOT NULL,
  plan_hash VARCHAR(64) NOT NULL,
  plan JSON NOT NULL,
  snapshot_config JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_mapv_hash (plan_hash),
  INDEX idx_mapv_snapshot_created (snapshot_id, created_at),
  INDEX idx_mapv_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS multi_asset_runs (
  id VARCHAR(36) PRIMARY KEY,
  plan_version_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  idempotency_key VARCHAR(128) NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  initial_cash DOUBLE NOT NULL,
  progress JSON NOT NULL,
  rebalance_plan JSON NULL,
  execution_result JSON NULL,
  result_hash VARCHAR(64) NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  created_at VARCHAR(24) NOT NULL,
  started_at VARCHAR(24) NULL,
  completed_at VARCHAR(24) NULL,
  updated_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_mar_idempotency (idempotency_key),
  INDEX idx_mar_plan_created (plan_version_id, created_at),
  INDEX idx_mar_status_created (status, created_at),
  INDEX idx_mar_result_hash (result_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
