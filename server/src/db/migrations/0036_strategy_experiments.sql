CREATE TABLE IF NOT EXISTS strategy_experiments (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  source_text TEXT NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_se_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_versions (
  id VARCHAR(36) PRIMARY KEY,
  experiment_id VARCHAR(36) NOT NULL,
  version INT NOT NULL,
  status VARCHAR(24) NOT NULL,
  spec JSON NOT NULL,
  spec_hash VARCHAR(64) NOT NULL,
  confirmation JSON NOT NULL,
  capability_version VARCHAR(64) NOT NULL,
  compiler_version VARCHAR(64) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_sev_experiment_version (experiment_id, version),
  UNIQUE INDEX idx_sev_spec_hash (spec_hash),
  INDEX idx_sev_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_runs (
  id VARCHAR(36) PRIMARY KEY,
  experiment_version_id VARCHAR(36) NOT NULL,
  status VARCHAR(24) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  input_hash VARCHAR(64) NOT NULL,
  execution_plan JSON NOT NULL,
  backtest_result_id VARCHAR(36) NULL,
  result_hash VARCHAR(64) NULL,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  created_at VARCHAR(24) NOT NULL,
  started_at VARCHAR(24) NULL,
  completed_at VARCHAR(24) NULL,
  UNIQUE INDEX idx_ser_idempotency (idempotency_key),
  INDEX idx_ser_version_created (experiment_version_id, created_at),
  INDEX idx_ser_status_created (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  payload JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_see_run_created (run_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_experiment_validations (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  validation_type VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL,
  details JSON NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_seval_run_type (run_id, validation_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
