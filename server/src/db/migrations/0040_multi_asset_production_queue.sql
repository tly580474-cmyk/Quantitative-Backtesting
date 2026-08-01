ALTER TABLE multi_asset_runs
  MODIFY COLUMN status VARCHAR(24) NOT NULL DEFAULT 'queued',
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 3 AFTER attempt_count,
  ADD COLUMN next_attempt_at VARCHAR(24) NULL AFTER max_attempts,
  ADD COLUMN cancel_requested_at VARCHAR(24) NULL AFTER next_attempt_at,
  ADD COLUMN cancelled_at VARCHAR(24) NULL AFTER cancel_requested_at,
  ADD COLUMN parent_run_id VARCHAR(36) NULL AFTER cancelled_at,
  ADD INDEX idx_mar_queue_ready (status, next_attempt_at, created_at),
  ADD INDEX idx_mar_parent (parent_run_id);

CREATE TABLE IF NOT EXISTS multi_asset_run_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  stage VARCHAR(80) NULL,
  percent INT NULL,
  payload JSON NULL,
  created_at VARCHAR(24) NOT NULL,
  INDEX idx_mare_run_id (run_id, id),
  INDEX idx_mare_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS multi_asset_run_artifacts (
  id VARCHAR(36) PRIMARY KEY,
  run_id VARCHAR(36) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  content_hash VARCHAR(64) NOT NULL,
  storage_uri VARCHAR(1000) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  media_type VARCHAR(120) NOT NULL,
  created_at VARCHAR(24) NOT NULL,
  UNIQUE INDEX idx_mara_run_kind (run_id, kind),
  INDEX idx_mara_hash (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
