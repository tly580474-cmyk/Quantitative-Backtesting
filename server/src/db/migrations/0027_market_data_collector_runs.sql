CREATE TABLE IF NOT EXISTS market_data_collector_runs (
  run_key VARCHAR(191) PRIMARY KEY,
  job_type VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 1,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  error_message VARCHAR(1000) NULL,
  details JSON NULL,
  INDEX idx_mdcr_job_started (job_type, started_at),
  INDEX idx_mdcr_status_started (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
