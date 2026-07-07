-- Phase 6: factor research metadata

CREATE TABLE IF NOT EXISTS factor_definitions (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at VARCHAR(24) NOT NULL,
  updated_at VARCHAR(24) NOT NULL,
  INDEX idx_fd_status (status),
  INDEX idx_fd_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_versions (
  id VARCHAR(96) PRIMARY KEY,
  factor_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  expression JSON NOT NULL,
  direction VARCHAR(24) NOT NULL,
  dependencies JSON NOT NULL,
  warmup_days INT NOT NULL DEFAULT 0,
  checksum VARCHAR(64) NOT NULL,
  published_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_fv_factor_version (factor_id, version),
  INDEX idx_fv_checksum (checksum)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_runs (
  id VARCHAR(36) PRIMARY KEY,
  factor_version_id VARCHAR(96) NOT NULL,
  snapshot_id VARCHAR(128) NOT NULL,
  universe_id VARCHAR(64) NOT NULL DEFAULT 'builtin-all-a',
  status VARCHAR(16) NOT NULL,
  date_start VARCHAR(10) NOT NULL,
  date_end VARCHAR(10) NOT NULL,
  preprocessing_config JSON NOT NULL,
  label_config JSON NOT NULL,
  run_config JSON NOT NULL,
  total_dates INT NOT NULL DEFAULT 0,
  completed_dates INT NOT NULL DEFAULT 0,
  artifact_uri VARCHAR(1024),
  error_message VARCHAR(1000),
  created_at VARCHAR(24) NOT NULL,
  started_at VARCHAR(24),
  finished_at VARCHAR(24),
  INDEX idx_fr_factor_status (factor_version_id, status),
  INDEX idx_fr_snapshot (snapshot_id),
  INDEX idx_fr_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS factor_reports (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  summary_metrics JSON NOT NULL,
  report_uri VARCHAR(1024) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_frep_run (run_id),
  INDEX idx_frep_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
