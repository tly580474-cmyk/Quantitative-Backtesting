ALTER TABLE strategy_experiment_artifact_jobs
  ADD COLUMN mime_type VARCHAR(128) NULL AFTER artifact_uri,
  ADD COLUMN byte_size BIGINT NULL AFTER mime_type,
  ADD COLUMN checksum VARCHAR(64) NULL AFTER byte_size,
  ADD COLUMN generator_version VARCHAR(64) NULL AFTER checksum,
  ADD COLUMN completed_at VARCHAR(24) NULL AFTER updated_at;

CREATE TABLE IF NOT EXISTS strategy_experiment_report_workers (
  id VARCHAR(96) PRIMARY KEY,
  hostname VARCHAR(255) NOT NULL,
  pid INT NOT NULL,
  status VARCHAR(16) NOT NULL,
  started_at VARCHAR(24) NOT NULL,
  heartbeat_at VARCHAR(24) NOT NULL,
  stopped_at VARCHAR(24) NULL,
  INDEX idx_serw_status_heartbeat (status, heartbeat_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
